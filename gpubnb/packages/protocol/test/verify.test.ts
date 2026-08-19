import { describe, expect, test } from "bun:test";
import {
  verifyAttestationDoc, verifyGolden, verifyModels, GOLDEN_BLOB, MODELS_BLOB, makeSimulatedDoc, generateRunnerKeys, simulatedMeasurement,
  computeBinding, reportData, gpuNonce, signBlob, DOMAINS, ROOTS, b64u, hex, utf8, utf8Decode, peekBlob, parseSnpReport, NRAS_ISSUER, decodeJwt,
  type AttestationDoc, type Verdict, type GoldenSet, type SignedBlob,
} from "../src/index.ts";
import { dataBytes, dataText, fixture } from "./helpers.ts";
import { makeSynthAmd, makeSynthEat, makeSynthNras, makeSynthReport, tcbRawFor } from "./synth.ts";

const golden = await verifyGolden(GOLDEN_BLOB);
const ids = (v: Verdict) => v.checks.map((c) => c.id);
const failed = (v: Verdict) => v.checks.filter((c) => !c.ok).map((c) => c.id);
const model = { id: "Qwen/Qwen3-8B", digest: "a1".repeat(32), ctx_len: 32768 };

describe("golden + models", () => {
  test("shipped blobs verify under the offline root and follow the simulated measurement convention", async () => {
    expect(golden.v).toBe(1);
    const sim = golden.entries.filter((e) => e.simulated);
    expect(sim.length).toBeGreaterThan(0);
    for (const e of sim) expect(e.measurement).toBe(hex.encode(await simulatedMeasurement(e.runner_version)));
    expect(sim.some((e) => e.runner_version === "0.1.0")).toBe(true);
    const models = await verifyModels(MODELS_BLOB);
    expect(models.simulated_any).toBe(true);
    expect(models.entries).toEqual([]);
    expect(GOLDEN_BLOB.kid).toBe(ROOTS.OFFLINE_ROOT_KID);
  });
  test("dev-root-signed golden is refused; tampered blob refused; wrong kid refused", async () => {
    const forged = await signBlob({ v: 1, issued_at: 1, entries: [] }, ROOTS.DEV_ROOT_PRIV, DOMAINS.golden, ROOTS.OFFLINE_ROOT_KID);
    await expect(verifyGolden(forged)).rejects.toThrow(/signature/);
    await expect(verifyGolden({ ...GOLDEN_BLOB, payload: GOLDEN_BLOB.payload + "A" })).rejects.toThrow();
    await expect(verifyGolden({ ...GOLDEN_BLOB, kid: "other" })).rejects.toThrow(/kid/);
    await expect(verifyModels(GOLDEN_BLOB)).rejects.toThrow(); // wrong domain
  });
});

