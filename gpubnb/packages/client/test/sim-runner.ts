// In-process simulated runner (TypeScript twin of `gpubnbd --simulate`) for SDK tests:
// serves the well-known attestation doc, opens sessions, meters a fake echo upstream,
// enforces the ctr high-water mark, and signs offers/receipts. Bun.serve on a random port.
import {
  b64u, hex, utf8, utf8Decode, randomBytes,
  unsealOpen, unsealRequest, frameEncoder, signBlob, DOMAINS, makeSimulatedDoc, generateRunnerKeys,
  type Envelope, type ResponseEvent, type RunnerKeys, type SealedContext,
} from "@gpubnb/protocol";

export interface SimRunnerOptions {
  runnerVersion?: string;
  model?: { id: string; digest: string; ctx_len?: number };
  price?: { in_per_m: number; out_per_m: number };
  /** piconero credited to every new session (xmr.mode = "free") */
  freeCredit?: number;
  /** Hooks for negative tests. */
  tamperFrames?: boolean;        // flip a byte in the second frame of chat responses
  badReceiptKey?: boolean;       // sign receipts with a different key
  upstream?: (req: any) => Promise<{ content: string; tokens_in: number; tokens_out: number }>;
}

interface SessionState { key: Uint8Array; hwm: number; subaddress: string; balance: number; seq: number; cumulative: number }

export class SimRunner {
  readonly keys: RunnerKeys;
  readonly sessions = new Map<string, SessionState>();
  server!: ReturnType<typeof Bun.serve>;
  url!: string;
  readonly opts: Required<Pick<SimRunnerOptions, "runnerVersion" | "model" | "price" | "freeCredit">> & SimRunnerOptions;
  requests = 0;

  private constructor(keys: RunnerKeys, opts: SimRunnerOptions) {
    this.keys = keys;
    this.opts = { runnerVersion: "0.1.0", model: { id: "sim/echo", digest: "ab".repeat(32), ctx_len: 4096 }, price: { in_per_m: 1_000_000, out_per_m: 2_000_000 }, freeCredit: 10_000_000, ...opts };
  }

