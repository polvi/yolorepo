// §4 Verification, identical in the marketplace worker and the renter SDK.
import { b64u, bytesEqual, hex, sha256, utf8 } from "./encoding.ts";
import { computeBinding, gpuNonce, reportData } from "./binding.ts";
import { DOMAINS, ROOTS, peekBlob, verifyBlob, type SignedBlob } from "./signed.ts";
import { AttestationDocSchema, GoldenSetSchema, ModelCatalogSchema, SimulatedReportSchema, type AttestationDoc, type GoldenSet, type ModelCatalog } from "./schemas.ts";
import { describeReport, parseSnpReport, parseTcb, policyBit, tcbAtLeast, SNP_POLICY_BIT_DEBUG, SNP_POLICY_BIT_MIGRATE_MA, type SnpProduct, type SnpReport, type TcbVersion } from "./snp/report.ts";
import { amdRoots, checkVcekAgainstReport, verifyReportSignature, verifyVcekChain, type AmdRoots } from "./snp/chain.ts";
import { checkDeviceClaims, fetchNrasJwks, NRAS_ISSUER, verifyEs384Jwt } from "./gpu/nras.ts";

export interface Check { id: string; ok: boolean; detail: string }
export interface Verdict { status: "verified" | "simulated" | "failed"; checks: Check[]; doc?: AttestationDoc }

export type MinTcb = Partial<Record<SnpProduct, Partial<TcbVersion>>>;

/**
 * Default REPORTED_TCB floors per product line. These are deliberately the lowest values seen in the
 * public test vectors so the vectors verify; deployments raise them (VerifyOptions.minTcb) as AMD
 * publishes fixes. They are a floor, not a recommendation.
 */
export const DEFAULT_MIN_TCB: MinTcb = {
  Milan: { bootLoader: 2, tee: 0, snp: 5, microcode: 68 },
  Genoa: { bootLoader: 10, tee: 0, snp: 23, microcode: 84 },
  Turin: { bootLoader: 9, tee: 0, snp: 11, microcode: 72 },
};

export const FRESHNESS_SKEW_SEC = 10 * 60;

export interface VerifyOptions {
  golden: GoldenSet;
  /** Accept dev-root simulated docs (status "simulated"); default false ⇒ simulated docs fail. */
  allowSimulated?: boolean;
  /** The challenge the caller supplied (32 bytes); when set, doc.challenge must equal it. */
  expectedChallenge?: Uint8Array;
  /** Clock in ms (default Date.now()). */
  now?: number;
  /** NRAS JWKS provider (cache it in production); default fetches NRAS_JWKS_URL with `fetch`. */
  fetchJwks?: () => Promise<JsonWebKey[]>;
  /** Expected `iss` on NRAS JWTs; null disables the issuer check. Default NRAS_ISSUER. */
  nrasIssuer?: string | null;
  minTcb?: MinTcb;
  fetch?: typeof fetch;
  /** Override/extend the GPU hwmodel allowlist (DEFAULT_HWMODEL_ALLOW). */
  hwmodelAllow?: readonly string[];
  /** Optional: when provided, doc.model.digest must be catalogued (simulated docs exempt when catalog.simulated_any). */
  models?: ModelCatalog;
  /** Test hook: alternative AMD roots. */
  amdRoots?: AmdRoots;
}

function goldenFor(golden: GoldenSet, runnerVersion: string, simulated: boolean) {
  return golden.entries.filter((e) => e.runner_version === runnerVersion && !!e.simulated === simulated);
}

