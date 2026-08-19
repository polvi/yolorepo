import { describe, expect, test } from "bun:test";
import { signBlob, verifyBlob, DOMAINS, ROOTS, ed25519PublicKey, b64u, hex, generateEd25519Seed, peekBlob } from "../src/index.ts";
import { fixture } from "./helpers.ts";

describe("signed blobs (§1)", () => {
  test("dev root private half matches the pinned public key", () => {
    expect(b64u.encode(ed25519PublicKey(ROOTS.DEV_ROOT_PRIV))).toBe(b64u.encode(ROOTS.DEV_ROOT_PUB));
  });
  test("sign → verify, domain separation, tamper", async () => {
    const seed = generateEd25519Seed();
    const pub = ed25519PublicKey(seed);
    const blob = await signBlob({ a: 1 }, seed, DOMAINS.offer, "k1");
    expect(blob.kid).toBe("k1");
    expect(await verifyBlob<unknown>(blob, pub, DOMAINS.offer)).toEqual({ a: 1 });
    expect(await verifyBlob(blob, pub, DOMAINS.receipt)).toBeNull();
    expect(await verifyBlob({ ...blob, sig: blob.sig.slice(0, -2) + "AA" }, pub, DOMAINS.offer)).toBeNull();
    expect(await verifyBlob(blob, ed25519PublicKey(generateEd25519Seed()), DOMAINS.offer)).toBeNull();
    expect(await verifyBlob({ payload: "!!", sig: blob.sig }, pub, DOMAINS.offer)).toBeNull();
    expect(peekBlob<unknown>(blob)).toEqual({ a: 1 });
  });
  test("payload bytes are exactly what was signed (no canonicalization)", async () => {
    const seed = generateEd25519Seed();
    const blob = await signBlob('{"b":1, "a":2}', seed, DOMAINS.golden);
    expect(Buffer.from(b64u.decode(blob.payload)).toString()).toBe('{"b":1, "a":2}');
    expect(await verifyBlob<unknown>(blob, ed25519PublicKey(seed), DOMAINS.golden)).toEqual({ b: 1, a: 2 });
  });
  test("fixture vectors", async () => {
    const f = fixture("signed-blob.json");
    const seed = hex.decode(f.seed), pub = hex.decode(f.pub);
    expect(hex.encode(ed25519PublicKey(seed))).toBe(f.pub);
    for (const v of f.vectors) {
      const again = await signBlob(JSON.parse(f.payload_json), seed, v.domain, v.kid);
      expect(again).toEqual(v.blob);
      expect(await verifyBlob(v.blob, pub, v.domain)).toEqual(JSON.parse(f.payload_json));
    }
    for (const n of f.negative) expect((await verifyBlob(n.blob, pub, n.domain)) !== null).toBe(n.expect);
  });
});
