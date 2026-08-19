import { describe, expect, test } from "bun:test";
import { b64u, hex, concat, sha256, sha512, u64be, bytesEqual } from "../src/index.ts";

describe("encoding", () => {
  test("b64u round trip, no padding, url alphabet", () => {
    for (let n = 0; n < 40; n++) {
      const b = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 0xff);
      const s = b64u.encode(b);
      expect(s).not.toMatch(/[=+/]/);
      expect(b64u.decode(s)).toEqual(b);
      expect(s).toBe(Buffer.from(b).toString("base64url"));
    }
  });
  test("b64u tolerates padding and standard alphabet", () => {
    expect(b64u.decode("_-8=")).toEqual(new Uint8Array([0xff, 0xef]));
    expect(b64u.decode("/+8")).toEqual(new Uint8Array([0xff, 0xef]));
    expect(() => b64u.decode("a")).toThrow();
    expect(() => b64u.decode("a*bc")).toThrow();
  });
  test("hex", () => {
    expect(hex.encode(new Uint8Array([0, 1, 0xab, 0xff]))).toBe("0001abff");
    expect(hex.decode("0001ABff")).toEqual(new Uint8Array([0, 1, 0xab, 0xff]));
    expect(() => hex.decode("abc")).toThrow();
    expect(() => hex.decode("zz")).toThrow();
  });
  test("sha256/sha512/concat/u64be", async () => {
    expect(hex.encode(await sha256(new Uint8Array(0)))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(hex.encode(await sha512(new Uint8Array(0)))).toBe("cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e");
    expect(concat(new Uint8Array([1]), new Uint8Array([]), new Uint8Array([2, 3]))).toEqual(new Uint8Array([1, 2, 3]));
    expect(hex.encode(u64be(7))).toBe("0000000000000007");
    expect(hex.encode(u64be(2 ** 40 + 1))).toBe("0000010000000001");
    expect(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
  });
});