export async function verifyAttestationDoc(blob: SignedBlob, opts: VerifyOptions): Promise<Verdict> {
  const checks: Check[] = [];
  const now = opts.now ?? Date.now();
  const push = (id: string, ok: boolean, detail: string) => { checks.push({ id, ok, detail }); return ok; };
  const fail = (doc?: AttestationDoc): Verdict => ({ status: "failed", checks, ...(doc ? { doc } : {}) });

  // 1. doc.sig — self-signed under sign_pub carried in the payload
  const peek = peekBlob<{ sign_pub?: unknown }>(blob);
  if (!peek || typeof peek.sign_pub !== "string") { push("doc.sig", false, "payload unreadable or missing sign_pub"); return fail(); }
  let signPub: Uint8Array;
  try { signPub = b64u.decode(peek.sign_pub); } catch { push("doc.sig", false, "sign_pub is not b64u"); return fail(); }
  if (signPub.length !== 32) { push("doc.sig", false, "sign_pub must be 32 bytes"); return fail(); }
  const raw = await verifyBlob(blob, signPub, DOMAINS.attdoc);
  if (raw === null) { push("doc.sig", false, "Ed25519 signature invalid under sign_pub"); return fail(); }
  const parsed = AttestationDocSchema.safeParse(raw);
  if (!parsed.success) { push("doc.sig", false, `signature ok but payload does not match schema: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`); return fail(); }
  const doc = parsed.data;
  push("doc.sig", true, `Ed25519 ok under sign_pub ${doc.sign_pub}`);

  // 2. doc.binding
  let binding: Uint8Array;
  try {
    binding = await computeBinding({ hpkePub: b64u.decode(doc.hpke_pub), signPub, bootNonce: b64u.decode(doc.boot_nonce), runnerVersion: doc.runner_version, modelDigest: hex.decode(doc.model.digest) });
  } catch (e) { push("doc.binding", false, `cannot compute binding: ${(e as Error).message}`); return fail(doc); }
  if (!push("doc.binding", hex.encode(binding) === doc.binding, hex.encode(binding) === doc.binding ? `binding ${doc.binding}` : `recomputed ${hex.encode(binding)} != doc ${doc.binding}`)) return fail(doc);

  // 3. doc.fresh
  const nowS = Math.floor(now / 1000);
  const age = nowS - doc.issued_at;
  let freshOk = Math.abs(age) <= FRESHNESS_SKEW_SEC;
  let freshDetail = freshOk ? `issued ${age}s ago` : `issued_at ${doc.issued_at} is ${age}s from now (limit ±${FRESHNESS_SKEW_SEC}s)`;
  const challenge = hex.decode(doc.challenge);
  if (opts.expectedChallenge) {
    if (!bytesEqual(challenge, opts.expectedChallenge)) { freshOk = false; freshDetail += `; challenge ${doc.challenge} != expected ${hex.encode(opts.expectedChallenge)}`; }
    else freshDetail += "; challenge matches";
  }
  push("doc.fresh", freshOk, freshDetail);

  // optional: model catalog
  if (opts.models) {
    const entry = opts.models.entries.find((e) => e.digest === doc.model.digest);
    if (entry) push("doc.model", entry.id === doc.model.id, entry.id === doc.model.id ? `model ${doc.model.id} digest catalogued` : `digest belongs to ${entry.id}, doc says ${doc.model.id}`);
    else if (doc.platform.kind === "simulated" && opts.models.simulated_any) push("doc.model", true, "simulated doc; catalog allows any digest (simulated_any)");
    else push("doc.model", false, `model digest ${doc.model.digest} not in catalog`);
  }

  if (doc.platform.kind === "simulated") {
    await verifySimulated(doc, binding, challenge, opts, push);
    const allOk = checks.every((c) => c.ok);
    if (!opts.allowSimulated) push("sim.allowed", false, "simulated docs are not accepted here (allowSimulated is false)");
    return { status: allOk && opts.allowSimulated ? "simulated" : "failed", checks, doc };
  }

  await verifySnp(doc, binding, challenge, now, opts, push);
  await verifyGpu(doc, binding, challenge, now, opts, push);
  return { status: checks.every((c) => c.ok) ? "verified" : "failed", checks, doc };
}

type Push = (id: string, ok: boolean, detail: string) => boolean;

async function verifySimulated(doc: AttestationDoc, binding: Uint8Array, challenge: Uint8Array, opts: VerifyOptions, push: Push) {
  if (!doc.simulated) { push("sim.sig", false, "platform.kind is simulated but no simulated blob present"); return; }
  if (doc.snp || doc.gpu) { push("sim.sig", false, "simulated doc must not carry snp/gpu sections"); return; }
  const inner = await verifyBlob(doc.simulated, ROOTS.DEV_ROOT_PUB, DOMAINS.simulated);
  if (inner === null) { push("sim.sig", false, "simulated blob not signed by the dev root"); return; }
  const sim = SimulatedReportSchema.safeParse(inner);
  if (!sim.success) { push("sim.sig", false, "simulated payload does not match schema"); return; }
  push("sim.sig", true, `dev-root signature ok (kid ${doc.simulated.kid ?? "-"})`);
  const rd = hex.encode(await reportData(binding, challenge));
  push("sim.report_data", sim.data.report_data === rd, sim.data.report_data === rd ? "report_data matches binding+challenge" : `report_data ${sim.data.report_data.slice(0, 16)}… != expected ${rd.slice(0, 16)}…`);
  const gn = hex.encode(await gpuNonce(binding, challenge));
  push("sim.gpu_nonce", sim.data.gpu_nonce === gn, sim.data.gpu_nonce === gn ? "gpu_nonce matches binding+challenge" : `gpu_nonce ${sim.data.gpu_nonce.slice(0, 16)}… != expected ${gn.slice(0, 16)}…`);
  const entries = goldenFor(opts.golden, doc.runner_version, true);
  const hit = entries.find((e) => e.measurement === sim.data.measurement);
  push("sim.measurement", !!hit, hit ? `measurement ∈ golden(${doc.runner_version}, simulated)` : `measurement ${sim.data.measurement.slice(0, 16)}… not in golden simulated entries for ${doc.runner_version} (${entries.length} candidates)`);
}

