// §2 Runner identity binding and the two derived nonces.
import { concat, sha256, sha512, utf8 } from "./encoding.ts";

export const ZERO_CHALLENGE: Uint8Array = new Uint8Array(32);

export interface BindingInputs {
  hpkePub: Uint8Array;     // X25519, 32
  signPub: Uint8Array;     // Ed25519, 32
  bootNonce: Uint8Array;   // 32
  runnerVersion: string;
  modelDigest: Uint8Array; // 32 (§8)
}

function need(b: Uint8Array, n: number, what: string) {
  if (b.length !== n) throw new Error(`${what} must be ${n} bytes, got ${b.length}`);
}

/** binding = SHA256("gpubnb-binding-v1" || hpke_pub || sign_pub || boot_nonce || SHA256(utf8(runner_version)) || model_digest) */
export async function computeBinding(p: BindingInputs): Promise<Uint8Array> {
  need(p.hpkePub, 32, "hpke_pub"); need(p.signPub, 32, "sign_pub"); need(p.bootNonce, 32, "boot_nonce"); need(p.modelDigest, 32, "model_digest");
  const rv = await sha256(utf8(p.runnerVersion));
  return sha256(concat(utf8("gpubnb-binding-v1"), p.hpkePub, p.signPub, p.bootNonce, rv, p.modelDigest));
}

/** report_data = SHA512("gpubnb-report-v1" || binding || challenge) → 64 bytes (SNP REPORT_DATA) */
export async function reportData(binding: Uint8Array, challenge: Uint8Array): Promise<Uint8Array> {
  need(binding, 32, "binding"); need(challenge, 32, "challenge");
  return sha512(concat(utf8("gpubnb-report-v1"), binding, challenge));
}

/** gpu_nonce = SHA256("gpubnb-gpu-v1" || binding || challenge) → 32 bytes (GPU attestation nonce, hex on the wire) */
export async function gpuNonce(binding: Uint8Array, challenge: Uint8Array): Promise<Uint8Array> {
  need(binding, 32, "binding"); need(challenge, 32, "challenge");
  return sha256(concat(utf8("gpubnb-gpu-v1"), binding, challenge));
}
