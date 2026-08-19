// Generates gpubnb/fixtures/protocol/*.json — shared test vectors for the TS and
// Rust implementations. Everything is deterministic: fixed seeds, fixed HPKE
// ephemeral key material (RFC 9180 DeriveKeyPair ikm), fixed timestamps.
//   bun scripts/gen-fixtures.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  b64u, hex, utf8, utf8Decode, sha256, concat,
  signBlob, DOMAINS, ROOTS, ed25519PublicKey,
  computeBinding, reportData, gpuNonce,
  sealOpen, sealRequest, unsealOpen, unsealRequest, frameEncoder, frameNonce, requestAad, readRawFrames,
  modelDigestFromEntries, makeSimulatedDoc, hpkePublicKey, simulatedMeasurement, verifyAttestationDoc, verifyGolden,
  GOLDEN_BLOB, INFO_OPEN, INFO_REQ, EXPORT_RESP_KEY, EXPORT_RESP_NONCE,
  type ResponseEvent, type SealedContext,
} from "../src/index.ts";

const out = new URL("../../../fixtures/protocol/", import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const write = (name: string, obj: unknown) => { writeFileSync(join(out, name), JSON.stringify(obj, null, 2) + "\n"); console.log("wrote", name); };
const fill = (n: number, v: number) => new Uint8Array(n).fill(v);
const seq = (n: number, start = 0) => Uint8Array.from({ length: n }, (_, i) => (start + i) & 0xff);

// --- keys (fixed) ---
const hpkePriv = hex.decode("7f3c1a5e9b2d4c6f8a0e1d3b5c7a9f2e4d6c8b0a1f3e5d7c9b2a4f6e8d0c1b3a");
const hpkePub = hpkePublicKey(hpkePriv);
const signPriv = hex.decode("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
const signPub = ed25519PublicKey(signPriv);
const bootNonce = seq(32, 0x40);
const runnerVersion = "0.1.0";
const modelDigest = hex.decode("a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90");
const challenge = seq(32, 0x80);
const zero = new Uint8Array(32);

// --- binding.json ---
{
  const binding = await computeBinding({ hpkePub, signPub, bootNonce, runnerVersion, modelDigest });
  const vec = async (ch: Uint8Array) => ({
    challenge: hex.encode(ch),
    binding: hex.encode(binding),
    report_data: hex.encode(await reportData(binding, ch)),
    gpu_nonce: hex.encode(await gpuNonce(binding, ch)),
  });
  write("binding.json", {
    _doc: "PROTOCOL.md §2. binding = SHA256('gpubnb-binding-v1' || hpke_pub || sign_pub || boot_nonce || SHA256(utf8(runner_version)) || model_digest); report_data = SHA512('gpubnb-report-v1' || binding || challenge); gpu_nonce = SHA256('gpubnb-gpu-v1' || binding || challenge). All hex.",
    inputs: { hpke_pub: hex.encode(hpkePub), sign_pub: hex.encode(signPub), boot_nonce: hex.encode(bootNonce), runner_version: runnerVersion, model_digest: hex.encode(modelDigest) },
    runner_version_sha256: hex.encode(await sha256(utf8(runnerVersion))),
    vectors: [await vec(zero), await vec(challenge)],
  });
}

// --- signed-blob.json ---
{
  const payload = { hello: "gpubnb", n: 1, nested: { a: [1, 2, 3] } };
  const blob = await signBlob(payload, signPriv, DOMAINS.offer, "test-kid");
  const blobNoKid = await signBlob(payload, signPriv, DOMAINS.receipt);
  write("signed-blob.json", {
    _doc: "PROTOCOL.md §1. sig = Ed25519(seed, utf8(domain) || payload_bytes); payload is b64u(payload_bytes). payload_bytes here are exactly utf8(payload_json).",
    seed: hex.encode(signPriv),
    pub: hex.encode(signPub),
    payload_json: JSON.stringify(payload),
    vectors: [
      { domain: DOMAINS.offer, kid: "test-kid", blob },
      { domain: DOMAINS.receipt, blob: blobNoKid },
    ],
    negative: [
      { _doc: "same blob verified under the wrong domain must fail", domain: DOMAINS.receipt, blob, expect: false },
      { _doc: "one flipped payload char must fail", domain: DOMAINS.offer, blob: { ...blob, payload: blob.payload.slice(0, -1) + (blob.payload.endsWith("A") ? "B" : "A") }, expect: false },
    ],
    dev_root: { kid: ROOTS.DEV_ROOT_KID, pub_b64u: b64u.encode(ROOTS.DEV_ROOT_PUB), priv_b64u: b64u.encode(ROOTS.DEV_ROOT_PRIV) },
    offline_root: { kid: ROOTS.OFFLINE_ROOT_KID, pub_b64u: b64u.encode(ROOTS.OFFLINE_ROOT_PUB) },
  });
}

// --- HPKE helpers ---
async function frameVectors(ctx: SealedContext, events: ResponseEvent[]) {
  const key = await ctx.exportKey(), base = await ctx.exportNonce();
  const enc = frameEncoder(ctx);
  const frames: unknown[] = [];
  const parts: Uint8Array[] = [];
  for (let i = 0; i < events.length; i++) {
    const payload = utf8(JSON.stringify(events[i]));
    const final = i === events.length - 1;
    const f = await enc.seal(payload, final);
    parts.push(f);
    frames.push({ index: i, final, nonce: hex.encode(frameNonce(base, i)), payload_json: utf8Decode(payload), frame_hex: hex.encode(f) });
  }
  return { resp_key: hex.encode(key), resp_nonce_base: hex.encode(base), req_hash: hex.encode(ctx.reqHash), frames, body_hex: hex.encode(concat(...parts)) };
}

// --- hpke-open.json ---
{
  const ekm = fill(32, 0x11);
  const pt = utf8(JSON.stringify({ client_nonce: b64u.encode(seq(32, 0xa0)) }));
  const { envelope, ctx } = await sealOpen(hpkePub, pt, { ekm });
  const srv = await unsealOpen(hpkePriv, envelope);
  if (utf8Decode(srv.plaintext) !== utf8Decode(pt)) throw new Error("open roundtrip");
  const offer = await signBlob({ session_id: b64u.encode(seq(16, 0x10)), subaddress: "5SIMULATED", price: { in_per_m: 1000, out_per_m: 2000 }, hpke_pub: b64u.encode(hpkePub), created_at: 1755600000, expires_at: 1755686400 }, signPriv, DOMAINS.offer);
  const events: ResponseEvent[] = [{ t: "open", session_id: b64u.encode(seq(16, 0x10)), session_key: b64u.encode(seq(32, 0x20)), subaddress: "5SIMULATED", price: { in_per_m: 1000, out_per_m: 2000 }, offer }];
  write("hpke-open.json", {
    _doc: `PROTOCOL.md §5.1 session open: HPKE base mode, suite X25519/HKDF-SHA256/ChaCha20-Poly1305, info = aad = '${INFO_OPEN}'. 'ekm' is the RFC 9180 DeriveKeyPair ikm used for the ephemeral key (hpke-js 'ekm' option); implementations that cannot inject it should instead unseal the envelope with recipient_priv and check plaintext, then derive resp_key/resp_nonce_base via export('${EXPORT_RESP_KEY}',32)/export('${EXPORT_RESP_NONCE}',12) and req_hash = SHA256(enc||ct), and reproduce the frames byte-for-byte.`,
    recipient_priv: hex.encode(hpkePriv), recipient_pub: hex.encode(hpkePub), ekm: hex.encode(ekm),
    plaintext_json: utf8Decode(pt), plaintext_hex: hex.encode(pt),
    info: INFO_OPEN, aad_hex: hex.encode(utf8(INFO_OPEN)),
    envelope,
    response: await frameVectors(srv.ctx, events),
  });
}

// --- hpke-request.json ---
{
  const ekm = fill(32, 0x22);
  const sessionId = seq(16, 0x10), sessionKey = seq(32, 0x20), ctr = 7;
  const pt = utf8(JSON.stringify({ model: "Qwen/Qwen3-8B", messages: [{ role: "user", content: "hi" }], stream: true }));
  const { envelope, ctx } = await sealRequest(hpkePub, sessionId, sessionKey, ctr, pt, { ekm });
  const srv = await unsealRequest(hpkePriv, sessionKey, envelope);
  if (utf8Decode(srv.plaintext) !== utf8Decode(pt)) throw new Error("request roundtrip");
  const receipt = await signBlob({ session_id: b64u.encode(sessionId), seq: 3, tokens_in: 5, tokens_out: 2, debit_piconero: 9, cumulative_debit_piconero: 27, balance_piconero: 973, ts: 1755600100 }, signPriv, DOMAINS.receipt);
  const events: ResponseEvent[] = [
    { t: "chunk", data: { id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "Hel" } }] } },
    { t: "chunk", data: { id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "lo" } }] } },
    { t: "receipt", receipt },
  ];
  write("hpke-request.json", {
    _doc: `PROTOCOL.md §5.1 session request: HPKE PSK mode, psk = session_key, psk_id = session_id, info = '${INFO_REQ}', aad = utf8('${INFO_REQ}') || session_id(16) || u64be(ctr). Same export labels as hpke-open.json for the response frames.`,
    recipient_priv: hex.encode(hpkePriv), recipient_pub: hex.encode(hpkePub), ekm: hex.encode(ekm),
    session_id: hex.encode(sessionId), session_key: hex.encode(sessionKey), ctr,
    plaintext_json: utf8Decode(pt), plaintext_hex: hex.encode(pt),
    info: INFO_REQ, aad_hex: hex.encode(requestAad(sessionId, ctr)),
    envelope,
    response: await frameVectors(srv.ctx, events),
    ...(ctx ? {} : {}),
  });
}

