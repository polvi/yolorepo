// §5 HPKE request envelopes and sealed response frames.
//
// Suite: DHKEM(X25519, HKDF-SHA256) / HKDF-SHA256 / ChaCha20-Poly1305 (0x0020/0x0001/0x0003)
// via hpke-js (@hpke/core + @hpke/dhkem-x25519 + @hpke/chacha20poly1305). Response
// frames use @noble/ciphers ChaCha20-Poly1305 because WebCrypto has no ChaCha.
import { CipherSuite, HkdfSha256 } from "@hpke/core";
import { DhkemX25519HkdfSha256 } from "@hpke/dhkem-x25519";
import { Chacha20Poly1305 } from "@hpke/chacha20poly1305";
import { chacha20poly1305 } from "@noble/ciphers/chacha";
import { b64u, concat, sha256, toBuf, u32be, u64be, utf8, utf8Decode } from "./encoding.ts";
import type { SignedBlob } from "./signed.ts";

export const HPKE_SUITE = { kem: 0x0020, kdf: 0x0001, aead: 0x0003 } as const;
export const INFO_OPEN = "gpubnb-open-v1";
export const INFO_REQ = "gpubnb-req-v1";
export const EXPORT_RESP_KEY = "gpubnb-resp-key-v1";
export const EXPORT_RESP_NONCE = "gpubnb-resp-nonce-v1";
export const FRAME_FLAG_FINAL = 0x01;
/** Hard cap on a single frame's ciphertext, so a malicious peer cannot make us allocate unboundedly. */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

let suiteSingleton: CipherSuite | undefined;
export function hpkeSuite(): CipherSuite {
  return (suiteSingleton ??= new CipherSuite({ kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256(), aead: new Chacha20Poly1305() }));
}

export interface Envelope {
  session_id: string | null; // b64u16 or null for open
  ctr: number;
  enc: string; // b64u32 encapsulated key
  ct: string;  // b64u ciphertext
}

/** What both ends need after sealing/unsealing a request: exporter secrets and the request hash that is AAD for every response frame. */
export interface SealedContext {
  exportKey(): Promise<Uint8Array>;   // resp_key, 32 bytes
  exportNonce(): Promise<Uint8Array>; // resp_base, 12 bytes
  reqHash: Uint8Array;                // SHA256(enc || ct)
}

interface Exporter { export(ctx: ArrayBuffer, len: number): Promise<ArrayBuffer> }

async function makeCtx(exp: Exporter, enc: Uint8Array, ct: Uint8Array): Promise<SealedContext> {
  const reqHash = await sha256(concat(enc, ct));
  return {
    reqHash,
    exportKey: async () => new Uint8Array(await exp.export(toBuf(utf8(EXPORT_RESP_KEY)), 32)),
    exportNonce: async () => new Uint8Array(await exp.export(toBuf(utf8(EXPORT_RESP_NONCE)), 12)),
  };
}

export function requestAad(sessionId: Uint8Array, ctr: number): Uint8Array {
  if (sessionId.length !== 16) throw new Error("session_id must be 16 bytes");
  if (!Number.isSafeInteger(ctr) || ctr < 0) throw new Error("ctr must be a non-negative safe integer");
  return concat(utf8(INFO_REQ), sessionId, u64be(ctr));
}

export interface SealExtras {
  /** Deterministic ephemeral key material (RFC 9180 DeriveKeyPair ikm). Tests/fixtures only; never in production. */
  ekm?: Uint8Array;
}

/** Session open: base mode, info = aad = "gpubnb-open-v1". */
export async function sealOpen(hpkePub: Uint8Array, plaintext: Uint8Array, extras: SealExtras = {}): Promise<{ envelope: Envelope; ctx: SealedContext }> {
  const suite = hpkeSuite();
  const sender = await suite.createSenderContext({
    recipientPublicKey: await suite.kem.deserializePublicKey(toBuf(hpkePub)),
    info: toBuf(utf8(INFO_OPEN)),
    ...(extras.ekm ? { ekm: toBuf(extras.ekm) } : {}),
  });
  const ct = new Uint8Array(await sender.seal(toBuf(plaintext), toBuf(utf8(INFO_OPEN))));
  const enc = new Uint8Array(sender.enc);
  return { envelope: { session_id: null, ctr: 0, enc: b64u.encode(enc), ct: b64u.encode(ct) }, ctx: await makeCtx(sender, enc, ct) };
}

