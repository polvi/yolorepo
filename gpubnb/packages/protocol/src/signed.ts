// §1 Signed blobs: { payload: b64u(JSON bytes), sig: b64u(Ed25519(DOMAIN || payload_bytes)), kid? }
// Ed25519 via @noble/curves (pure TS, identical behaviour in bun, browsers and Workers;
// WebCrypto Ed25519 is still uneven across runtimes).
import { ed25519 } from "@noble/curves/ed25519";
import { b64u, concat, utf8, utf8Decode } from "./encoding.ts";

export interface SignedBlob {
  payload: string;
  sig: string;
  kid?: string;
}

export const DOMAINS = {
  attdoc: "gpubnb-attdoc-v1",
  offer: "gpubnb-offer-v1",
  receipt: "gpubnb-receipt-v1",
  golden: "gpubnb-golden-v1",
  models: "gpubnb-models-v1",
  simulated: "gpubnb-simulated-v1",
} as const;
export type Domain = (typeof DOMAINS)[keyof typeof DOMAINS];

export const ROOTS = {
  OFFLINE_ROOT_KID: "gpubnb-root-2026" as const,
  /** Offline root (signs golden + models). Private half lives outside the repo. */
  OFFLINE_ROOT_PUB: b64u.decode("vDTaTKbOIk2FAGfIMYwICVyEHkSQq4RBEe4WOCgwb04"),
  DEV_ROOT_KID: "gpubnb-dev-root" as const,
  /** Dev root: anything it signs is `simulated`, never `verified`. Public knowledge, checked in on purpose. */
  DEV_ROOT_PUB: b64u.decode("ymOF_JrpoPhtWQ3ddhLxQ2ElP4IvWU42GJ5Y98FK4bk"),
  DEV_ROOT_PRIV: b64u.decode("dV0ywEoe20SjGM__t7x94B9I7NWqws9oILxmNOXy9G0"),
};

export function ed25519PublicKey(seed: Uint8Array): Uint8Array {
  if (seed.length !== 32) throw new Error("ed25519 seed must be 32 bytes");
  return ed25519.getPublicKey(seed);
}

export function ed25519Sign(msg: Uint8Array, seed: Uint8Array): Uint8Array {
  return ed25519.sign(msg, seed);
}

export function ed25519Verify(sig: Uint8Array, msg: Uint8Array, pub: Uint8Array): boolean {
  try {
    if (sig.length !== 64 || pub.length !== 32) return false;
    return ed25519.verify(sig, msg, pub, { zip215: false });
  } catch {
    return false;
  }
}

export function generateEd25519Seed(): Uint8Array {
  return ed25519.utils.randomPrivateKey();
}

export async function signBlob(payload: unknown, privKey: Uint8Array, domain: string, kid?: string): Promise<SignedBlob> {
  const payloadBytes = typeof payload === "string" ? utf8(payload) : utf8(JSON.stringify(payload));
  const sig = ed25519Sign(concat(utf8(domain), payloadBytes), privKey);
  const blob: SignedBlob = { payload: b64u.encode(payloadBytes), sig: b64u.encode(sig) };
  if (kid !== undefined) blob.kid = kid;
  return blob;
}

/** Returns the parsed payload, or null when the signature does not verify (or the payload is not JSON). */
export async function verifyBlob<T = unknown>(blob: SignedBlob, pubKey: Uint8Array, domain: string): Promise<T | null> {
  let payloadBytes: Uint8Array, sig: Uint8Array;
  try {
    if (!blob || typeof blob.payload !== "string" || typeof blob.sig !== "string") return null;
    payloadBytes = b64u.decode(blob.payload);
    sig = b64u.decode(blob.sig);
  } catch {
    return null;
  }
  if (!ed25519Verify(sig, concat(utf8(domain), payloadBytes), pubKey)) return null;
  try {
    return JSON.parse(utf8Decode(payloadBytes)) as T;
  } catch {
    return null;
  }
}

/** Decode a blob's payload WITHOUT verifying. Only for peeking at `sign_pub` etc. before the check. */
export function peekBlob<T = unknown>(blob: SignedBlob): T | null {
  try {
    return JSON.parse(utf8Decode(b64u.decode(blob.payload))) as T;
  } catch {
    return null;
  }
}
