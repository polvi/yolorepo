import { describe, expect, test } from "bun:test";
import {
  sealOpen, sealRequest, unsealOpen, unsealRequest, frameEncoder, frameNonce, readFrames, readRawFrames, encodeEvents, requestAad,
  generateRunnerKeys, hpkePublicKey, hex, utf8, utf8Decode, concat, hpkeSuite, HPKE_SUITE, FrameError,
  type ResponseEvent, type SealedContext,
} from "../src/index.ts";
import { fixture } from "./helpers.ts";

const collect = async (ctx: SealedContext, body: Uint8Array | ReadableStream<Uint8Array>) => { const out: ResponseEvent[] = []; for await (const e of readFrames(ctx, body)) out.push(e); return out; };
const streamOf = (b: Uint8Array, chunk = 7) => new ReadableStream<Uint8Array>({ start(c) { for (let i = 0; i < b.length; i += chunk) c.enqueue(b.slice(i, i + chunk)); c.close(); } });

describe("HPKE (§5)", () => {
  test("suite ids", () => {
    const s = hpkeSuite();
    expect([s.kem.id, s.kdf.id, s.aead.id]).toEqual([HPKE_SUITE.kem, HPKE_SUITE.kdf, HPKE_SUITE.aead]);
  });

  test("open round trip + response frames", async () => {
    const k = await generateRunnerKeys();
    const pt = utf8('{"client_nonce":"AAAA"}');
    const { envelope, ctx } = await sealOpen(k.hpkePub, pt);
    expect(envelope.session_id).toBeNull(); expect(envelope.ctr).toBe(0);
    const srv = await unsealOpen(k.hpkePriv, envelope);
    expect(utf8Decode(srv.plaintext)).toBe(utf8Decode(pt));
    expect(hex.encode(await srv.ctx.exportKey())).toBe(hex.encode(await ctx.exportKey()));
    expect(hex.encode(await srv.ctx.exportNonce())).toBe(hex.encode(await ctx.exportNonce()));
    expect(hex.encode(srv.ctx.reqHash)).toBe(hex.encode(ctx.reqHash));
    const events: ResponseEvent[] = [{ t: "chunk", data: 1 }, { t: "chunk", data: 2 }, { t: "receipt", receipt: { payload: "e30", sig: "AA" } }];
    const body = await encodeEvents(srv.ctx, events);
    expect(await collect(ctx, body)).toEqual(events);
    expect(await collect(ctx, streamOf(body, 3))).toEqual(events);
  });

  test("request round trip, PSK binding, aad binds session_id + ctr", async () => {
    const k = await generateRunnerKeys();
    const sid = new Uint8Array(16).fill(9), key = new Uint8Array(32).fill(8);
    const { envelope, ctx } = await sealRequest(k.hpkePub, sid, key, 5, utf8("{}"));
    expect(envelope.ctr).toBe(5);
    const srv = await unsealRequest(k.hpkePriv, key, envelope);
    expect(utf8Decode(srv.plaintext)).toBe("{}");
    expect(hex.encode(await srv.ctx.exportKey())).toBe(hex.encode(await ctx.exportKey()));
    // wrong psk
    await expect(unsealRequest(k.hpkePriv, new Uint8Array(32).fill(1), envelope)).rejects.toThrow();
    // ctr altered in transit (aad mismatch)
    await expect(unsealRequest(k.hpkePriv, key, { ...envelope, ctr: 6 })).rejects.toThrow();
    // wrong recipient key
    const k2 = await generateRunnerKeys();
    await expect(unsealRequest(k2.hpkePriv, key, envelope)).rejects.toThrow();
    // open envelope cannot be unsealed as a request and vice versa
    await expect(unsealOpen(k.hpkePriv, envelope)).rejects.toThrow();
  });

  test("frames: tamper, reorder, truncation, missing final, data after final", async () => {
    const ctx: SealedContext = { exportKey: async () => new Uint8Array(32).fill(1), exportNonce: async () => new Uint8Array(12).fill(2), reqHash: new Uint8Array(32).fill(3) };
    const enc = frameEncoder(ctx);
    const f0 = await enc.seal(utf8('{"t":"chunk","data":0}'), false);
    const f1 = await enc.seal(utf8('{"t":"chunk","data":1}'), false);
    const f2 = await enc.seal(utf8('{"t":"receipt","receipt":{"payload":"e30","sig":"AA"}}'), true);
    await expect(enc.seal(utf8("x"), true)).rejects.toThrow();
    expect((await collect(ctx, concat(f0, f1, f2))).length).toBe(3);
    const tampered = concat(f0, f1, f2); tampered[10]! ^= 1;
    await expect(collect(ctx, tampered)).rejects.toBeInstanceOf(FrameError);
    await expect(collect(ctx, concat(f1, f0, f2))).rejects.toThrow(/authentication/);
    await expect(collect(ctx, concat(f0, f1))).rejects.toThrow(/final/);
    await expect(collect(ctx, concat(f0, f1, f2.slice(0, -1)))).rejects.toThrow(/truncated/);
    await expect(collect(ctx, concat(f0, f2, f1))).rejects.toThrow(); // f1 would be index 2 → auth fail (also data after final)
    await expect(collect(ctx, concat(f0, f1, f2, f2))).rejects.toThrow(/after final/);
    // wrong aad (req hash) → fail
    await expect(collect({ ...ctx, reqHash: new Uint8Array(32).fill(4) }, concat(f0, f1, f2))).rejects.toThrow();
    // non-JSON payload rejected
    const enc2 = frameEncoder(ctx);
    const bad = await enc2.seal(utf8("not json"), true);
    await expect(collect(ctx, bad)).rejects.toThrow(/JSON/);
    // empty body: no final frame
    await expect(collect(ctx, new Uint8Array(0))).rejects.toThrow(/final/);
  });

  test("frame nonce = base XOR u96be(i)", () => {
    const base = hex.decode("ffffffffffffffffffffffff");
    expect(hex.encode(frameNonce(base, 0))).toBe("ffffffffffffffffffffffff");
    expect(hex.encode(frameNonce(base, 1))).toBe("fffffffffffffffffffffffe");
    expect(hex.encode(frameNonce(base, 256))).toBe("fffffffffffffffffffffeff");
    expect(hex.encode(frameNonce(new Uint8Array(12), 0x01020304))).toBe("000000000000000001020304");
  });

  test("requestAad layout", () => {
    const sid = new Uint8Array(16).fill(0xab);
    expect(hex.encode(requestAad(sid, 7))).toBe(hex.encode(utf8("gpubnb-req-v1")) + "ab".repeat(16) + "0000000000000007");
  });

  describe("fixtures", () => {
    test("hpke-open.json: deterministic with ekm, server unseals, frames reproduce", async () => {
      const f = fixture("hpke-open.json");
      const priv = hex.decode(f.recipient_priv);
      expect(hex.encode(hpkePublicKey(priv))).toBe(f.recipient_pub);
      const { envelope } = await sealOpen(hpkePublicKey(priv), hex.decode(f.plaintext_hex), { ekm: hex.decode(f.ekm) });
      expect(envelope).toEqual(f.envelope);
      const srv = await unsealOpen(priv, f.envelope);
      expect(hex.encode(srv.plaintext)).toBe(f.plaintext_hex);
      expect(hex.encode(await srv.ctx.exportKey())).toBe(f.response.resp_key);
      expect(hex.encode(await srv.ctx.exportNonce())).toBe(f.response.resp_nonce_base);
      expect(hex.encode(srv.ctx.reqHash)).toBe(f.response.req_hash);
      const enc = frameEncoder(srv.ctx);
      for (const fr of f.response.frames) expect(hex.encode(await enc.seal(utf8(fr.payload_json), fr.final))).toBe(fr.frame_hex);
      const events = await collect(srv.ctx, hex.decode(f.response.body_hex));
      expect(events.map((e) => JSON.stringify(e))).toEqual(f.response.frames.map((fr: any) => fr.payload_json));
    });
    test("hpke-request.json", async () => {
      const f = fixture("hpke-request.json");
      const priv = hex.decode(f.recipient_priv);
      const { envelope } = await sealRequest(hpkePublicKey(priv), hex.decode(f.session_id), hex.decode(f.session_key), f.ctr, hex.decode(f.plaintext_hex), { ekm: hex.decode(f.ekm) });
      expect(envelope).toEqual(f.envelope);
      expect(hex.encode(requestAad(hex.decode(f.session_id), f.ctr))).toBe(f.aad_hex);
      const srv = await unsealRequest(priv, hex.decode(f.session_key), f.envelope);
      expect(hex.encode(srv.plaintext)).toBe(f.plaintext_hex);
      expect(hex.encode(await srv.ctx.exportKey())).toBe(f.response.resp_key);
      expect(hex.encode(await srv.ctx.exportNonce())).toBe(f.response.resp_nonce_base);
      const enc = frameEncoder(srv.ctx);
      for (const fr of f.response.frames) expect(hex.encode(await enc.seal(utf8(fr.payload_json), fr.final))).toBe(fr.frame_hex);
      // client side decodes the body
      const { ctx } = await sealRequest(hpkePublicKey(priv), hex.decode(f.session_id), hex.decode(f.session_key), f.ctr, hex.decode(f.plaintext_hex), { ekm: hex.decode(f.ekm) });
      expect((await collect(ctx, hex.decode(f.response.body_hex))).length).toBe(f.response.frames.length);
    });
    test("frames.json", async () => {
      const f = fixture("frames.json");
      const ctx: SealedContext = { exportKey: async () => hex.decode(f.resp_key), exportNonce: async () => hex.decode(f.resp_nonce_base), reqHash: hex.decode(f.req_hash) };
      const enc = frameEncoder(ctx);
      for (const fr of f.frames) {
        expect(hex.encode(frameNonce(hex.decode(f.resp_nonce_base), fr.index))).toBe(fr.nonce);
        expect(hex.encode(await enc.seal(utf8(fr.payload_json), fr.final))).toBe(fr.frame_hex);
      }
      for (const n of f.nonce_examples) expect(hex.encode(frameNonce(hex.decode(f.resp_nonce_base), n.i))).toBe(n.nonce);
      const raw: string[] = [];
      for await (const r of readRawFrames(ctx, hex.decode(f.body_hex))) raw.push(utf8Decode(r.payload));
      expect(raw).toEqual(f.frames.map((fr: any) => fr.payload_json));
      await expect(collect(ctx, hex.decode(f.tampered_body_hex))).rejects.toThrow();
      await expect(collect(ctx, hex.decode(f.truncated_body_hex))).rejects.toThrow(/final/);
    });
  });
});
