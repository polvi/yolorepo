import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { verifyGolden, GOLDEN_BLOB, b64u, hex, type GoldenSet } from "@gpubnb/protocol";
import { GpubnbClient, verifyListing, moneroUri, piconeroToXmr, NotVerifiedError, GpubnbHttpError, RunnerError, GpubnbError, assembleFromChunks, fetchAttestation } from "../src/index.ts";
import { SimRunner } from "./sim-runner.ts";

let golden: GoldenSet;
let sim: SimRunner;
beforeAll(async () => { golden = await verifyGolden(GOLDEN_BLOB); sim = await SimRunner.start(); });
afterAll(() => sim.stop());

describe("GpubnbClient against the simulated runner", () => {
  test("connect refuses simulated unless allowed, then verifies with a fresh challenge", async () => {
    await expect(GpubnbClient.connect({ endpointUrl: sim.url, golden })).rejects.toBeInstanceOf(NotVerifiedError);
    const { client, verdict, doc } = await GpubnbClient.connect({ endpointUrl: sim.url, golden, allowSimulated: true });
    expect(verdict.status).toBe("simulated");
    expect(verdict.checks.find((c) => c.id === "doc.fresh")!.detail).toContain("challenge matches");
    expect(hex.encode(client.hpkePub)).toBe(hex.encode(sim.keys.hpkePub));
    expect(doc.model.id).toBe("sim/echo");
  });

  test("openSession → status → chat (non-stream + stream) with verified receipts", async () => {
    const { client } = await GpubnbClient.connect({ endpointUrl: sim.url, golden, allowSimulated: true });
    const s = await client.openSession();
    expect(s.sessionId.length).toBe(16);
    expect(s.subaddress.startsWith("5")).toBe(true);
    expect(s.offerPayload.session_id).toBe(b64u.encode(s.sessionId));
    const st = await client.status();
    expect(st.t).toBe("status");
    expect(st.balance_piconero).toBe(10_000_000);
    const r = await client.chat({ messages: [{ role: "user", content: "hello" }] });
    expect(r.response.choices[0].message.content).toBe("echo: hello");
    expect(r.receipt.seq).toBe(1);
    expect(r.receipt.tokens_out).toBeGreaterThan(0);
    expect(r.receipt.cumulative_debit_piconero).toBe(r.receipt.debit_piconero);
    const events: string[] = [];
    let text = "";
    for await (const ev of client.chatStream({ messages: [{ role: "user", content: "stream me" }], stream: true })) {
      events.push(ev.t);
      if (ev.t === "chunk") text += (ev.data as any).choices?.[0]?.delta?.content ?? "";
    }
    expect(text).toBe("echo: stream me");
    expect(events.at(-1)).toBe("receipt");
    expect(events.filter((e) => e === "chunk").length).toBeGreaterThan(1);
    const r2 = await client.chat({ messages: [{ role: "user", content: "again" }], stream: true });
    expect(r2.response.choices[0].message.content).toBe("echo: again");
    expect(r2.receipt.seq).toBe(3);
    expect(client.session!.ctr).toBe(4); // status + 3 chats
    const st2 = await client.status();
    expect(st2.cumulative_debit_piconero).toBe(r2.receipt.cumulative_debit_piconero);
  });

  test("export/import session keeps working; replay is rejected with 409", async () => {
    const { client } = await GpubnbClient.connect({ endpointUrl: sim.url, golden, allowSimulated: true });
    await client.openSession();
    await client.chat({ messages: [{ role: "user", content: "a" }] });
    const json = client.exportSession();
    expect(json.ctr).toBe(1);
    const c2 = GpubnbClient.fromSession(JSON.parse(JSON.stringify(json)));
    const r = await c2.chat({ messages: [{ role: "user", content: "b" }] });
    expect(r.response.choices[0].message.content).toBe("echo: b");
    expect(r.receipt.seq).toBe(2);
    // the stale first client now has a lower ctr than the runner's high-water mark → replay
    let err: unknown;
    try { await client.chat({ messages: [{ role: "user", content: "c" }] }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GpubnbHttpError);
    expect((err as GpubnbHttpError).status).toBe(409);
    expect((err as GpubnbHttpError).code).toBe("replay");
    // raw replay of an identical envelope
    const { sealRequest, utf8 } = await import("@gpubnb/protocol");
    const s = c2.session!;
    const { envelope } = await sealRequest(c2.hpkePub, s.sessionId, s.sessionKey, s.ctr, utf8("{}"));
    const res = await fetch(`${sim.url}/v1/sessions/status`, { method: "POST", body: JSON.stringify(envelope), headers: { "content-type": "application/json" } });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "replay" });
    // unknown session → 404
    const res2 = await fetch(`${sim.url}/v1/sessions/status`, { method: "POST", body: JSON.stringify({ ...envelope, session_id: b64u.encode(new Uint8Array(16)) }), headers: { "content-type": "application/json" } });
    expect(res2.status).toBe(404);
    // wrong psk → 400, and the hwm is NOT advanced by a forged ctr
    const { envelope: bad } = await sealRequest(c2.hpkePub, s.sessionId, new Uint8Array(32).fill(1), s.ctr + 50, utf8("{}"));
    const res3 = await fetch(`${sim.url}/v1/sessions/status`, { method: "POST", body: JSON.stringify(bad), headers: { "content-type": "application/json" } });
    expect(res3.status).toBe(400);
    expect((await c2.status()).t).toBe("status");
  });

  test("payment_required surfaces as RunnerError with a receipt", async () => {
    const poor = await SimRunner.start({ freeCredit: 0 });
    try {
      const { client } = await GpubnbClient.connect({ endpointUrl: poor.url, golden, allowSimulated: true });
      await client.openSession();
      let err: unknown;
      try { await client.chat({ messages: [{ role: "user", content: "x" }] }); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(RunnerError);
      expect((err as RunnerError).code).toBe("payment_required");
      expect((err as RunnerError).receipt?.seq).toBe(1);
      expect((err as RunnerError).receipt?.debit_piconero).toBe(0);
    } finally { poor.stop(); }
  });

  test("tampered frame is rejected; receipt signed by the wrong key is rejected", async () => {
    const bad = await SimRunner.start({ tamperFrames: true });
    try {
      const { client } = await GpubnbClient.connect({ endpointUrl: bad.url, golden, allowSimulated: true });
      await client.openSession();
      await expect(client.chat({ messages: [{ role: "user", content: "x" }] })).rejects.toThrow(/authentication failed/);
    } finally { bad.stop(); }
    const badKey = await SimRunner.start({ badReceiptKey: true });
    try {
      const { client } = await GpubnbClient.connect({ endpointUrl: badKey.url, golden, allowSimulated: true });
      await client.openSession();
      let err: unknown;
      try { await client.chat({ messages: [{ role: "user", content: "x" }] }); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(GpubnbError);
      expect((err as GpubnbError).code).toBe("bad_receipt");
    } finally { badKey.stop(); }
  });

  test("a doc from another runner (wrong challenge / wrong keys) is refused by connect", async () => {
    const other = await SimRunner.start();
    try {
      // proxy that answers attestation with the other runner's doc (ignoring the challenge)
      const proxy = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (req) => { const u = new URL(req.url); return fetch(`${other.url}${u.pathname}`, req); } });
      try {
        await expect(GpubnbClient.connect({ endpointUrl: `http://127.0.0.1:${proxy.port}`, golden, allowSimulated: true })).rejects.toThrow(/challenge/);
      } finally { proxy.stop(true); }
    } finally { other.stop(); }
  });

  test("verifyListing: embedded doc vs fresh challenge, key cross-check", async () => {
    const doc = await sim.doc();
    const listing = { id: "x", endpoint_url: sim.url, attestation: doc, simulated: true, hpke_pub: b64u.encode(sim.keys.hpkePub), sign_pub: b64u.encode(sim.keys.signPub) };
    const v1 = await verifyListing(listing, { golden, allowSimulated: true });
    expect(v1.status).toBe("simulated");
    expect(v1.checks.at(-1)).toMatchObject({ id: "listing.keys", ok: true });
    const v2 = await verifyListing(listing, { golden, allowSimulated: true, challenge: true });
    expect(v2.status).toBe("simulated");
    expect(v2.checks.find((c) => c.id === "doc.fresh")!.detail).toContain("challenge matches");
    const v3 = await verifyListing({ ...listing, sign_pub: b64u.encode(new Uint8Array(32)) }, { golden, allowSimulated: true });
    expect(v3.status).toBe("failed");
    expect(v3.checks.find((c) => c.id === "listing.keys")!.ok).toBe(false);
    const v4 = await verifyListing({ endpoint_url: sim.url }, { golden, allowSimulated: true });
    expect(v4.checks[0]!.id).toBe("listing.doc");
    const v5 = await verifyListing({ endpoint_url: "http://127.0.0.1:9" }, { golden, allowSimulated: true, challenge: true });
    expect(v5.checks[0]!.id).toBe("listing.fetch");
    expect((await verifyListing(listing, { golden })).status).toBe("failed");
  });

  test("fetchAttestation + raw endpoint shape", async () => {
    const ch = new Uint8Array(32).fill(5);
    const blob = await fetchAttestation(sim.url, ch);
    expect(typeof blob.payload).toBe("string");
    const info = await (await fetch(`${sim.url}/.well-known/gpubnb/info`)).json();
    expect(info.sign_pub).toBe(b64u.encode(sim.keys.signPub));
  });
});

describe("helpers", () => {
  test("moneroUri / piconeroToXmr", () => {
    expect(piconeroToXmr(1_000_000_000_000n)).toBe("1");
    expect(piconeroToXmr(1_500_000_000_000n)).toBe("1.5");
    expect(piconeroToXmr(1n)).toBe("0.000000000001");
    expect(moneroUri("5abc")).toBe("monero:5abc");
    expect(moneroUri("5abc", 250_000_000_000n)).toBe("monero:5abc?tx_amount=0.25");
  });
  test("assembleFromChunks", () => {
    const r = assembleFromChunks([
      { t: "chunk", data: { id: "1", model: "m", choices: [{ index: 0, delta: { role: "assistant", content: "He" } }] } },
      { t: "chunk", data: { id: "1", choices: [{ index: 0, delta: { content: "llo" }, finish_reason: "stop" }], usage: { total_tokens: 3 } } },
      { t: "receipt", receipt: { payload: "", sig: "" } },
    ]);
    expect(r.choices[0].message.content).toBe("Hello");
    expect(r.choices[0].finish_reason).toBe("stop");
    expect(r.usage.total_tokens).toBe(3);
    expect(assembleFromChunks([])).toBeUndefined();
  });
});
