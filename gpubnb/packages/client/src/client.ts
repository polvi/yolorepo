import {
  b64u, hex, randomBytes, utf8, utf8Decode, bytesEqual,
  sealOpen, sealRequest, readFrames, verifyBlob, DOMAINS, OfferSchema, ReceiptSchema, verifyAttestationDoc, peekBlob,
  type Envelope, type GoldenSet, type ModelCatalog, type Offer, type Receipt, type ResponseEvent, type SignedBlob, type StatusEvent, type Verdict, type AttestationDoc, type OpenEvent, type ReceiptEvent,
} from "@gpubnb/protocol";
import { GpubnbError, GpubnbHttpError, NotVerifiedError, RunnerError } from "./errors.ts";
import { fetchAttestation, joinUrl } from "./listing.ts";

export interface Price { in_per_m: number; out_per_m: number }

export interface Session {
  sessionId: Uint8Array;   // 16
  sessionKey: Uint8Array;  // 32
  /** Last request counter used (high-water mark on our side). Next request uses ctr + 1. */
  ctr: number;
  subaddress: string;
  price: Price;
  offer: SignedBlob;
  /** Parsed + verified offer payload. */
  offerPayload: Offer;
  /** Highest receipt seq seen (receipts must strictly increase). */
  lastSeq: number;
  /** Highest cumulative_debit seen (must never decrease). */
  lastCumulativeDebit: number;
  endpointUrl: string;
  openedAt: number; // unix seconds
}

/** JSON-safe form of Session (b64u keys). Store it; never share it (holds the spend-capable session key). */
export interface SessionJSON {
  v: 1;
  endpoint_url: string;
  session_id: string;
  session_key: string;
  ctr: number;
  subaddress: string;
  price: Price;
  offer: SignedBlob;
  last_seq: number;
  last_cumulative_debit: number;
  opened_at: number;
  hpke_pub: string;
  sign_pub: string;
}

export interface ChatMessage { role: "system" | "user" | "assistant" | "tool" | (string & {}); content: string | unknown; [k: string]: unknown }
export interface ChatRequest { model?: string; messages: ChatMessage[]; stream?: boolean; max_tokens?: number; temperature?: number; [k: string]: unknown }

export interface ChatResult {
  /** The `response` event's data (OpenAI chat.completion), or one assembled from `chunk` events when streaming. */
  response: any;
  receipt: Receipt;
  receiptBlob: SignedBlob;
  /** Raw events in order (chunks included) for callers that want them. */
  events: ResponseEvent[];
}

const SESSIONS_PATH = "/v1/sessions";
const STATUS_PATH = "/v1/sessions/status";
const CHAT_PATH = "/v1/chat/completions";

export class GpubnbClient {
  readonly endpointUrl: string;
  readonly hpkePub: Uint8Array;
  readonly signPub: Uint8Array;
  private readonly f: typeof fetch;
  private _session: Session | null = null;
  /** Serializes sealed requests so ctr never races within one client. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(p: { endpointUrl: string; hpkePub: Uint8Array; signPub: Uint8Array; fetch?: typeof fetch }) {
    if (p.hpkePub.length !== 32 || p.signPub.length !== 32) throw new Error("hpkePub and signPub must be 32 bytes");
    this.endpointUrl = p.endpointUrl.replace(/\/+$/, "");
    this.hpkePub = p.hpkePub;
    this.signPub = p.signPub;
    this.f = p.fetch ?? fetch;
  }

  /**
   * Fetch the runner's attestation doc with a fresh random challenge, verify it, and refuse unless the
   * verdict is `verified` (or `simulated` when allowSimulated). The client is bound to the keys in the doc.
   */
  static async connect(p: { endpointUrl: string; golden: GoldenSet; allowSimulated?: boolean; models?: ModelCatalog; fetch?: typeof fetch; fetchJwks?: () => Promise<JsonWebKey[]>; now?: number }): Promise<{ client: GpubnbClient; verdict: Verdict; doc: AttestationDoc }> {
    const f = p.fetch ?? fetch;
    const challenge = randomBytes(32);
    const blob = await fetchAttestation(p.endpointUrl, challenge, f);
    const verdict = await verifyAttestationDoc(blob, { golden: p.golden, allowSimulated: p.allowSimulated, expectedChallenge: challenge, models: p.models, fetch: f, fetchJwks: p.fetchJwks, now: p.now });
    if (verdict.status === "failed" || !verdict.doc) {
      const bad = verdict.checks.filter((c) => !c.ok).map((c) => `${c.id}: ${c.detail}`).join("; ");
      throw new NotVerifiedError(`attestation ${verdict.status}: ${bad || "no doc"}`, verdict);
    }
    const doc = verdict.doc;
    const client = new GpubnbClient({ endpointUrl: p.endpointUrl, hpkePub: b64u.decode(doc.hpke_pub), signPub: b64u.decode(doc.sign_pub), fetch: f });
    return { client, verdict, doc };
  }