describe("verifyAttestationDoc: simulated", () => {
  test("fresh simulated doc → simulated when allowed, failed otherwise; check order", async () => {
    const k = await generateRunnerKeys();
    const challenge = new Uint8Array(32).fill(7);
    const doc = await makeSimulatedDoc({ ...k, runnerVersion: "0.1.0", model, challenge });
    const v = await verifyAttestationDoc(doc, { golden, allowSimulated: true, expectedChallenge: challenge });
    expect(v.status).toBe("simulated");
    expect(ids(v)).toEqual(["doc.sig", "doc.binding", "doc.fresh", "sim.sig", "sim.report_data", "sim.gpu_nonce", "sim.measurement"]);
    expect(v.doc?.platform.kind).toBe("simulated");
    const v2 = await verifyAttestationDoc(doc, { golden, expectedChallenge: challenge });
    expect(v2.status).toBe("failed");
    expect(failed(v2)).toEqual(["sim.allowed"]);
  });
  test("negatives: wrong challenge, stale, unknown runner version, wrong measurement, forged inner, tampered outer, wrong sign key, models catalog", async () => {
    const k = await generateRunnerKeys();
    const challenge = new Uint8Array(32).fill(7);
    const doc = await makeSimulatedDoc({ ...k, runnerVersion: "0.1.0", model, challenge });
    expect(failed(await verifyAttestationDoc(doc, { golden, allowSimulated: true, expectedChallenge: new Uint8Array(32) }))).toEqual(["doc.fresh"]);
    expect(failed(await verifyAttestationDoc(doc, { golden, allowSimulated: true, now: Date.now() + 11 * 60_000 }))).toEqual(["doc.fresh"]);
    expect(failed(await verifyAttestationDoc(doc, { golden, allowSimulated: true, now: Date.now() - 11 * 60_000 }))).toEqual(["doc.fresh"]);
    const unknownVer = await makeSimulatedDoc({ ...k, runnerVersion: "9.9.9", model });
    expect(failed(await verifyAttestationDoc(unknownVer, { golden, allowSimulated: true }))).toEqual(["sim.measurement"]);
    const wrongMeas = await makeSimulatedDoc({ ...k, runnerVersion: "0.1.0", model, measurement: new Uint8Array(48).fill(1) });
    expect(failed(await verifyAttestationDoc(wrongMeas, { golden, allowSimulated: true }))).toEqual(["sim.measurement"]);
    // inner signed by a non-dev key
    const other = await generateRunnerKeys();
    const forgedInner = await makeSimulatedDoc({ ...k, runnerVersion: "0.1.0", model, devRootPriv: other.signPriv });
    expect(failed(await verifyAttestationDoc(forgedInner, { golden, allowSimulated: true }))).toEqual(["sim.sig"]);
    // outer payload edited after signing
    const payload = peekBlob<AttestationDoc>(doc)!;
    const edited: SignedBlob = { ...doc, payload: b64u.encode(utf8(JSON.stringify({ ...payload, runner_version: "0.1.1" }))) };
    const ve = await verifyAttestationDoc(edited, { golden, allowSimulated: true });
    expect(ve.status).toBe("failed"); expect(ids(ve)).toEqual(["doc.sig"]);
    // signed with a key other than sign_pub
    const wrongKey = await makeSimulatedDoc({ ...k, signPriv: other.signPriv, runnerVersion: "0.1.0", model });
    expect(ids(await verifyAttestationDoc(wrongKey, { golden, allowSimulated: true }))).toEqual(["doc.sig"]);
    // binding mismatch: swap boot_nonce in payload and re-sign with the real key
    const swapped = await signBlob({ ...payload, boot_nonce: b64u.encode(new Uint8Array(32)) }, k.signPriv, DOMAINS.attdoc);
    expect(failed(await verifyAttestationDoc(swapped, { golden, allowSimulated: true }))).toEqual(["doc.binding"]);
    // models catalog: simulated_any true → ok; a catalog without it → doc.model fails
    const models = await verifyModels(MODELS_BLOB);
    expect(failed(await verifyAttestationDoc(doc, { golden, allowSimulated: true, expectedChallenge: challenge, models }))).toEqual([]);
    expect(failed(await verifyAttestationDoc(doc, { golden, allowSimulated: true, expectedChallenge: challenge, models: { ...models, simulated_any: false } }))).toEqual(["doc.model"]);
    // garbage blob
    expect((await verifyAttestationDoc({ payload: "!!", sig: "" }, { golden })).status).toBe("failed");
  });
  test("simulated-doc.json fixture verdicts", async () => {
    const f = fixture("simulated-doc.json");
    const g: GoldenSet = await verifyGolden(f.golden_blob);
    expect(f.simulated_measurement).toBe(hex.encode(await simulatedMeasurement(f.runner_version)));
    for (const e of f.expected) {
      const doc = f.docs[e.doc].doc;
      const v = await verifyAttestationDoc(doc, { golden: g, allowSimulated: e.options.allowSimulated, now: f.issued_at * 1000, expectedChallenge: e.options.expectedChallenge ? hex.decode(e.options.expectedChallenge) : undefined });
      expect(v.status).toBe(e.status);
      expect(failed(v)).toEqual(e.failed_checks);
    }
    // the doc in the fixture is reproducible from the keys (deterministic: fixed issued_at, deterministic Ed25519)
    const kk = f.keys;
    const again = await makeSimulatedDoc({ hpkePub: hex.decode(kk.hpke_pub), signPub: hex.decode(kk.sign_pub), signPriv: hex.decode(kk.sign_priv), bootNonce: hex.decode(kk.boot_nonce), runnerVersion: f.runner_version, model: f.model, challenge: hex.decode(f.docs.with_challenge.challenge), issuedAt: f.issued_at });
    expect(again).toEqual(f.docs.with_challenge.doc);
  });
});