// --- frames.json (framing only, no HPKE) ---
{
  const key = seq(32, 0x30), base = hex.decode("000102030405060708090a0b"), reqHash = seq(32, 0x50);
  const ctx: SealedContext = { exportKey: async () => key, exportNonce: async () => base, reqHash };
  const enc = frameEncoder(ctx);
  const payloads = [utf8('{"t":"status","balance_piconero":1,"credited_piconero":1,"pending_piconero":0,"subaddress":"5X","cumulative_debit_piconero":0}')];
  // three frames so the counter XOR is visible: i = 0,1,2
  const events = ['{"t":"chunk","data":{"a":1}}', '{"t":"chunk","data":{"a":2}}', '{"t":"receipt","receipt":{"payload":"e30","sig":"AA"}}'];
  const frames: unknown[] = [];
  const parts: Uint8Array[] = [];
  for (let i = 0; i < events.length; i++) {
    const f = await enc.seal(utf8(events[i]!), i === events.length - 1);
    parts.push(f);
    frames.push({ index: i, final: i === events.length - 1, flags_byte: i === events.length - 1 ? 1 : 0, nonce: hex.encode(frameNonce(base, i)), payload_json: events[i], frame_hex: hex.encode(f) });
  }
  // independently verify the decoder accepts the body
  let n = 0; for await (const _ of readRawFrames(ctx, concat(...parts))) n++;
  if (n !== 3) throw new Error("frames self-check");
  const bad = concat(...parts); bad[bad.length - 1]! ^= 1;
  void payloads;
  write("frames.json", {
    _doc: "PROTOCOL.md §5.2. frame_i = u32be(len) || ChaCha20Poly1305.seal(resp_key, nonce = resp_base XOR u96be(i), aad = req_hash, flags(1) || payload); flags bit0 = final. nonce_i shown explicitly. body_hex is the concatenation. tampered_body_hex flips the last byte and must be rejected; truncated_body_hex (first two frames only) must be rejected for lacking a final frame.",
    resp_key: hex.encode(key), resp_nonce_base: hex.encode(base), req_hash: hex.encode(reqHash),
    frames, body_hex: hex.encode(concat(...parts)),
    tampered_body_hex: hex.encode(bad),
    truncated_body_hex: hex.encode(concat(parts[0]!, parts[1]!)),
    nonce_examples: [0, 1, 255, 256, 65536].map((i) => ({ i, nonce: hex.encode(frameNonce(base, i)) })),
  });
}

