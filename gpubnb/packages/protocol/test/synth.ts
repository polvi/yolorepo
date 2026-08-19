// Synthetic test material: a fake AMD chain (ARK/ASK RSA-PSS, VCEK P-384 with the AMD
// extensions), a signable SNP report, and a fake NRAS (ES384 JWKS + JWT signer). Lets the
// positive "verified" path run end-to-end without hardware. Only the roots are injected
// via VerifyOptions.amdRoots / fetchJwks; everything else goes through the production code.
import * as x509 from "@peculiar/x509";
import { b64u, concat, hex, sha256, toBuf, utf8, SNP_REPORT_LEN, SNP_SIGNED_LEN, type AmdRoots } from "../src/index.ts";

const OID = "1.3.6.1.4.1.3704.1";
const derInt = (v: number) => new Uint8Array([0x02, 0x01, v]);

export interface SynthAmd {
  roots: AmdRoots;
  product: "Genoa" | "Turin";
  vcekPem: string;
  vcekKey: CryptoKeyPair;
  chipId: Uint8Array;
  tcb: { bootLoader: number; tee: number; snp: number; microcode: number; fmc?: number };
}

export async function makeSynthAmd(product: "Genoa" | "Turin" = "Genoa", tcb = { bootLoader: 10, tee: 0, snp: 23, microcode: 84, fmc: 3 }, chipId = new Uint8Array(64).fill(0x5a)): Promise<SynthAmd> {
  const rsaAlg = { name: "RSA-PSS", hash: "SHA-384", publicExponent: new Uint8Array([1, 0, 1]), modulusLength: 2048, saltLength: 48 } as const;
  const arkKey = await crypto.subtle.generateKey(rsaAlg, true, ["sign", "verify"]);
  const askKey = await crypto.subtle.generateKey(rsaAlg, true, ["sign", "verify"]);
  const vcekKey = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-384" }, true, ["sign", "verify"]);
  const base = { notBefore: new Date("2020-01-01T00:00:00Z"), notAfter: new Date("2040-01-01T00:00:00Z") };
  const arkName = `CN=ARK-${product}, O=Advanced Micro Devices, OU=Engineering, L=Santa Clara, ST=CA, C=US`;
  const askName = `CN=SEV-${product}, O=Advanced Micro Devices, OU=Engineering, L=Santa Clara, ST=CA, C=US`;
  const ark = await x509.X509CertificateGenerator.createSelfSigned({ serialNumber: "01", name: arkName, keys: arkKey, signingAlgorithm: rsaAlg, ...base, extensions: [new x509.BasicConstraintsExtension(true, 1, true)] });
  const ask = await x509.X509CertificateGenerator.create({ serialNumber: "02", subject: askName, issuer: ark.subject, publicKey: askKey.publicKey, signingKey: arkKey.privateKey, signingAlgorithm: rsaAlg, ...base, extensions: [new x509.BasicConstraintsExtension(true, 0, true)] });
  const exts = [
    new x509.Extension(`${OID}.1`, false, toBuf(derInt(1))),
    new x509.Extension(`${OID}.2`, false, toBuf(utf8(`${product}-B0`))),
    new x509.Extension(`${OID}.3.1`, false, toBuf(derInt(tcb.bootLoader))),
    new x509.Extension(`${OID}.3.2`, false, toBuf(derInt(tcb.tee))),
    new x509.Extension(`${OID}.3.3`, false, toBuf(derInt(tcb.snp))),
    new x509.Extension(`${OID}.3.8`, false, toBuf(derInt(tcb.microcode))),
    new x509.Extension(`${OID}.4`, false, toBuf(chipId)),
  ];
  if (product === "Turin") exts.push(new x509.Extension(`${OID}.3.9`, false, toBuf(derInt(tcb.fmc ?? 0))));
  const vcek = await x509.X509CertificateGenerator.create({ serialNumber: "03", subject: "CN=SEV-VCEK, O=Advanced Micro Devices, OU=Engineering, L=Santa Clara, ST=CA, C=US", issuer: ask.subject, publicKey: vcekKey.publicKey, signingKey: askKey.privateKey, signingAlgorithm: rsaAlg, ...base, extensions: exts });
  return { roots: { [product]: { ask, ark } }, product, vcekPem: vcek.toString("pem"), vcekKey, chipId, tcb };
}

export interface SynthReportParams {
  reportData: Uint8Array;   // 64
  measurement: Uint8Array;  // 48
  chipId: Uint8Array;       // 64
  tcbRaw: bigint;
  policy?: bigint;          // default SMT | reserved(17)
  vmpl?: number;
  version?: number;
}

