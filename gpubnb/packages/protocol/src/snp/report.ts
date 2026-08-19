// SEV-SNP ATTESTATION_REPORT parser (AMD SEV-SNP ABI spec, 1184 bytes, versions 2 and 3).
import { hex } from "../encoding.ts";

export const SNP_REPORT_LEN = 1184;          // 0x4A0
export const SNP_SIGNED_LEN = 0x2a0;         // bytes covered by the VCEK signature
export const SNP_POLICY_BIT_SMT = 16n;
export const SNP_POLICY_BIT_MIGRATE_MA = 18n;
export const SNP_POLICY_BIT_DEBUG = 19n;
export const SNP_POLICY_BIT_SINGLE_SOCKET = 20n;

/** TCB_VERSION components. Milan/Genoa: [bl, tee, _, _, _, _, snp, ucode]. Turin: [fmc, bl, tee, snp, _, _, _, ucode]. */
export interface TcbVersion {
  raw: bigint;
  bootLoader: number;
  tee: number;
  snp: number;
  microcode: number;
  fmc?: number; // Turin only
}

export type SnpProduct = "Milan" | "Genoa" | "Turin";

export function parseTcb(raw: bigint, product: SnpProduct): TcbVersion {
  const b = (i: number) => Number((raw >> BigInt(8 * i)) & 0xffn);
  if (product === "Turin") return { raw, fmc: b(0), bootLoader: b(1), tee: b(2), snp: b(3), microcode: b(7) };
  return { raw, bootLoader: b(0), tee: b(1), snp: b(6), microcode: b(7) };
}

/** Component-wise "a >= b" (every SPL at least the floor). */
export function tcbAtLeast(a: TcbVersion, floor: Partial<TcbVersion>): boolean {
  if (floor.bootLoader !== undefined && a.bootLoader < floor.bootLoader) return false;
  if (floor.tee !== undefined && a.tee < floor.tee) return false;
  if (floor.snp !== undefined && a.snp < floor.snp) return false;
  if (floor.microcode !== undefined && a.microcode < floor.microcode) return false;
  if (floor.fmc !== undefined && (a.fmc ?? 0) < floor.fmc) return false;
  return true;
}

export interface SnpReport {
  version: number;
  guestSvn: number;
  policy: bigint;
  familyId: Uint8Array;     // 16
  imageId: Uint8Array;      // 16
  vmpl: number;
  signatureAlgo: number;    // 1 = ECDSA P-384 SHA-384
  currentTcbRaw: bigint;
  platformInfo: bigint;
  flags: number;            // bit0 author_key_en, bit1 mask_chip_key, bits 2..4 signing_key
  reportData: Uint8Array;   // 64
  measurement: Uint8Array;  // 48
  hostData: Uint8Array;     // 32
  idKeyDigest: Uint8Array;  // 48
  authorKeyDigest: Uint8Array; // 48
  reportId: Uint8Array;     // 32
  reportIdMa: Uint8Array;   // 32
  reportedTcbRaw: bigint;
  /** v3 only: CPUID family/model/stepping (zero on v2). */
  cpuidFamId: number; cpuidModId: number; cpuidStep: number;
  chipId: Uint8Array;       // 64
  committedTcbRaw: bigint;
  currentBuild: number; currentMinor: number; currentMajor: number;
  committedBuild: number; committedMinor: number; committedMajor: number;
  launchTcbRaw: bigint;
  /** Signature R and S, converted to big-endian 48-byte scalars (the report stores them little-endian, 72-byte zero-padded). */
  sigR: Uint8Array; sigS: Uint8Array;
  /** bytes 0..0x2A0 */
  signedBytes: Uint8Array;
  raw: Uint8Array;
}

function rev(b: Uint8Array): Uint8Array { const o = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) o[i] = b[b.length - 1 - i]!; return o; }

export function parseSnpReport(raw: Uint8Array): SnpReport {
  if (raw.length !== SNP_REPORT_LEN) throw new Error(`SNP report must be ${SNP_REPORT_LEN} bytes, got ${raw.length}`);
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const u32 = (o: number) => dv.getUint32(o, true);
  const u64 = (o: number) => dv.getBigUint64(o, true);
  const bytes = (o: number, n: number) => raw.slice(o, o + n);
  const version = u32(0x000);
  const sigLE_R = bytes(0x2a0, 72);
  const sigLE_S = bytes(0x2a0 + 72, 72);
  // r and s are little-endian, zero padded to 72 bytes; P-384 scalars are 48 bytes
  const r = rev(sigLE_R).slice(72 - 48);
  const s = rev(sigLE_S).slice(72 - 48);
  return {
    version,
    guestSvn: u32(0x004),
    policy: u64(0x008),
    familyId: bytes(0x010, 16),
    imageId: bytes(0x020, 16),
    vmpl: u32(0x030),
    signatureAlgo: u32(0x034),
    currentTcbRaw: u64(0x038),
    platformInfo: u64(0x040),
    flags: u32(0x048),
    reportData: bytes(0x050, 64),
    measurement: bytes(0x090, 48),
    hostData: bytes(0x0c0, 32),
    idKeyDigest: bytes(0x0e0, 48),
    authorKeyDigest: bytes(0x110, 48),
    reportId: bytes(0x140, 32),
    reportIdMa: bytes(0x160, 32),
    reportedTcbRaw: u64(0x180),
    cpuidFamId: version >= 3 ? raw[0x188]! : 0,
    cpuidModId: version >= 3 ? raw[0x189]! : 0,
    cpuidStep: version >= 3 ? raw[0x18a]! : 0,
    chipId: bytes(0x1a0, 64),
    committedTcbRaw: u64(0x1e0),
    currentBuild: raw[0x1e8]!, currentMinor: raw[0x1e9]!, currentMajor: raw[0x1ea]!,
    committedBuild: raw[0x1ec]!, committedMinor: raw[0x1ed]!, committedMajor: raw[0x1ee]!,
    launchTcbRaw: u64(0x1f0),
    sigR: r, sigS: s,
    signedBytes: raw.slice(0, SNP_SIGNED_LEN),
    raw: raw.slice(),
  };
}

export function policyBit(policy: bigint, bit: bigint): boolean { return ((policy >> bit) & 1n) === 1n; }

/** Human-friendly dump used in check details. */
export function describeReport(r: SnpReport): string {
  return `v${r.version} vmpl=${r.vmpl} policy=0x${r.policy.toString(16)} measurement=${hex.encode(r.measurement)} reported_tcb=0x${r.reportedTcbRaw.toString(16)}`;
}
