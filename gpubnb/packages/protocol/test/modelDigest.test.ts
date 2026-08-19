import { describe, expect, test } from "bun:test";
import { modelDigestFromEntries, hex } from "../src/index.ts";
import { fixture } from "./helpers.ts";

describe("model digest (§8)", () => {
  test("fixture vector, order independent", async () => {
    const f = fixture("model-digest.json");
    const entries = f.entries.map((e: any) => ({ path: e.path, sha256: hex.decode(e.sha256) }));
    expect(hex.encode(await modelDigestFromEntries(entries))).toBe(f.digest);
    expect(hex.encode(await modelDigestFromEntries([...entries].reverse()))).toBe(f.digest);
    expect(hex.encode(await modelDigestFromEntries([]))).toBe(f.empty_digest);
  });
  test("rejects duplicates, NUL in path, bad hash length", async () => {
    const h = new Uint8Array(32);
    await expect(modelDigestFromEntries([{ path: "a", sha256: h }, { path: "a", sha256: h }])).rejects.toThrow();
    await expect(modelDigestFromEntries([{ path: "a\0b", sha256: h }])).rejects.toThrow();
    await expect(modelDigestFromEntries([{ path: "a", sha256: new Uint8Array(31) }])).rejects.toThrow();
  });
});