/** Session request: PSK mode (psk = session_key, psk_id = session_id), info = "gpubnb-req-v1", aad = info || session_id || u64be(ctr). */
export async function sealRequest(hpkePub: Uint8Array, sessionId: Uint8Array, sessionKey: Uint8Array, ctr: number, plaintext: Uint8Array, extras: SealExtras = {}): Promise<{ envelope: Envelope; ctx: SealedContext }> {
  if (sessionKey.length !== 32) throw new Error("session_key must be 32 bytes");
  const aad = requestAad(sessionId, ctr);
  const suite = hpkeSuite();
  const sender = await suite.createSenderContext({
    recipientPublicKey: await suite.kem.deserializePublicKey(toBuf(hpkePub)),
    info: toBuf(utf8(INFO_REQ)),
    psk: { id: toBuf(sessionId), key: toBuf(sessionKey) },
    ...(extras.ekm ? { ekm: toBuf(extras.ekm) } : {}),
  });
  const ct = new Uint8Array(await sender.seal(toBuf(plaintext), toBuf(aad)));
  const enc = new Uint8Array(sender.enc);
  return { envelope: { session_id: b64u.encode(sessionId), ctr, enc: b64u.encode(enc), ct: b64u.encode(ct) }, ctx: await makeCtx(sender, enc, ct) };
}

function parseEnvelope(env: Envelope): { enc: Uint8Array; ct: Uint8Array } {
  if (!env || typeof env.enc !== "string" || typeof env.ct !== "string") throw new Error("bad envelope");
  const enc = b64u.decode(env.enc);
  if (enc.length !== 32) throw new Error("bad enc length");
  return { enc, ct: b64u.decode(env.ct) };
}

/** Server side of sealOpen. Throws on decrypt failure. */
export async function unsealOpen(hpkePriv: Uint8Array, env: Envelope): Promise<{ plaintext: Uint8Array; ctx: SealedContext }> {
  if (env.session_id !== null || env.ctr !== 0) throw new Error("open envelope must have session_id null and ctr 0");
  const { enc, ct } = parseEnvelope(env);
  const suite = hpkeSuite();
  const recipient = await suite.createRecipientContext({
    recipientKey: await suite.kem.deserializePrivateKey(toBuf(hpkePriv)),
    enc: toBuf(enc),
    info: toBuf(utf8(INFO_OPEN)),
  });
  const plaintext = new Uint8Array(await recipient.open(toBuf(ct), toBuf(utf8(INFO_OPEN))));
  return { plaintext, ctx: await makeCtx(recipient, enc, ct) };
}

/** Server side of sealRequest. The caller looks up `sessionKey` by env.session_id and enforces the high-water mark on env.ctr. */
export async function unsealRequest(hpkePriv: Uint8Array, sessionKey: Uint8Array, env: Envelope): Promise<{ plaintext: Uint8Array; ctx: SealedContext }> {
  if (typeof env.session_id !== "string") throw new Error("request envelope needs session_id");
  const sessionId = b64u.decode(env.session_id);
  const aad = requestAad(sessionId, env.ctr);
  const { enc, ct } = parseEnvelope(env);
  const suite = hpkeSuite();
  const recipient = await suite.createRecipientContext({
    recipientKey: await suite.kem.deserializePrivateKey(toBuf(hpkePriv)),
    enc: toBuf(enc),
    info: toBuf(utf8(INFO_REQ)),
    psk: { id: toBuf(sessionId), key: toBuf(sessionKey) },
  });
  const plaintext = new Uint8Array(await recipient.open(toBuf(ct), toBuf(aad)));
  return { plaintext, ctx: await makeCtx(recipient, enc, ct) };
}

// ---------------------------------------------------------------------------
// §5.2 Response frames

export function frameNonce(base: Uint8Array, i: number): Uint8Array {
  if (base.length !== 12) throw new Error("nonce base must be 12 bytes");
  if (!Number.isSafeInteger(i) || i < 0) throw new Error("bad frame counter");
  const n = new Uint8Array(base); // copy
  // u96_be(i): counter in the low-order bytes
  let v = BigInt(i);
  for (let k = 11; k >= 4 && v > 0n; k--) { n[k]! ^= Number(v & 0xffn); v >>= 8n; }
  return n;
}

/** Encoder state: one per sealed response. Each `seal` produces `u32be(len) || ct` and bumps the counter. */
export function frameEncoder(ctx: SealedContext): { seal(payload: Uint8Array, final: boolean): Promise<Uint8Array>; readonly count: number } {
  let i = 0;
  let keyP: Promise<[Uint8Array, Uint8Array]> | undefined;
  let done = false;
  return {
    get count() { return i; },
    async seal(payload, final) {
      if (done) throw new Error("frame stream already finalized");
      const [key, base] = await (keyP ??= Promise.all([ctx.exportKey(), ctx.exportNonce()]));
      const pt = concat(new Uint8Array([final ? FRAME_FLAG_FINAL : 0]), payload);
      const ct = chacha20poly1305(key, frameNonce(base, i), ctx.reqHash).encrypt(pt);
      i++;
      if (final) done = true;
      return concat(u32be(ct.length), ct);
    },
  };
}

