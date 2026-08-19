// VCEK → ASK → ARK chain verification with @peculiar/x509, plus the VCEK
// extension ↔ report cross-checks (hwID == CHIP_ID, TCB SPLs == REPORTED_TCB).
import { X509Certificate, PemConverter } from "@peculiar/x509";
import { AMD_CERT_CHAINS } from "../roots/amd/index.ts";
import { bytesEqual, hex, toBuf } from "../encoding.ts";
import { parseTcb, type SnpProduct, type SnpReport, type TcbVersion } from "./report.ts";

export const OID_AMD = "1.3.6.1.4.1.3704.1";
export const OID_STRUCT_VERSION = `${OID_AMD}.1`;
export const OID_PRODUCT_NAME = `${OID_AMD}.2`;
export const OID_BL_SPL = `${OID_AMD}.3.1`;
export const OID_TEE_SPL = `${OID_AMD}.3.2`;
export const OID_SNP_SPL = `${OID_AMD}.3.3`;
export const OID_UCODE_SPL = `${OID_AMD}.3.8`;
export const OID_FMC_SPL = `${OID_AMD}.3.9`;
export const OID_HWID = `${OID_AMD}.4`;

export interface AmdRoots { [product: string]: { ask: X509Certificate; ark: X509Certificate } }

let rootsCache: AmdRoots | undefined;
/** Pinned AMD roots: Genoa + Turin (the CC-capable lines gpubnb targets) and Milan (for the public go-sev-guest test vector). */
export function amdRoots(extra?: Record<string, string>): AmdRoots {
  if (rootsCache && !extra) return rootsCache;
  const out: AmdRoots = {};
  for (const [product, pem] of Object.entries({ ...AMD_CERT_CHAINS, ...(extra ?? {}) })) {
    const certs = PemConverter.decode(pem).map((der) => new X509Certificate(der));
    if (certs.length !== 2) throw new Error(`AMD chain for ${product} must hold [ASK, ARK]`);
    out[product] = { ask: certs[0]!, ark: certs[1]! };
  }
  if (!extra) rootsCache = out;
  return out;
}

export function parsePemChain(pems: string[]): X509Certificate[] {
  const out: X509Certificate[] = [];
  for (const p of pems) for (const der of PemConverter.decode(p)) out.push(new X509Certificate(der));
  return out;
}

function cn(name: string): string | undefined {
  const m = /(?:^|,\s*)CN=([^,]+)/.exec(name);
  return m?.[1];
}

/** Product line from the VCEK issuer CN ("SEV-Genoa"), falling back to the productName extension. */
export function vcekProduct(vcek: X509Certificate): SnpProduct | undefined {
  const issuer = cn(vcek.issuer) ?? "";
  for (const p of ["Milan", "Genoa", "Turin"] as const) if (issuer.includes(p)) return p;
  const ext = vcek.getExtension(OID_PRODUCT_NAME);
  if (ext) {
    const s = new TextDecoder().decode(new Uint8Array(ext.value));
    for (const p of ["Milan", "Genoa", "Turin"] as const) if (s.includes(p)) return p;
  }
  return undefined;
}

/** Extension value as bytes: either raw (AMD hwID) or a DER-wrapped INTEGER/OCTET STRING. */
function extBytes(cert: X509Certificate, oid: string): Uint8Array | undefined {
  const ext = cert.getExtension(oid);
  if (!ext) return undefined;
  return new Uint8Array(ext.value);
}

function derInt(b: Uint8Array): number | undefined {
  // DER INTEGER: 0x02 len value (big-endian, may have leading 0x00)
  if (b.length >= 3 && b[0] === 0x02) {
    const len = b[1]!;
    if (len + 2 !== b.length) return undefined;
    let v = 0;
    for (let i = 2; i < b.length; i++) v = v * 256 + b[i]!;
    return v;
  }
  // some tooling writes a bare single byte
  if (b.length === 1) return b[0];
  return undefined;
}

export interface VcekExtensions { product?: SnpProduct; hwId?: Uint8Array; tcb: Partial<TcbVersion> }

export function vcekExtensions(vcek: X509Certificate): VcekExtensions {
  const hw = extBytes(vcek, OID_HWID);
  let hwId: Uint8Array | undefined;
  if (hw) {
    if (hw.length === 64) hwId = hw;
    else if (hw.length === 66 && hw[0] === 0x04 && hw[1] === 0x40) hwId = hw.subarray(2); // OCTET STRING wrapped
  }
  const tcb: Partial<TcbVersion> = {};
  const bl = extBytes(vcek, OID_BL_SPL); if (bl) tcb.bootLoader = derInt(bl);
  const tee = extBytes(vcek, OID_TEE_SPL); if (tee) tcb.tee = derInt(tee);
  const snp = extBytes(vcek, OID_SNP_SPL); if (snp) tcb.snp = derInt(snp);
  const uc = extBytes(vcek, OID_UCODE_SPL); if (uc) tcb.microcode = derInt(uc);
  const fmc = extBytes(vcek, OID_FMC_SPL); if (fmc) tcb.fmc = derInt(fmc);
  return { product: vcekProduct(vcek), hwId, tcb };
}

export interface ChainResult { ok: boolean; detail: string; vcek?: X509Certificate; product?: SnpProduct }

/**
 * Verify the VCEK chain: vcek signed by pinned ASK (RSA-PSS SHA-384), ASK signed by pinned ARK (RSA-PSS),
 * ARK self-signed. The doc's `vcek_chain` may carry only the VCEK or VCEK+ASK+ARK; whatever it carries,
 * the ASK/ARK actually used are the PINNED ones (doc-supplied intermediates are ignored after matching).
 * `now` in ms; the VCEK validity window is checked against it.
 */