  get session(): Session | null { return this._session; }

  restoreSession(s: Session): void {
    if (s.endpointUrl && s.endpointUrl.replace(/\/+$/, "") !== this.endpointUrl) throw new GpubnbError("session belongs to a different endpoint", "session_mismatch");
    this._session = s;
  }

  exportSession(): SessionJSON {
    const s = this.requireSession();
    return {
      v: 1, endpoint_url: s.endpointUrl, session_id: b64u.encode(s.sessionId), session_key: b64u.encode(s.sessionKey), ctr: s.ctr,
      subaddress: s.subaddress, price: s.price, offer: s.offer, last_seq: s.lastSeq, last_cumulative_debit: s.lastCumulativeDebit, opened_at: s.openedAt,
      hpke_pub: b64u.encode(this.hpkePub), sign_pub: b64u.encode(this.signPub),
    };
  }

  static importSession(json: SessionJSON): Session {
    if (!json || json.v !== 1) throw new GpubnbError("unsupported session JSON", "bad_session");
    const offerPayload = OfferSchema.parse(peekBlob(json.offer));
    return {
      sessionId: b64u.decode(json.session_id), sessionKey: b64u.decode(json.session_key), ctr: json.ctr, subaddress: json.subaddress, price: json.price,
      offer: json.offer, offerPayload, lastSeq: json.last_seq ?? -1, lastCumulativeDebit: json.last_cumulative_debit ?? 0, endpointUrl: json.endpoint_url, openedAt: json.opened_at,
    };
  }

  /** Rebuild a client from an exported session without re-attesting (keys come from the JSON). Prefer connect() + restoreSession() when you can. */
  static fromSession(json: SessionJSON, fetchImpl?: typeof fetch): GpubnbClient {
    const c = new GpubnbClient({ endpointUrl: json.endpoint_url, hpkePub: b64u.decode(json.hpke_pub), signPub: b64u.decode(json.sign_pub), fetch: fetchImpl });
    c.restoreSession(GpubnbClient.importSession(json));
    return c;
  }