// --- model-digest.json ---
{
  const entries = [
    { path: "model-00002-of-00002.safetensors", sha256: fill(32, 0x02) },
    { path: "config.json", sha256: fill(32, 0x01) },
    { path: "model-00001-of-00002.safetensors", sha256: fill(32, 0x03) },
    { path: "tokenizer/tokenizer.json", sha256: hex.decode("ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100") },
    { path: "Zed.txt", sha256: fill(32, 0x04) },
    { path: "ünïcode.txt", sha256: fill(32, 0x05) },
  ];
  const digest = await modelDigestFromEntries(entries);
  write("model-digest.json", {
    _doc: "PROTOCOL.md §8. Sort entries bytewise by UTF-8 path (not locale-aware: 'Zed.txt' < 'config.json' < 'model-…' < 'tokenizer/…' < 'ünïcode.txt'); encode each as path || 0x00 || sha256 || 0x0a; digest = SHA256 of the concatenation. Entries are given unsorted on purpose.",
    entries: entries.map((e) => ({ path: e.path, sha256: hex.encode(e.sha256) })),
    sorted_paths: [...entries].map((e) => e.path).sort((a, b) => { const A = utf8(a), B = utf8(b); for (let i = 0; i < Math.min(A.length, B.length); i++) if (A[i] !== B[i]) return A[i]! - B[i]!; return A.length - B.length; }),
    digest: hex.encode(digest),
    empty_digest: hex.encode(await modelDigestFromEntries([])),
  });
}