  static async start(opts: SimRunnerOptions = {}): Promise<SimRunner> {
    const r = new SimRunner(await generateRunnerKeys(), opts);
    r.server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => r.handle(req) });
    r.url = `http://127.0.0.1:${r.server.port}`;
    return r;
  }
  stop() { this.server.stop(true); }

  async doc(challenge?: Uint8Array) {
    return makeSimulatedDoc({ hpkePub: this.keys.hpkePub, signPub: this.keys.signPub, signPriv: this.keys.signPriv, bootNonce: this.keys.bootNonce, runnerVersion: this.opts.runnerVersion, model: this.opts.model, challenge });
  }

  private async handle(req: Request): Promise<Response> {
    this.requests++;
    const u = new URL(req.url);
    try {
      if (req.method === "GET" && u.pathname === "/.well-known/gpubnb/attestation") {
        const ch = u.searchParams.get("challenge");
        return Response.json(await this.doc(ch ? hex.decode(ch) : undefined));
      }
      if (req.method === "GET" && u.pathname === "/.well-known/gpubnb/info") {
        return Response.json({ listing: "sim", price: this.opts.price, model: this.opts.model, runner_version: this.opts.runnerVersion, sign_pub: b64u.encode(this.keys.signPub), hpke_pub: b64u.encode(this.keys.hpkePub) });
      }
      if (req.method === "GET" && u.pathname === "/v1/models") return Response.json({ object: "list", data: [{ id: this.opts.model.id, object: "model" }] });
      if (req.method === "POST" && u.pathname === "/v1/sessions") return this.open((await req.json()) as Envelope);
      if (req.method === "POST" && (u.pathname === "/v1/sessions/status" || u.pathname === "/v1/chat/completions")) return this.sealed(u.pathname, (await req.json()) as Envelope);
      return new Response("not found", { status: 404 });
    } catch (e) {
      return Response.json({ error: "bad_request", message: (e as Error).message }, { status: 400 });
    }
  }

  private async open(env: Envelope): Promise<Response> {
    let ctx: SealedContext;
    try { ({ ctx } = await unsealOpen(this.keys.hpkePriv, env)); } catch { return Response.json({ error: "decrypt" }, { status: 400 }); }
    const sid = randomBytes(16), key = randomBytes(32);
    const id = b64u.encode(sid);
    const subaddress = "5" + hex.encode(randomBytes(20)); // stagenet-looking placeholder
    this.sessions.set(id, { key, hwm: 0, subaddress, balance: this.opts.freeCredit, seq: 0, cumulative: 0 });
    const now = Math.floor(Date.now() / 1000);
    const offer = await signBlob({ session_id: id, subaddress, price: this.opts.price, hpke_pub: b64u.encode(this.keys.hpkePub), created_at: now, expires_at: now + 86400 }, this.keys.signPriv, DOMAINS.offer);
    return this.respond(ctx, [{ t: "open", session_id: id, session_key: b64u.encode(key), subaddress, price: this.opts.price, offer }]);
  }

  private async sealed(path: string, env: Envelope): Promise<Response> {
    if (typeof env.session_id !== "string") return Response.json({ error: "bad_request" }, { status: 400 });
    const s = this.sessions.get(env.session_id);
    if (!s) return Response.json({ error: "unknown_session" }, { status: 404 });
    if (!(Number.isSafeInteger(env.ctr) && env.ctr > s.hwm)) return Response.json({ error: "replay" }, { status: 409 });
    let plaintext: Uint8Array, ctx: SealedContext;
    try { ({ plaintext, ctx } = await unsealRequest(this.keys.hpkePriv, s.key, env)); } catch { return Response.json({ error: "decrypt" }, { status: 400 }); }
    s.hwm = env.ctr; // only after successful decrypt (a forged ctr must not burn the window)
    const body = JSON.parse(utf8Decode(plaintext));
    if (path === "/v1/sessions/status") {
      return this.respond(ctx, [{ t: "status", balance_piconero: s.balance, credited_piconero: this.opts.freeCredit, pending_piconero: 0, subaddress: s.subaddress, cumulative_debit_piconero: s.cumulative }]);
    }
    // chat
    const receipt = async (tin: number, tout: number) => {
      const debit = Math.ceil((tin * this.opts.price.in_per_m) / 1e6) + Math.ceil((tout * this.opts.price.out_per_m) / 1e6);
      s.balance -= debit; s.cumulative += debit; s.seq += 1;
      const payload = { session_id: env.session_id, seq: s.seq, tokens_in: tin, tokens_out: tout, debit_piconero: debit, cumulative_debit_piconero: s.cumulative, balance_piconero: s.balance, ts: Math.floor(Date.now() / 1000) };
      const signKey = this.opts.badReceiptKey ? (await generateRunnerKeys()).signPriv : this.keys.signPriv;
      return { t: "receipt" as const, receipt: await signBlob(payload, signKey, DOMAINS.receipt) };
    };
    const est = JSON.stringify(body.messages ?? "").length / 4;
    if (s.balance < Math.ceil((est * this.opts.price.in_per_m) / 1e6) + 1) {
      return this.respond(ctx, [{ t: "error", code: "payment_required", message: `balance ${s.balance} piconero too low; pay ${s.subaddress}` }, await receipt(0, 0)]);
    }
    const up = this.opts.upstream ?? (async (r: any) => { const last = [...(r.messages ?? [])].reverse().find((m: any) => m.role === "user"); const c = `echo: ${typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "")}`; return { content: c, tokens_in: Math.ceil(est), tokens_out: Math.ceil(c.length / 4) }; });
    const out = await up(body);
    const events: ResponseEvent[] = [];
    const id = "chatcmpl-" + hex.encode(randomBytes(6));
    if (body.stream) {
      const words = out.content.split(/(?<=\s)/);
      for (const w of words) events.push({ t: "chunk", data: { id, object: "chat.completion.chunk", model: this.opts.model.id, choices: [{ index: 0, delta: { role: "assistant", content: w }, finish_reason: null }] } });
      events.push({ t: "chunk", data: { id, object: "chat.completion.chunk", model: this.opts.model.id, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: out.tokens_in, completion_tokens: out.tokens_out, total_tokens: out.tokens_in + out.tokens_out } } });
    } else {
      events.push({ t: "response", data: { id, object: "chat.completion", model: this.opts.model.id, choices: [{ index: 0, message: { role: "assistant", content: out.content }, finish_reason: "stop" }], usage: { prompt_tokens: out.tokens_in, completion_tokens: out.tokens_out, total_tokens: out.tokens_in + out.tokens_out } } });
    }
    events.push(await receipt(out.tokens_in, out.tokens_out));
    return this.respond(ctx, events, this.opts.tamperFrames);
  }

  private async respond(ctx: SealedContext, events: ResponseEvent[], tamper = false): Promise<Response> {
    const enc = frameEncoder(ctx);
    const frames: Uint8Array[] = [];
    for (let i = 0; i < events.length; i++) frames.push(await enc.seal(utf8(JSON.stringify(events[i])), i === events.length - 1));
    if (tamper && frames.length > 1) frames[1]![frames[1]!.length - 1] ^= 0x01;
    // stream frame by frame so the client exercises incremental parsing
    const stream = new ReadableStream<Uint8Array>({ async start(c) { for (const f of frames) { c.enqueue(f); await new Promise((r) => setTimeout(r, 1)); } c.close(); } });
    return new Response(stream, { status: 200, headers: { "content-type": "application/octet-stream" } });
  }
}
