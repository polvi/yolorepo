// Byte/string helpers shared by every module. All binary JSON fields in the
// protocol are base64url without padding; human-read digests are lowercase hex.

const B64U_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function b64uEncode(b: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < b.length; i += 3) {
    const n = (b[i]! << 16) | (b[i + 1]! << 8) | b[i + 2]!;
    out += B64U_ALPHABET[(n >> 18) & 63]! + B64U_ALPHABET[(n >> 12) & 63]! + B64U_ALPHABET[(n >> 6) & 63]! + B64U_ALPHABET[n & 63]!;
  }
  if (i < b.length) {
    const rem = b.length - i;
    const n = (b[i]! << 16) | (rem === 2 ? b[i + 1]! << 8 : 0);
    out += B64U_ALPHABET[(n >> 18) & 63]! + B64U_ALPHABET[(n >> 12) & 63]!;
    if (rem === 2) out += B64U_ALPHABET[(n >> 6) & 63]!;
  }
  return out;
}

const B64U_LOOKUP: Int16Array = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64U_ALPHABET.length; i++) t[B64U_ALPHABET.charCodeAt(i)] = i;
  // tolerate standard base64 too, so blobs pasted from elsewhere still decode
  t["+".charCodeAt(0)] = 62;
  t["/".charCodeAt(0)] = 63;
  return t;
})();

function b64uDecode(s: string): Uint8Array {
  s = s.replace(/=+$/, "");
  if (s.length % 4 === 1) throw new Error("b64u: bad length");
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let o = 0;
  let i = 0;
  for (; i + 3 < s.length; i += 4) {
    const a = B64U_LOOKUP[s.charCodeAt(i)]!, b = B64U_LOOKUP[s.charCodeAt(i + 1)]!, c = B64U_LOOKUP[s.charCodeAt(i + 2)]!, d = B64U_LOOKUP[s.charCodeAt(i + 3)]!;
    if ((a | b | c | d) < 0) throw new Error("b64u: bad char");
    const n = (a << 18) | (b << 12) | (c << 6) | d;
    out[o++] = (n >> 16) & 255; out[o++] = (n >> 8) & 255; out[o++] = n & 255;
  }
  const rem = s.length - i;
  if (rem >= 2) {
    const a = B64U_LOOKUP[s.charCodeAt(i)]!, b = B64U_LOOKUP[s.charCodeAt(i + 1)]!;
    const c = rem === 3 ? B64U_LOOKUP[s.charCodeAt(i + 2)]! : 0;
    if ((a | b | c) < 0) throw new Error("b64u: bad char");
    const n = (a << 18) | (b << 12) | (c << 6);
    out[o++] = (n >> 16) & 255;
    if (rem === 3) out[o++] = (n >> 8) & 255;
  }
  return out.subarray(0, o);
}

export const b64u = { encode: b64uEncode, decode: b64uDecode };

export const hex = {
  encode(b: Uint8Array): string {
    let s = "";
    for (let i = 0; i < b.length; i++) s += b[i]!.toString(16).padStart(2, "0");
    return s;
  },
  decode(s: string): Uint8Array {
    if (s.length % 2 !== 0 || /[^0-9a-fA-F]/.test(s)) throw new Error("hex: malformed");
    const out = new Uint8Array(s.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
    return out;
  },
};

export function concat(...parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function utf8(s: string): Uint8Array { return new TextEncoder().encode(s); }
export function utf8Decode(b: Uint8Array): string { return new TextDecoder().decode(b); }

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}

/** Copy into a fresh ArrayBuffer-backed view (WebCrypto dislikes SharedArrayBuffer / offset views in some runtimes). */
export function toBuf(b: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(b.byteLength);
  new Uint8Array(out).set(b);
  return out;
}

async function digest(alg: "SHA-256" | "SHA-384" | "SHA-512", b: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest(alg, toBuf(b)));
}
export const sha256 = (b: Uint8Array) => digest("SHA-256", b);
export const sha384 = (b: Uint8Array) => digest("SHA-384", b);
export const sha512 = (b: Uint8Array) => digest("SHA-512", b);

export function u64be(n: number | bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(n), false);
  return out;
}
export function u32be(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n, false);
  return out;
}
export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}
