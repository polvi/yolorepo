// Cross-implementation check: vectors PRODUCED BY THE RUST RUNNER (fixtures/runner/*.json)
// must verify/reproduce under the TS implementation. Skipped when that directory is absent.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  b64u, hex, utf8, utf8Decode, computeBinding, reportData, gpuNonce, simulatedMeasurement, signBlob, verifyBlob, ed25519PublicKey,
  unsealOpen, unsealRequest, frameEncoder, readRawFrames, modelDigestFromEntries, sha256, verifyAttestationDoc, verifyGolden, GOLDEN_BLOB, hpkePublicKey,
  type SealedContext, type SignedBlob, type Envelope,
} from "../src/index.ts";

const DIR = new URL("../../../fixtures/runner/", import.meta.url).pathname;
const has = (f: string) => existsSync(join(DIR, f));
const load = (f: string) => JSON.parse(readFileSync(join(DIR, f), "utf8"));
const d = (f: string) => (has(f) ? describe : describe.skip);

d("binding.json")("runner fixtures: binding", () => {
  test("vectors", async () => {
    for (const v of load("binding.json").vectors) {
      const binding = await computeBinding({ hpkePub: b64u.decode(v.hpke_pub), signPub: b64u.decode(v.sign_pub), bootNonce: b64u.decode(v.boot_nonce), runnerVersion: v.runner_version, modelDigest: hex.decode(v.model_digest) });
      expect(hex.encode(binding)).toBe(v.binding);
      expect(hex.encode(await reportData(binding, hex.decode(v.challenge)))).toBe(v.report_data);
      expect(hex.encode(await gpuNonce(binding, hex.decode(v.challenge)))).toBe(v.gpu_nonce);
      expect(hex.encode(await simulatedMeasurement(v.runner_version))).toBe(v.simulated_measurement);
    }
  });
});

d("signed-blob.json")("runner fixtures: signed blobs", () => {
  test("verify + byte-identical re-sign (Ed25519 is deterministic)", async () => {
    for (const v of load("signed-blob.json").vectors) {
      const seed = b64u.decode(v.seed);
      expect(b64u.encode(ed25519PublicKey(seed))).toBe(v.pub);
      expect(await verifyBlob<unknown>(v.blob, b64u.decode(v.pub), v.domain)).toEqual(JSON.parse(v.payload_json));
      expect(utf8Decode(b64u.decode(v.blob.payload))).toBe(v.payload_json);
      const again = await signBlob(v.payload_json, seed, v.domain, v.kid ?? undefined);
      expect(again.sig).toBe(v.blob.sig);
      expect(again.payload).toBe(v.blob.payload);
    }
  });
});

d("hpke-envelope.json")("runner fixtures: HPKE envelopes sealed by Rust", () => {
  test("TS unseals, exporter secrets and req_hash agree", async () => {
    const f = load("hpke-envelope.json");
    const sk = b64u.decode(f.recipient_sk);
    expect(b64u.encode(hpkePublicKey(sk))).toBe(f.recipient_pub);
    for (const v of f.vectors) {
      const env = v.envelope as Envelope;
      const r = v.mode === "open" ? await unsealOpen(sk, env) : await unsealRequest(sk, b64u.decode(v.session_key), env);
      expect(utf8Decode(r.plaintext)).toBe(v.plaintext);
      expect(hex.encode(await r.ctx.exportKey())).toBe(v.resp_key);
      expect(hex.encode(await r.ctx.exportNonce())).toBe(v.resp_base);
      expect(hex.encode(r.ctx.reqHash)).toBe(v.req_hash);
      if (v.mode === "psk") await expect(unsealRequest(sk, new Uint8Array(32), env)).rejects.toThrow();
    }
  });
});

d("frames.json")("runner fixtures: frames", () => {
  test("TS reproduces Rust frames byte-for-byte and decodes the stream", async () => {
    for (const v of load("frames.json").vectors) {
      const ctx: SealedContext = { exportKey: async () => hex.decode(v.resp_key), exportNonce: async () => hex.decode(v.resp_base), reqHash: hex.decode(v.req_hash) };
      const enc = frameEncoder(ctx);
      for (const fr of v.frames) expect(hex.encode(await enc.seal(utf8(fr.payload), fr.final))).toBe(fr.frame);
      const got: string[] = [];
      for await (const r of readRawFrames(ctx, hex.decode(v.stream))) got.push(utf8Decode(r.payload));
      expect(got).toEqual(v.frames.map((fr: any) => fr.payload));
    }
  });
});

d("model-digest.json")("runner fixtures: model digest", () => {
  test("entries and files", async () => {
    const f = load("model-digest.json");
    const entries = f.entries.map((e: any) => ({ path: e.path, sha256: hex.decode(e.sha256) }));
    expect(hex.encode(await modelDigestFromEntries(entries))).toBe(f.digest);
    if (f.files) {
      // when file contents are given, hash them ourselves and expect the same per-entry hashes to appear
      for (const file of f.files) {
        const h = hex.encode(await sha256(b64u.decode(file.content_b64u)));
        const e = f.entries.find((x: any) => x.path === file.path);
        if (e) expect(e.sha256).toBe(h);
      }
    }
  });
});

d("simulated-doc.json")("runner fixtures: simulated docs", () => {
  test("verify as simulated under the shipped golden set; recomputed inputs match", async () => {
    const f = load("simulated-doc.json");
    const golden = await verifyGolden(GOLDEN_BLOB);
    expect(hex.encode(await simulatedMeasurement(f.runner_version))).toBe(f.simulated_measurement);
    const signPub = ed25519PublicKey(b64u.decode(f.sign_seed));
    const hpkePub = hpkePublicKey(b64u.decode(f.hpke_sk));
    for (const dd of f.docs) {
      const blob = dd.blob as SignedBlob;
      const v = await verifyAttestationDoc(blob, { golden, allowSimulated: true, now: f.issued_at * 1000, expectedChallenge: hex.decode(dd.challenge) });
      expect({ status: v.status, failed: v.checks.filter((c) => !c.ok).map((c) => c.id) }).toEqual({ status: f.expected_status ?? "simulated", failed: [] });
      expect(v.doc!.sign_pub).toBe(b64u.encode(signPub));
      expect(v.doc!.hpke_pub).toBe(b64u.encode(hpkePub));
      // and it is rejected without allowSimulated, and with the wrong challenge
      expect((await verifyAttestationDoc(blob, { golden, now: f.issued_at * 1000 })).status).toBe("failed");
      expect((await verifyAttestationDoc(blob, { golden, allowSimulated: true, now: f.issued_at * 1000, expectedChallenge: new Uint8Array(32).fill(0xee) })).status).toBe("failed");
    }
  });
});