  /** POST /v1/sessions (HPKE base mode). Verifies the signed offer before accepting the session. */
  async openSession(): Promise<Session> {
    const clientNonce = randomBytes(32);
    const pt = utf8(JSON.stringify({ client_nonce: b64u.encode(clientNonce) }));
    const { envelope, ctx } = await sealOpen(this.hpkePub, pt);
    const body = await this.post(SESSIONS_PATH, envelope);
    const events: ResponseEvent[] = [];
    for await (const ev of readFrames(ctx, body)) events.push(ev);
    const open = events.find((e): e is OpenEvent => e.t === "open");
    if (!open) {
      const err = events.find((e) => e.t === "error");
      if (err && err.t === "error") throw new RunnerError(err.code, err.message);
      throw new GpubnbError("session open returned no open event", "bad_response");
    }
    const sessionId = b64u.decode(open.session_id);
    const sessionKey = b64u.decode(open.session_key);
    if (sessionId.length !== 16 || sessionKey.length !== 32) throw new GpubnbError("bad session id/key length", "bad_response");
    const offerRaw = await verifyBlob(open.offer, this.signPub, DOMAINS.offer);
    if (offerRaw === null) throw new GpubnbError("offer signature invalid under the runner's sign key", "bad_offer");
    const offer = OfferSchema.parse(offerRaw);
    if (offer.session_id !== open.session_id) throw new GpubnbError("offer session_id does not match the open event", "bad_offer");
    if (!bytesEqual(b64u.decode(offer.hpke_pub), this.hpkePub)) throw new GpubnbError("offer hpke_pub is not the attested key", "bad_offer");
    if (offer.subaddress !== open.subaddress) throw new GpubnbError("offer subaddress does not match the open event", "bad_offer");
    if (offer.price.in_per_m !== open.price.in_per_m || offer.price.out_per_m !== open.price.out_per_m) throw new GpubnbError("offer price does not match the open event", "bad_offer");
    const s: Session = { sessionId, sessionKey, ctr: 0, subaddress: open.subaddress, price: open.price, offer: open.offer, offerPayload: offer, lastSeq: -1, lastCumulativeDebit: 0, endpointUrl: this.endpointUrl, openedAt: Math.floor(Date.now() / 1000) };
    this._session = s;
    return s;
  }

  /** POST /v1/sessions/status (PSK). */
  async status(): Promise<StatusEvent> {
    const events = await this.sealedCall(STATUS_PATH, {});
    const st = events.find((e): e is StatusEvent => e.t === "status");
    if (!st) {
      const err = events.find((e) => e.t === "error");
      if (err && err.t === "error") throw new RunnerError(err.code, err.message);
      throw new GpubnbError("status returned no status event", "bad_response");
    }
    return st;
  }

  /**
   * POST /v1/chat/completions (PSK), streaming the decrypted events. The final `receipt` event is
   * verified (signature under sign_pub, schema, session_id, monotonic seq / cumulative debit) before it
   * is yielded; a stream that ends without a valid receipt throws. `error` events are yielded too (the
   * receipt still follows), so callers can show the message; chat() turns them into RunnerError.
   */
  async *chatStream(req: ChatRequest): AsyncGenerator<ResponseEvent> {
    const s = this.requireSession();
    const { ctx, body } = await this.sealedPost(CHAT_PATH, req);
    let sawReceipt = false;
    for await (const ev of readFrames(ctx, body)) {
      if (ev.t === "receipt") {
        await this.verifyReceipt(s, ev);
        sawReceipt = true;
      }
      yield ev;
    }
    if (!sawReceipt) throw new GpubnbError("response ended without a receipt", "no_receipt");
  }

  /** Non-streaming convenience over chatStream(). Throws RunnerError (with the receipt) on an `error` event. */
  async chat(req: ChatRequest): Promise<ChatResult> {
    const events: ResponseEvent[] = [];
    for await (const ev of this.chatStream(req)) events.push(ev);
    const receiptEv = events.find((e): e is ReceiptEvent => e.t === "receipt")!;
    const receipt = ReceiptSchema.parse(peekBlob(receiptEv.receipt));
    const err = events.find((e) => e.t === "error");
    if (err && err.t === "error") throw new RunnerError(err.code, err.message, receipt, receiptEv.receipt);
    const resp = events.find((e) => e.t === "response");
    let response: any = resp && resp.t === "response" ? resp.data : undefined;
    if (response === undefined) response = assembleFromChunks(events);
    return { response, receipt, receiptBlob: receiptEv.receipt, events };
  }

  // ---- internals ----

  private requireSession(): Session {
    if (!this._session) throw new GpubnbError("no session: call openSession() or restoreSession()", "no_session");
    return this._session;
  }