// --- simulated-doc.json ---
{
  const issuedAt = 1755600000;
  const model = { id: "Qwen/Qwen3-8B", digest: hex.encode(modelDigest), ctx_len: 32768 };
  const docZero = await makeSimulatedDoc({ hpkePub, signPub, signPriv, bootNonce, runnerVersion, model, challenge: zero, issuedAt });
  const docCh = await makeSimulatedDoc({ hpkePub, signPub, signPriv, bootNonce, runnerVersion, model, challenge, issuedAt });
  const golden = await verifyGolden(GOLDEN_BLOB);
  const v1 = await verifyAttestationDoc(docZero, { golden, allowSimulated: true, now: issuedAt * 1000 });
  const v2 = await verifyAttestationDoc(docCh, { golden, allowSimulated: true, now: issuedAt * 1000, expectedChallenge: challenge });
  const v3 = await verifyAttestationDoc(docCh, { golden, allowSimulated: false, now: issuedAt * 1000 });
  const v4 = await verifyAttestationDoc(docCh, { golden, allowSimulated: true, now: issuedAt * 1000, expectedChallenge: zero });
  if (v1.status !== "simulated" || v2.status !== "simulated" || v3.status !== "failed" || v4.status !== "failed") throw new Error("simulated self-check " + JSON.stringify([v1.status, v2.status, v3.status, v4.status]));
  const wrongMeasurement = await makeSimulatedDoc({ hpkePub, signPub, signPriv, bootNonce, runnerVersion, model, challenge: zero, issuedAt, measurement: fill(48, 0xee) });
  const v5 = await verifyAttestationDoc(wrongMeasurement, { golden, allowSimulated: true, now: issuedAt * 1000 });
  if (v5.status !== "failed") throw new Error("wrong measurement must fail");
  write("simulated-doc.json", {
    _doc: "Full simulated attestation doc (PROTOCOL.md §3 with platform.kind = simulated) signed by sign_priv, inner simulated report signed by the dev root. Simulated golden measurement = SHA384('gpubnb-simulated-' || runner_version). `golden_blob` is the shipped signed golden set at generation time. Expected verdicts list status + failing check ids for each (doc, options) pair, evaluated at now = issued_at.",
    keys: { hpke_priv: hex.encode(hpkePriv), hpke_pub: hex.encode(hpkePub), sign_priv: hex.encode(signPriv), sign_pub: hex.encode(signPub), boot_nonce: hex.encode(bootNonce) },
    runner_version: runnerVersion, model, issued_at: issuedAt,
    simulated_measurement: hex.encode(await simulatedMeasurement(runnerVersion)),
    golden_blob: GOLDEN_BLOB,
    docs: {
      zero_challenge: { challenge: hex.encode(zero), doc: docZero, payload_json: utf8Decode(b64u.decode(docZero.payload)) },
      with_challenge: { challenge: hex.encode(challenge), doc: docCh, payload_json: utf8Decode(b64u.decode(docCh.payload)) },
      wrong_measurement: { challenge: hex.encode(zero), doc: wrongMeasurement },
    },
    expected: [
      { doc: "zero_challenge", options: { allowSimulated: true }, status: v1.status, failed_checks: v1.checks.filter((c) => !c.ok).map((c) => c.id), check_ids: v1.checks.map((c) => c.id) },
      { doc: "with_challenge", options: { allowSimulated: true, expectedChallenge: hex.encode(challenge) }, status: v2.status, failed_checks: [] },
      { doc: "with_challenge", options: { allowSimulated: false }, status: v3.status, failed_checks: v3.checks.filter((c) => !c.ok).map((c) => c.id) },
      { doc: "with_challenge", options: { allowSimulated: true, expectedChallenge: hex.encode(zero) }, status: v4.status, failed_checks: v4.checks.filter((c) => !c.ok).map((c) => c.id) },
      { doc: "wrong_measurement", options: { allowSimulated: true }, status: v5.status, failed_checks: v5.checks.filter((c) => !c.ok).map((c) => c.id) },
    ],
  });
}
console.log("done");