export async function verifyVcekChain(pems: string[], now: number, roots: AmdRoots = amdRoots()): Promise<ChainResult> {
  let certs: X509Certificate[];
  try { certs = parsePemChain(pems); } catch (e) { return { ok: false, detail: `vcek_chain: unparsable PEM (${(e as Error).message})` }; }
  if (certs.length === 0) return { ok: false, detail: "vcek_chain: empty" };
  const vcek = certs[0]!;
  const product = vcekProduct(vcek);
  // On failure the (untrusted) VCEK and product are still returned so later checks can report
  // whether the rest of the doc is at least self-consistent; the chain check itself stays failed.
  const bad = (detail: string): ChainResult => ({ ok: false, detail, vcek, product });
  if (!product || !roots[product]) return bad(`vcek issuer ${JSON.stringify(vcek.issuer)} is not a pinned AMD product line`);
  const { ask, ark } = roots[product]!;
  if (vcek.issuer !== ask.subject) return bad(`vcek issuer ${vcek.issuer} != pinned ASK subject ${ask.subject}`);
  if (now < vcek.notBefore.getTime() || now > vcek.notAfter.getTime()) return bad(`vcek not valid at ${new Date(now).toISOString()} (${vcek.notBefore.toISOString()}..${vcek.notAfter.toISOString()})`);
  try {
    // ARK self-signature, ASK under ARK, VCEK under ASK. All RSA-PSS SHA-384 for ARK/ASK; VCEK is P-384 signed by the RSA ASK.
    if (!(await ark.verify({ publicKey: ark, signatureOnly: true }))) return bad(`pinned ARK-${product} self-signature invalid`);
    if (!(await ask.verify({ publicKey: ark, signatureOnly: true }))) return bad(`pinned ASK-${product} not signed by ARK`);
    if (!(await vcek.verify({ publicKey: ask, signatureOnly: true }))) return bad(`VCEK signature not valid under pinned ASK-${product}`);
  } catch (e) {
    return bad(`chain verification error: ${(e as Error).message}`);
  }
  return { ok: true, detail: `VCEK → ASK-${product} → ARK-${product} (pinned)`, vcek, product };
}

/** hwID == CHIP_ID and every TCB SPL extension == the corresponding REPORTED_TCB component. */
export function checkVcekAgainstReport(vcek: X509Certificate, report: SnpReport, product: SnpProduct): { ok: boolean; detail: string } {
  const ext = vcekExtensions(vcek);
  if (!ext.hwId) return { ok: false, detail: "VCEK has no hwID extension" };
  const chipMasked = report.chipId.every((b) => b === 0);
  if (!chipMasked && !bytesEqual(ext.hwId, report.chipId)) return { ok: false, detail: `VCEK hwID ${hex.encode(ext.hwId).slice(0, 16)}… != report CHIP_ID ${hex.encode(report.chipId).slice(0, 16)}…` };
  if (chipMasked) return { ok: false, detail: "report CHIP_ID is masked (MASK_CHIP_KEY); cannot bind VCEK to the chip" };
  const tcb = parseTcb(report.reportedTcbRaw, product);
  const mism: string[] = [];
  if (ext.tcb.bootLoader !== undefined && ext.tcb.bootLoader !== tcb.bootLoader) mism.push(`bl ${ext.tcb.bootLoader}!=${tcb.bootLoader}`);
  if (ext.tcb.tee !== undefined && ext.tcb.tee !== tcb.tee) mism.push(`tee ${ext.tcb.tee}!=${tcb.tee}`);
  if (ext.tcb.snp !== undefined && ext.tcb.snp !== tcb.snp) mism.push(`snp ${ext.tcb.snp}!=${tcb.snp}`);
  if (ext.tcb.microcode !== undefined && ext.tcb.microcode !== tcb.microcode) mism.push(`ucode ${ext.tcb.microcode}!=${tcb.microcode}`);
  if (product === "Turin" && ext.tcb.fmc !== undefined && ext.tcb.fmc !== tcb.fmc) mism.push(`fmc ${ext.tcb.fmc}!=${tcb.fmc}`);
  if (ext.tcb.bootLoader === undefined && ext.tcb.snp === undefined) mism.push("VCEK has no TCB SPL extensions");
  if (mism.length) return { ok: false, detail: `VCEK TCB extensions do not match REPORTED_TCB: ${mism.join(", ")}` };
  return { ok: true, detail: `hwID == CHIP_ID; VCEK SPLs == REPORTED_TCB (bl=${tcb.bootLoader} tee=${tcb.tee} snp=${tcb.snp} ucode=${tcb.microcode}${product === "Turin" ? ` fmc=${tcb.fmc}` : ""})` };
}

/** ECDSA P-384 / SHA-384 over report bytes 0..0x2A0 with the VCEK public key; signature is r‖s big-endian (IEEE P1363). */
export async function verifyReportSignature(vcek: X509Certificate, report: SnpReport): Promise<{ ok: boolean; detail: string }> {
  if (report.signatureAlgo !== 1) return { ok: false, detail: `unsupported SIGNATURE_ALGO ${report.signatureAlgo} (want 1 = ECDSA P-384 SHA-384)` };
  try {
    const key = await vcek.publicKey.export({ name: "ECDSA", namedCurve: "P-384" }, ["verify"]);
    const sig = new Uint8Array(96); sig.set(report.sigR, 0); sig.set(report.sigS, 48);
    const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-384" }, key, toBuf(sig), toBuf(report.signedBytes));
    return ok ? { ok: true, detail: "ECDSA P-384 signature valid under VCEK" } : { ok: false, detail: "ECDSA P-384 signature INVALID under VCEK" };
  } catch (e) {
    return { ok: false, detail: `signature check error: ${(e as Error).message}` };
  }
}