async function verifySnp(doc: AttestationDoc, binding: Uint8Array, challenge: Uint8Array, now: number, opts: VerifyOptions, push: Push) {
  if (!doc.snp) { push("snp.parse", false, "platform.kind is snp but no snp section"); return; }
  let report: SnpReport;
  try {
    report = parseSnpReport(b64u.decode(doc.snp.report));
  } catch (e) { push("snp.parse", false, (e as Error).message); return; }
  if (!push("snp.parse", report.version >= 2, report.version >= 2 ? describeReport(report) : `unsupported report version ${report.version}`)) return;

  // 5. chain
  const chain = await verifyVcekChain(doc.snp.vcek_chain, now, opts.amdRoots ?? amdRoots());
  const product: SnpProduct | undefined = chain.product;
  if (chain.vcek && product) {
    const x = checkVcekAgainstReport(chain.vcek, report, product);
    push("snp.chain", chain.ok && x.ok, `${chain.detail}; ${x.detail}`);
  } else push("snp.chain", false, chain.detail);

  // 6. signature
  if (chain.vcek) { const s = await verifyReportSignature(chain.vcek, report); push("snp.sig", s.ok, s.detail); }
  else push("snp.sig", false, "no VCEK to verify against");

  // 7. policy
  const dbg = policyBit(report.policy, SNP_POLICY_BIT_DEBUG);
  const mig = policyBit(report.policy, SNP_POLICY_BIT_MIGRATE_MA);
  const polOk = !dbg && !mig && report.vmpl === 0;
  push("snp.policy", polOk, `policy=0x${report.policy.toString(16)} debug=${dbg} migrate_ma=${mig} vmpl=${report.vmpl}`);

  // 8. tcb
  if (product) {
    const tcb = parseTcb(report.reportedTcbRaw, product);
    const floor = (opts.minTcb ?? DEFAULT_MIN_TCB)[product] ?? {};
    const ok = tcbAtLeast(tcb, floor);
    push("snp.tcb", ok, `reported_tcb bl=${tcb.bootLoader} tee=${tcb.tee} snp=${tcb.snp} ucode=${tcb.microcode}${product === "Turin" ? ` fmc=${tcb.fmc}` : ""} ${ok ? "≥" : "<"} floor ${JSON.stringify(floor)} (${product})`);
  } else push("snp.tcb", false, "unknown product line; cannot interpret TCB");

  // 9. measurement
  const entries = goldenFor(opts.golden, doc.runner_version, false);
  const m = hex.encode(report.measurement);
  const hit = entries.find((e) => e.measurement === m);
  push("snp.measurement", !!hit, hit ? `measurement ∈ golden(${doc.runner_version})${hit.note ? `: ${hit.note}` : ""}` : `measurement ${m.slice(0, 16)}… not in golden for ${doc.runner_version} (${entries.length} candidates)`);

  // 10. report_data
  const rd = await reportData(binding, challenge);
  const rdOk = bytesEqual(rd, report.reportData);
  push("snp.report_data", rdOk, rdOk ? "REPORT_DATA == SHA512(\"gpubnb-report-v1\" || binding || challenge)" : `REPORT_DATA ${hex.encode(report.reportData).slice(0, 16)}… != expected ${hex.encode(rd).slice(0, 16)}…`);
}

