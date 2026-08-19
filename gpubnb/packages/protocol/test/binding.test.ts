import { describe, expect, test } from "bun:test";
import { computeBinding, reportData, gpuNonce, hex, ZERO_CHALLENGE, sha256, utf8 } from "../src/index.ts";
import { fixture } from "./helpers.ts";

describe("binding (§2)", () => {
  test("fixture vectors", async () => {
    const f = fixture("binding.json");
    const i = f.inputs;
    const binding = await computeBinding({ hpkePub: hex.decode(i.hpke_pub), signPub: hex.decode(i.sign_pub), bootNonce: hex.decode(i.boot_nonce), runnerVersion: i.runner_version, modelDigest: hex.decode(i.model_digest) });
    expect(hex.encode(await sha256(utf8(i.runner_version)))).toBe(f.runner_version_sha256);
    for (const v of f.vectors) {
      expect(hex.encode(binding)).toBe(v.binding);
      const ch = hex.decode(v.challenge);
      expect(hex.encode(await reportData(binding, ch))).toBe(v.report_data);
      expect(hex.encode(await gpuNonce(binding, ch))).toBe(v.gpu_nonce);
    }
    expect((await reportData(binding, ZERO_CHALLENGE)).length).toBe(64);
    expect((await gpuNonce(binding, ZERO_CHALLENGE)).length).toBe(32);
  });
  test("length checks", async () => {
    const z = new Uint8Array(32);
    await expect(computeBinding({ hpkePub: new Uint8Array(31), signPub: z, bootNonce: z, runnerVersion: "x", modelDigest: z })).rejects.toThrow();
    await expect(reportData(z, new Uint8Array(16))).rejects.toThrow();
  });
  test("runner_version is hashed, so different versions differ and no length ambiguity", async () => {
    const z = new Uint8Array(32);
    const a = await computeBinding({ hpkePub: z, signPub: z, bootNonce: z, runnerVersion: "0.1.0", modelDigest: z });
    const b = await computeBinding({ hpkePub: z, signPub: z, bootNonce: z, runnerVersion: "0.1.1", modelDigest: z });
    expect(hex.encode(a)).not.toBe(hex.encode(b));
  });
});