  private async verifyReceipt(s: Session, ev: ReceiptEvent): Promise<Receipt> {
    const raw = await verifyBlob(ev.receipt, this.signPub, DOMAINS.receipt);
    if (raw === null) throw new GpubnbError("receipt signature invalid under the runner's sign key", "bad_receipt");
    const parsed = ReceiptSchema.safeParse(raw);
    if (!parsed.success) throw new GpubnbError("receipt payload malformed", "bad_receipt");
    const r = parsed.data;
    if (r.session_id !== b64u.encode(s.sessionId)) throw new GpubnbError("receipt is for another session", "bad_receipt");
    if (r.seq <= s.lastSeq) throw new GpubnbError(`receipt seq ${r.seq} did not increase (last ${s.lastSeq})`, "bad_receipt");
    if (r.cumulative_debit_piconero < s.lastCumulativeDebit) throw new GpubnbError("receipt cumulative debit decreased", "bad_receipt");
    s.lastSeq = r.seq;
    s.lastCumulativeDebit = r.cumulative_debit_piconero;
    return r;
  }

  private async sealedCall(path: string, plaintext: unknown): Promise<ResponseEvent[]> {
    const { ctx, body } = await this.sealedPost(path, plaintext);
    const events: ResponseEvent[] = [];
    for await (const ev of readFrames(ctx, body)) events.push(ev);
    return events;
  }

  /** Seal with the next ctr (serialized per client) and POST. */
  private sealedPost(path: string, plaintext: unknown): Promise<{ ctx: Awaited<ReturnType<typeof sealRequest>>["ctx"]; body: ReadableStream<Uint8Array> }> {
    const run = async () => {
      const s = this.requireSession();
      const ctr = s.ctr + 1;
      const { envelope, ctx } = await sealRequest(this.hpkePub, s.sessionId, s.sessionKey, ctr, utf8(JSON.stringify(plaintext)));
      s.ctr = ctr; // bump before sending: a lost response must not lead to a reused ctr
      const body = await this.post(path, envelope);
      return { ctx, body };
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }

  private async post(path: string, envelope: Envelope): Promise<ReadableStream<Uint8Array>> {
    const r = await this.f(joinUrl(this.endpointUrl, path), { method: "POST", headers: { "content-type": "application/json", accept: "application/octet-stream" }, body: JSON.stringify(envelope) });
    if (r.status !== 200) {
      const text = await r.text().catch(() => "");
      let code = "http";
      try { const j = JSON.parse(text); if (j && typeof j.error === "string") code = j.error; } catch { /* not json */ }
      if (r.status === 409) code = "replay";
      if (r.status === 404 && code === "http") code = "unknown_session";
      throw new GpubnbHttpError(r.status, text, code);
    }
    if (!r.body) {
      const buf = new Uint8Array(await r.arrayBuffer());
      return new ReadableStream<Uint8Array>({ start(c) { c.enqueue(buf); c.close(); } });
    }
    return r.body;
  }
}

/** Build a chat.completion-shaped object from streamed chunks (content concatenated per choice). */
export function assembleFromChunks(events: ResponseEvent[]): any {
  const chunks = events.filter((e) => e.t === "chunk").map((e) => (e as { data: any }).data);
  if (chunks.length === 0) return undefined;
  const choices: Record<number, { index: number; message: { role: string; content: string }; finish_reason: string | null }> = {};
  let usage: unknown;
  let id: string | undefined, model: string | undefined, created: number | undefined;
  for (const c of chunks) {
    id ??= c?.id; model ??= c?.model; created ??= c?.created;
    if (c?.usage) usage = c.usage;
    for (const ch of c?.choices ?? []) {
      const idx = ch.index ?? 0;
      const cur = (choices[idx] ??= { index: idx, message: { role: "assistant", content: "" }, finish_reason: null });
      if (ch.delta?.role) cur.message.role = ch.delta.role;
      if (typeof ch.delta?.content === "string") cur.message.content += ch.delta.content;
      if (ch.finish_reason) cur.finish_reason = ch.finish_reason;
    }
  }
  return { id, object: "chat.completion", created, model, choices: Object.values(choices).sort((a, b) => a.index - b.index), ...(usage ? { usage } : {}) };
}