export interface OpenEvent { t: "open"; session_id: string; session_key: string; subaddress: string; price: { in_per_m: number; out_per_m: number }; offer: SignedBlob }
export interface StatusEvent { t: "status"; balance_piconero: number; credited_piconero: number; pending_piconero: number; subaddress: string; cumulative_debit_piconero: number }
export interface ChunkEvent { t: "chunk"; data: unknown }
export interface ResponseEventData { t: "response"; data: unknown }
export interface ReceiptEvent { t: "receipt"; receipt: SignedBlob }
export interface ErrorEvent { t: "error"; code: "payment_required" | "upstream" | "bad_request" | "busy" | (string & {}); message: string }
export type ResponseEvent = OpenEvent | StatusEvent | ChunkEvent | ResponseEventData | ReceiptEvent | ErrorEvent;

const EVENT_TYPES = new Set(["open", "status", "chunk", "response", "receipt", "error"]);

export class FrameError extends Error {
  constructor(message: string, public readonly frameIndex: number) { super(message); this.name = "FrameError"; }
}

/** Low-level: yields decrypted plaintext payloads (flags stripped) plus the final flag. Throws FrameError on tamper/order/truncation. */
export async function* readRawFrames(ctx: SealedContext, body: ReadableStream<Uint8Array> | Uint8Array): AsyncGenerator<{ payload: Uint8Array; final: boolean; index: number }> {
  const [key, base] = await Promise.all([ctx.exportKey(), ctx.exportNonce()]);
  const reader = body instanceof Uint8Array ? null : body.getReader();
  let buf: Uint8Array = new Uint8Array(0);
  let eof = false;
  if (body instanceof Uint8Array) { buf = body; eof = true; }
  let i = 0;
  let sawFinal = false;
  const pull = async (): Promise<boolean> => {
    if (eof || !reader) return false;
    const { value, done } = await reader.read();
    if (done) { eof = true; return false; }
    if (value && value.length) buf = concat(buf, value);
    return true;
  };
  try {
    for (;;) {
      while (buf.length < 4) { if (!(await pull())) break; }
      if (buf.length === 0 && eof) break;
      if (buf.length < 4) throw new FrameError("truncated frame header", i);
      const len = new DataView(buf.buffer, buf.byteOffset, 4).getUint32(0, false);
      if (len > MAX_FRAME_BYTES) throw new FrameError(`frame too large (${len})`, i);
      if (len < 16 + 1) throw new FrameError("frame too short", i);
      while (buf.length < 4 + len) { if (!(await pull())) break; }
      if (buf.length < 4 + len) throw new FrameError("truncated frame body", i);
      if (sawFinal) throw new FrameError("data after final frame", i);
      const ct = buf.subarray(4, 4 + len);
      buf = buf.subarray(4 + len);
      let pt: Uint8Array;
      try {
        pt = chacha20poly1305(key, frameNonce(base, i), ctx.reqHash).decrypt(ct);
      } catch {
        throw new FrameError("frame authentication failed (tampered, reordered or wrong context)", i);
      }
      const flags = pt[0]!;
      const final = (flags & FRAME_FLAG_FINAL) !== 0;
      if (final) sawFinal = true;
      yield { payload: pt.subarray(1), final, index: i };
      i++;
    }
    if (!sawFinal) throw new FrameError("stream ended without a final frame", i);
  } finally {
    if (reader) { try { reader.releaseLock(); } catch { /* ignore */ } }
  }
}

/** Yields parsed events in order; the generator throws FrameError on any integrity problem and on a missing final frame. */
export async function* readFrames(ctx: SealedContext, body: ReadableStream<Uint8Array> | Uint8Array): AsyncGenerator<ResponseEvent> {
  for await (const f of readRawFrames(ctx, body)) {
    let ev: unknown;
    try { ev = JSON.parse(utf8Decode(f.payload)); } catch { throw new FrameError("frame payload is not JSON", f.index); }
    if (!ev || typeof ev !== "object" || !EVENT_TYPES.has((ev as { t?: unknown }).t as string)) throw new FrameError("unknown event type", f.index);
    yield ev as ResponseEvent;
  }
}

/** Convenience for servers/tests: seal a list of events into one body, the last one marked final. */
export async function encodeEvents(ctx: SealedContext, events: ResponseEvent[]): Promise<Uint8Array> {
  const enc = frameEncoder(ctx);
  const parts: Uint8Array[] = [];
  for (let k = 0; k < events.length; k++) parts.push(await enc.seal(utf8(JSON.stringify(events[k])), k === events.length - 1));
  return concat(...parts);
}