describe("verifyAttestationDoc: snp (real AMD + NVIDIA material, partial)", () => {
  // Real report/VCEK/EAT cannot be bound to our keys (their REPORT_DATA / eat_nonce are fixed), so the
  // expected verdict is `failed` with exactly the binding-dependent checks failing and every
  // cryptographic check passing. That exercises the whole real-data path.
  const jwksAtCapture = (JSON.parse(dataText("nras-jwks-at-capture.json")) as { keys: JsonWebKey[] }).keys;
  const sample = JSON.parse(dataText("nras-sample-eat.json")) as [["JWT", string], Record<string, string>];
  const gpu = { overall: sample[0][1], devices: sample[1] };
  const nowMs = (decodeJwt(gpu.overall).claims.iat as number) * 1000 + 30_000; // inside the EAT's validity

  async function realDoc(reportFile: string, vcekFile: string) {
    const k = await generateRunnerKeys();
    const report = dataBytes(reportFile);
    const binding = await computeBinding({ hpkePub: k.hpkePub, signPub: k.signPub, bootNonce: k.bootNonce, runnerVersion: "0.1.0", modelDigest: hex.decode(model.digest) });
    const doc: AttestationDoc = {
      v: 1, runner_version: "0.1.0", hpke_pub: b64u.encode(k.hpkePub), sign_pub: b64u.encode(k.signPub), boot_nonce: b64u.encode(k.bootNonce),
      binding: hex.encode(binding), challenge: "00".repeat(32), issued_at: Math.floor(nowMs / 1000),
      model, platform: { kind: "snp", cpu: "AMD EPYC", gpu_model: "H100", cc_mode: "on" },
      snp: { report: b64u.encode(report), vcek_chain: [dataText(vcekFile)] }, gpu, simulated: null,
    };
    return signBlob(doc, k.signPriv, DOMAINS.attdoc);
  }

  test("Genoa v3 report + H100 EAT: all crypto passes, only binding-dependent checks fail", async () => {
    const blob = await realDoc("report_genoa_v3.bin", "vcek_genoa.pem");
    const v = await verifyAttestationDoc(blob, { golden, now: nowMs, fetchJwks: async () => jwksAtCapture });
    expect(ids(v)).toEqual(["doc.sig", "doc.binding", "doc.fresh", "snp.parse", "snp.chain", "snp.sig", "snp.policy", "snp.tcb", "snp.measurement", "snp.report_data", "gpu.jwt", "gpu.nonce", "gpu.claims"]);
    expect(failed(v)).toEqual(["snp.measurement", "snp.report_data", "gpu.nonce"]);
    expect(v.status).toBe("failed");
  });
  test("Milan v2 (debug policy) report: policy check catches DEBUG=1", async () => {
    const blob = await realDoc("report.bin", "vcek.pem");
    // VCEK validity 2022..2029 and EAT validity both need `now` inside; the EAT's iat (2026) is inside the VCEK window
    const v = await verifyAttestationDoc(blob, { golden, now: nowMs, fetchJwks: async () => jwksAtCapture });
    expect(failed(v)).toEqual(["snp.policy", "snp.measurement", "snp.report_data", "gpu.nonce"]);
    expect(v.checks.find((c) => c.id === "snp.sig")!.ok).toBe(true);
    expect(v.checks.find((c) => c.id === "snp.chain")!.ok).toBe(true);
  });
  test("expired EAT / live JWKS without the kid → gpu.jwt fails", async () => {
    const blob = await realDoc("report_genoa_v3.bin", "vcek_genoa.pem");
    const v = await verifyAttestationDoc(blob, { golden, now: nowMs, fetchJwks: async () => (JSON.parse(dataText("nras-jwks.json")) as { keys: JsonWebKey[] }).keys });
    expect(failed(v)).toContain("gpu.jwt");
    expect(ids(v)).not.toContain("gpu.nonce");
  });
  test("snp section missing / tampered report bytes", async () => {
    const blob = await realDoc("report_genoa_v3.bin", "vcek_genoa.pem");
    const payload = peekBlob<AttestationDoc>(blob)!;
    const k = await generateRunnerKeys();
    // resign with a different key → doc.sig fails (sign_pub in payload is the original)
    expect(ids(await verifyAttestationDoc(await signBlob(payload, k.signPriv, DOMAINS.attdoc), { golden, now: nowMs, fetchJwks: async () => jwksAtCapture }))).toEqual(["doc.sig"]);
  });
});

