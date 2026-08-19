// Simulated attester (dev root). Mirrors what `gpubnbd --simulate` does in Rust:
// same binding, same report_data/gpu_nonce, same measurement convention, so a
// simulated doc made here verifies identically to one made by the runner.
import { x25519 } from "@noble/curves/ed25519";
import { b64u, hex, randomBytes, sha384, utf8 } from "./encoding.ts";
import { computeBinding, gpuNonce, reportData, ZERO_CHALLENGE } from "./binding.ts";
import { hpkeSuite } from "./hpke.ts";
import { DOMAINS, ROOTS, ed25519PublicKey, generateEd25519Seed, signBlob, type SignedBlob } from "./signed.ts";
import type { AttestationDoc, SimulatedReport } from "./schemas.ts";

/** Convention: the golden "measurement" of a simulated runner is SHA384("gpubnb-simulated-" || runner_version), hex. */
export async function simulatedMeasurement(runnerVersion: string): Promise<Uint8Array> {
  return sha384(utf8(`gpubnb-simulated-${runnerVersion}`));
}

export const SIMULATED_HWMODEL = "SIMULATED";

export interface RunnerKeys {
  hpkePriv: Uint8Array; hpkePub: Uint8Array;   // X25519
  signPriv: Uint8Array; signPub: Uint8Array;   // Ed25519 (seed, pub)
  bootNonce: Uint8Array;
}

export async function generateRunnerKeys(): Promise<RunnerKeys> {
  const suite = hpkeSuite();
  const kp = await suite.kem.generateKeyPair();
  const hpkePriv = new Uint8Array(await suite.kem.serializePrivateKey(kp.privateKey));
  const hpkePub = new Uint8Array(await suite.kem.serializePublicKey(kp.publicKey));
  const signPriv = generateEd25519Seed();
  return { hpkePriv, hpkePub, signPriv, signPub: ed25519PublicKey(signPriv), bootNonce: randomBytes(32) };
}

/** Derive the X25519 public key for a 32-byte private scalar (so fixtures can carry only the private half). */
export function hpkePublicKey(hpkePriv: Uint8Array): Uint8Array {
  if (hpkePriv.length !== 32) throw new Error("hpke private key must be 32 bytes");
  return x25519.getPublicKey(hpkePriv);
}

export interface SimulatedDocParams {
  hpkePub: Uint8Array;
  signPub: Uint8Array;
  signPriv: Uint8Array;
  bootNonce: Uint8Array;
  runnerVersion: string;
  model: { id: string; digest: Uint8Array | string; ctx_len?: number };
  challenge?: Uint8Array;            // default all-zero
  measurement?: Uint8Array;          // default simulatedMeasurement(runnerVersion)
  issuedAt?: number;                 // unix seconds, default now
  hwmodel?: string;                  // default "SIMULATED"
  devRootPriv?: Uint8Array;          // default ROOTS.DEV_ROOT_PRIV
  devRootKid?: string;
  cpu?: string; gpu_model?: string;
}

export async function makeSimulatedDoc(p: SimulatedDocParams): Promise<SignedBlob> {
  const challenge = p.challenge ?? ZERO_CHALLENGE;
  const modelDigest = typeof p.model.digest === "string" ? hex.decode(p.model.digest) : p.model.digest;
  const binding = await computeBinding({ hpkePub: p.hpkePub, signPub: p.signPub, bootNonce: p.bootNonce, runnerVersion: p.runnerVersion, modelDigest });
  const rd = await reportData(binding, challenge);
  const gn = await gpuNonce(binding, challenge);
  const issued_at = p.issuedAt ?? Math.floor(Date.now() / 1000);
  const measurement = p.measurement ?? (await simulatedMeasurement(p.runnerVersion));
  const inner: SimulatedReport = { report_data: hex.encode(rd), gpu_nonce: hex.encode(gn), measurement: hex.encode(measurement), hwmodel: p.hwmodel ?? SIMULATED_HWMODEL, issued_at };
  const simulated = await signBlob(inner, p.devRootPriv ?? ROOTS.DEV_ROOT_PRIV, DOMAINS.simulated, p.devRootKid ?? ROOTS.DEV_ROOT_KID);
  const doc: AttestationDoc = {
    // (typed loosely below because zod passthrough types want index signatures)
    v: 1,
    runner_version: p.runnerVersion,
    hpke_pub: b64u.encode(p.hpkePub),
    sign_pub: b64u.encode(p.signPub),
    boot_nonce: b64u.encode(p.bootNonce),
    binding: hex.encode(binding),
    challenge: hex.encode(challenge),
    issued_at,
    model: { id: p.model.id, digest: hex.encode(modelDigest), ...(p.model.ctx_len !== undefined ? { ctx_len: p.model.ctx_len } : {}) },
    platform: { kind: "simulated", cpu: p.cpu ?? "simulated", gpu_model: p.gpu_model ?? "simulated", cc_mode: "simulated" },
    snp: null,
    gpu: null,
    simulated: simulated as AttestationDoc["simulated"],
  };
  return signBlob(doc, p.signPriv, DOMAINS.attdoc);
}