export function tcbRawFor(product: "Genoa" | "Turin" | "Milan", t: { bootLoader: number; tee: number; snp: number; microcode: number; fmc?: number }): bigint {
  const b = new Uint8Array(8);
  if (product === "Turin") { b[0] = t.fmc ?? 0; b[1] = t.bootLoader; b[2] = t.tee; b[3] = t.snp; b[7] = t.microcode; }
  else { b[0] = t.bootLoader; b[1] = t.tee; b[6] = t.snp; b[7] = t.microcode; }
  return new DataView(b.buffer).getBigUint64(0, true);
}

/** Build + sign a report with the synthetic VCEK. */
export async function makeSynthReport(amd: SynthAmd, p: SynthReportParams): Promise<Uint8Array> {
  const r = new Uint8Array(SNP_REPORT_LEN);
  const dv = new DataView(r.buffer);
  dv.setUint32(0x000, p.version ?? 3, true);
  dv.setBigUint64(0x008, p.policy ?? ((1n << 16n) | (1n << 17n)), true);
  dv.setUint32(0x030, p.vmpl ?? 0, true);
  dv.setUint32(0x034, 1, true);
  dv.setBigUint64(0x038, p.tcbRaw, true);
  r.set(p.reportData, 0x050);
  r.set(p.measurement, 0x090);
  dv.setBigUint64(0x180, p.tcbRaw, true);
  if (amd.product === "Genoa") { r[0x188] = 25; r[0x189] = 17; r[0x18a] = 1; } else { r[0x188] = 26; r[0x189] = 2; r[0x18a] = 1; }
  r.set(p.chipId, 0x1a0);
  dv.setBigUint64(0x1e0, p.tcbRaw, true);
  dv.setBigUint64(0x1f0, p.tcbRaw, true);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-384" }, amd.vcekKey.privateKey, toBuf(r.slice(0, SNP_SIGNED_LEN))));
  // r‖s big-endian 48 each → little-endian zero-padded 72 each
  const le = (b: Uint8Array) => { const o = new Uint8Array(72); for (let i = 0; i < 48; i++) o[i] = b[47 - i]!; return o; };
  r.set(le(sig.slice(0, 48)), 0x2a0);
  r.set(le(sig.slice(48, 96)), 0x2a0 + 72);
  return r;
}

export interface SynthNras { jwks: JsonWebKey[]; sign(claims: Record<string, unknown>, kid?: string): Promise<string>; kid: string }

export async function makeSynthNras(): Promise<SynthNras> {
  const key = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-384" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", key.publicKey);
  const kid = "nv-eat-kid-test-0001";
  const pub: JsonWebKey & { kid: string } = { kty: "EC", crv: "P-384", x: jwk.x, y: jwk.y, kid };
  return {
    kid,
    jwks: [pub],
    async sign(claims, k = kid) {
      const h = b64u.encode(utf8(JSON.stringify({ kid: k, alg: "ES384" })));
      const c = b64u.encode(utf8(JSON.stringify(claims)));
      const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-384" }, key.privateKey, toBuf(utf8(`${h}.${c}`))));
      return `${h}.${c}.${b64u.encode(sig)}`;
    },
  };
}

/** Detached-EAT bundle shaped like NRAS output, for a given gpu_nonce (hex) and time. */
export async function makeSynthEat(nras: SynthNras, p: { nonceHex: string; nowS: number; hwmodel?: string; overall?: boolean; measres?: string; dbgstat?: string; secboot?: boolean; devices?: number; expOffset?: number }) {
  const iss = "https://nras.attestation.nvidia.com";
  const n = p.devices ?? 1;
  const devices: Record<string, string> = {};
  const submods: Record<string, unknown> = {};
  for (let i = 0; i < n; i++) {
    const name = `GPU-${i}`;
    const jwt = await nras.sign({ iss, eat_nonce: p.nonceHex, nbf: p.nowS - 10, iat: p.nowS, exp: p.nowS + (p.expOffset ?? 3600), jti: `d${i}`, ueid: "1", oemid: "5703", hwmodel: p.hwmodel ?? "GB202", measres: p.measres ?? "success", dbgstat: p.dbgstat ?? "disabled", secboot: p.secboot ?? true, "x-nvidia-gpu-driver-version": "595.58.03" });
    devices[name] = jwt;
    submods[name] = ["DIGEST", ["SHA-256", hex.encode(await sha256(utf8(jwt)))]];
  }
  const overall = await nras.sign({ sub: "NVIDIA-PLATFORM-ATTESTATION", "x-nvidia-ver": "2.0", iss, "x-nvidia-overall-att-result": p.overall ?? true, submods, eat_nonce: p.nonceHex, nbf: p.nowS - 10, iat: p.nowS, exp: p.nowS + (p.expOffset ?? 3600), jti: "o1" });
  return { overall, devices };
}

export const concatU8 = concat;