describe("verifyAttestationDoc: snp (synthetic roots, full positive path)", () => {
  test("verified when every check passes; each tampering flips exactly its check", async () => {
    const amd = await makeSynthAmd("Genoa");
    const nras = await makeSynthNras();
    const k = await generateRunnerKeys();
    const challenge = new Uint8Array(32).fill(0x33);
    const binding = await computeBinding({ hpkePub: k.hpkePub, signPub: k.signPub, bootNonce: k.bootNonce, runnerVersion: "0.1.0", modelDigest: hex.decode(model.digest) });
    const measurement = new Uint8Array(48).fill(0x77);
    const goldenWithReal: GoldenSet = { ...golden, entries: [...golden.entries, { runner_version: "0.1.0", measurement: hex.encode(measurement), verity_root: "00".repeat(32), simulated: false, note: "synthetic test image" }] };
    const nowS = 1_800_000_000;
    const tcbRaw = tcbRawFor("Genoa", amd.tcb);
    const mk = async (over: { reportData?: Uint8Array; measurement?: Uint8Array; chipId?: Uint8Array; tcbRaw?: bigint; policy?: bigint; vmpl?: number; nonceHex?: string; eat?: Partial<Parameters<typeof makeSynthEat>[1]>; vcekPem?: string; challenge?: Uint8Array } = {}) => {
      const ch = over.challenge ?? challenge;
      const report = await makeSynthReport(amd, { reportData: over.reportData ?? (await reportData(binding, ch)), measurement: over.measurement ?? measurement, chipId: over.chipId ?? amd.chipId, tcbRaw: over.tcbRaw ?? tcbRaw, policy: over.policy, vmpl: over.vmpl });
      const gpu = await makeSynthEat(nras, { nonceHex: over.nonceHex ?? hex.encode(await gpuNonce(binding, ch)), nowS, ...(over.eat ?? {}) });
      const doc: AttestationDoc = {
        v: 1, runner_version: "0.1.0", hpke_pub: b64u.encode(k.hpkePub), sign_pub: b64u.encode(k.signPub), boot_nonce: b64u.encode(k.bootNonce),
        binding: hex.encode(binding), challenge: hex.encode(ch), issued_at: nowS, model,
        platform: { kind: "snp", cpu: "AMD EPYC 9375F", gpu_model: "NVIDIA RTX PRO 6000 Blackwell Server Edition", cc_mode: "on" },
        snp: { report: b64u.encode(report), vcek_chain: [over.vcekPem ?? amd.vcekPem] }, gpu, simulated: null,
      };
      return signBlob(doc, k.signPriv, DOMAINS.attdoc);
    };
    const opts = { golden: goldenWithReal, now: nowS * 1000, fetchJwks: async () => nras.jwks, amdRoots: amd.roots, expectedChallenge: challenge };
    const ok = await verifyAttestationDoc(await mk(), opts);
    expect(failed(ok)).toEqual([]);
    expect(ok.status).toBe("verified");
    expect(ids(ok)).toEqual(["doc.sig", "doc.binding", "doc.fresh", "snp.parse", "snp.chain", "snp.sig", "snp.policy", "snp.tcb", "snp.measurement", "snp.report_data", "gpu.jwt", "gpu.nonce", "gpu.claims"]);

    // without the injected roots the synthetic chain is rejected (pinned AMD roots only)
    expect(failed(await verifyAttestationDoc(await mk(), { ...opts, amdRoots: undefined }))).toEqual(["snp.chain"]);
    // allowSimulated must not turn a real doc into "simulated"
    expect((await verifyAttestationDoc(await mk(), { ...opts, allowSimulated: true })).status).toBe("verified");

    const cases: [string, Parameters<typeof mk>[0], string[]][] = [
      ["wrong report_data", { reportData: new Uint8Array(64).fill(1) }, ["snp.report_data"]],
      ["unknown measurement", { measurement: new Uint8Array(48).fill(1) }, ["snp.measurement"]],
      ["chip id mismatch", { chipId: new Uint8Array(64).fill(1) }, ["snp.chain"]],
      ["tcb below floor", { tcbRaw: tcbRawFor("Genoa", { ...amd.tcb, snp: 1 }) }, ["snp.chain", "snp.tcb"]],
      ["debug policy", { policy: (1n << 16n) | (1n << 17n) | (1n << 19n) }, ["snp.policy"]],
      ["migrate_ma policy", { policy: (1n << 16n) | (1n << 17n) | (1n << 18n) }, ["snp.policy"]],
      ["vmpl 1", { vmpl: 1 }, ["snp.policy"]],
      ["gpu nonce mismatch", { nonceHex: "ab".repeat(32) }, ["gpu.nonce"]],
      ["overall result false", { eat: { overall: false } }, ["gpu.claims"]],
      ["measres fail", { eat: { measres: "fail" } }, ["gpu.claims"]],
      ["dbgstat enabled (devtools)", { eat: { dbgstat: "enabled" } }, ["gpu.claims"]],
      ["secboot off", { eat: { secboot: false } }, ["gpu.claims"]],
      ["hwmodel not allowlisted", { eat: { hwmodel: "GA100" } }, ["gpu.claims"]],
      ["expired EAT", { eat: { expOffset: -3600 } }, ["gpu.jwt"]],
      ["two GPUs ok", { eat: { devices: 2 } }, []],
      ["challenge mismatch", { challenge: new Uint8Array(32) }, ["doc.fresh"]],
    ];
    for (const [name, over, expectFailed] of cases) {
      const v = await verifyAttestationDoc(await mk(over), opts);
      expect({ name, failed: failed(v) }).toEqual({ name, failed: expectFailed });
      expect(v.status).toBe(expectFailed.length ? "failed" : "verified");
    }
    // higher floor rejects
    expect(failed(await verifyAttestationDoc(await mk(), { ...opts, minTcb: { Genoa: { snp: 99 } } }))).toEqual(["snp.tcb"]);
    // stricter hwmodel allowlist rejects GB202
    expect(failed(await verifyAttestationDoc(await mk(), { ...opts, hwmodelAllow: ["H100"] }))).toEqual(["gpu.claims"]);
    // a device JWT swapped for a different (valid) one breaks the submods digest binding
    const good = peekBlob<AttestationDoc>(await mk())!;
    const other = await makeSynthEat(nras, { nonceHex: hex.encode(await gpuNonce(binding, challenge)), nowS });
    const swapped = await signBlob({ ...good, gpu: { overall: good.gpu!.overall, devices: { "GPU-0": other.devices["GPU-0"]! } } }, k.signPriv, DOMAINS.attdoc);
    expect(failed(await verifyAttestationDoc(swapped, opts))).toEqual(["gpu.jwt"]);
    // Turin line works too (different TCB layout, fmc SPL)
    const turin = await makeSynthAmd("Turin", { bootLoader: 9, tee: 0, snp: 11, microcode: 72, fmc: 3 });
    const tReport = await makeSynthReport(turin, { reportData: await reportData(binding, challenge), measurement, chipId: turin.chipId, tcbRaw: tcbRawFor("Turin", turin.tcb) });
    const tDoc = await signBlob({ ...good, snp: { report: b64u.encode(tReport), vcek_chain: [turin.vcekPem] } }, k.signPriv, DOMAINS.attdoc);
    const tv = await verifyAttestationDoc(tDoc, { ...opts, amdRoots: turin.roots });
    expect(failed(tv)).toEqual([]);
    expect(tv.checks.find((c) => c.id === "snp.tcb")!.detail).toContain("fmc=3");
  });
});