async function verifyGpu(doc: AttestationDoc, binding: Uint8Array, challenge: Uint8Array, now: number, opts: VerifyOptions, push: Push) {
  if (!doc.gpu) { push("gpu.jwt", false, "platform.kind is snp but no gpu section"); return; }
  let jwks: JsonWebKey[];
  try {
    jwks = await (opts.fetchJwks ? opts.fetchJwks() : fetchNrasJwks(opts.fetch ?? fetch));
  } catch (e) { push("gpu.jwt", false, `cannot load NRAS JWKS: ${(e as Error).message}`); return; }
  const issuer = opts.nrasIssuer === undefined ? NRAS_ISSUER : opts.nrasIssuer;
  const jopts = { now, issuer };
  const overall = await verifyEs384Jwt(doc.gpu.overall, jwks, jopts);
  const deviceNames = Object.keys(doc.gpu.devices);
  const devices: Record<string, Record<string, unknown>> = {};
  const problems: string[] = [];
  if (!overall.ok) problems.push(`overall: ${overall.detail}`);
  if (deviceNames.length === 0) problems.push("no device JWTs");
  for (const name of deviceNames) {
    const r = await verifyEs384Jwt(doc.gpu.devices[name]!, jwks, jopts);
    if (!r.ok) problems.push(`${name}: ${r.detail}`);
    else devices[name] = r.claims!;
  }
  // Detached-EAT binding: overall.submods[name] = ["DIGEST", ["SHA-256", hex(sha256(deviceJwtAscii))]]
  if (overall.ok && overall.claims) {
    const submods = overall.claims.submods as Record<string, unknown> | undefined;
    if (submods && typeof submods === "object") {
      for (const name of deviceNames) {
        const entry = submods[name] as unknown;
        const digestHex = Array.isArray(entry) && entry[0] === "DIGEST" && Array.isArray(entry[1]) ? String(entry[1][1]).toLowerCase() : undefined;
        if (!digestHex) { problems.push(`${name}: overall.submods has no digest for it`); continue; }
        const got = hex.encode(await sha256(utf8(doc.gpu.devices[name]!)));
        if (got !== digestHex) problems.push(`${name}: device JWT digest ${got.slice(0, 16)}… != overall.submods ${digestHex.slice(0, 16)}…`);
      }
      for (const name of Object.keys(submods)) if (!(name in doc.gpu.devices)) problems.push(`overall.submods lists ${name} but no device JWT carried`);
    } else problems.push("overall JWT has no submods (not a detached EAT bundle)");
  }
  if (!push("gpu.jwt", problems.length === 0, problems.length ? problems.join("; ") : `overall + ${deviceNames.length} device JWT(s) ES384 ok, iss=${issuer ?? "any"}, submods digests match, exp honored`)) return;

  // 12. nonce
  const gn = hex.encode(await gpuNonce(binding, challenge));
  const nonceProblems: string[] = [];
  const overallNonce = overall.claims?.eat_nonce;
  if (typeof overallNonce === "string" && overallNonce.toLowerCase() !== gn) nonceProblems.push(`overall eat_nonce ${overallNonce.slice(0, 16)}… != ${gn.slice(0, 16)}…`);
  for (const [name, c] of Object.entries(devices)) {
    const n = c.eat_nonce;
    if (typeof n !== "string") nonceProblems.push(`${name}: no eat_nonce`);
    else if (n.toLowerCase() !== gn) nonceProblems.push(`${name}: eat_nonce ${n.slice(0, 16)}… != ${gn.slice(0, 16)}…`);
  }
  push("gpu.nonce", nonceProblems.length === 0, nonceProblems.length ? nonceProblems.join("; ") : `eat_nonce == SHA256("gpubnb-gpu-v1" || binding || challenge)`);

  // 13. claims
  const claimProblems: string[] = [];
  if (overall.claims?.["x-nvidia-overall-att-result"] !== true) claimProblems.push(`overall x-nvidia-overall-att-result=${JSON.stringify(overall.claims?.["x-nvidia-overall-att-result"])}`);
  const okDetails: string[] = [];
  for (const [name, c] of Object.entries(devices)) {
    const r = checkDeviceClaims(name, c, opts.hwmodelAllow);
    if (!r.ok) claimProblems.push(r.detail); else okDetails.push(r.detail);
  }
  push("gpu.claims", claimProblems.length === 0, claimProblems.length ? claimProblems.join("; ") : `overall result true; ${okDetails.join("; ")}`);
}

/** Golden set signed by the pinned offline root. Throws on a bad signature or schema. */
export async function verifyGolden(blob: SignedBlob): Promise<GoldenSet> {
  if (blob.kid !== undefined && blob.kid !== ROOTS.OFFLINE_ROOT_KID) throw new Error(`golden: unexpected kid ${blob.kid}`);
  const raw = await verifyBlob(blob, ROOTS.OFFLINE_ROOT_PUB, DOMAINS.golden);
  if (raw === null) throw new Error("golden: signature invalid under the pinned offline root");
  return GoldenSetSchema.parse(raw);
}

/** Model catalog signed by the pinned offline root. Throws on a bad signature or schema. */
export async function verifyModels(blob: SignedBlob): Promise<ModelCatalog> {
  if (blob.kid !== undefined && blob.kid !== ROOTS.OFFLINE_ROOT_KID) throw new Error(`models: unexpected kid ${blob.kid}`);
  const raw = await verifyBlob(blob, ROOTS.OFFLINE_ROOT_PUB, DOMAINS.models);
  if (raw === null) throw new Error("models: signature invalid under the pinned offline root");
  return ModelCatalogSchema.parse(raw);
}
