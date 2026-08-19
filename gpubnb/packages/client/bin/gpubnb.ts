#!/usr/bin/env bun
// gpubnb CLI — renter side. Usage:
//   gpubnb ls [--simulated] [--gpu X] [--model Y] [--json]
//   gpubnb verify <listing-id|endpoint-url> [--simulated] [--json]
//   gpubnb session <endpoint-url> [--simulated] [--amount <xmr>]        open a session, print subaddress + QR, store it
//   gpubnb status <endpoint-url>                                        balance of the stored session
//   gpubnb chat <endpoint-url> "prompt" [--simulated] [--system S] [--model M] [--max-tokens N] [--no-stream]
// Marketplace: --marketplace URL or GPUBNB_MARKETPLACE (default https://gpubnb.proc.io).
// Sessions live in ~/.gpubnb/sessions.json (holds session keys: treat like a wallet).
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { renderUnicodeCompact } from "uqr";
import { GOLDEN_BLOB, verifyGolden, type GoldenSet, type Verdict } from "@gpubnb/protocol";
import { GpubnbClient, fetchGolden, fetchListing, fetchListings, verifyListing, moneroUri, piconeroToXmr, NotVerifiedError, RunnerError, GpubnbHttpError, type ListingRecord, type SessionJSON } from "../src/index.ts";

const DEFAULT_MARKETPLACE = "https://gpubnb.proc.io";
const STORE_DIR = join(homedir(), ".gpubnb");
const STORE = join(STORE_DIR, "sessions.json");

// ---- tiny arg parser ----
const argv = process.argv.slice(2);
const flags: Record<string, string | boolean> = {};
const pos: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (a.startsWith("--")) {
    const [k, v] = a.slice(2).split("=", 2);
    if (v !== undefined) flags[k!] = v;
    else if (i + 1 < argv.length && !argv[i + 1]!.startsWith("--") && !["simulated", "json", "no-stream", "bundled-golden", "help"].includes(k!)) flags[k!] = argv[++i]!;
    else flags[k!] = true;
  } else pos.push(a);
}
const cmd = pos[0];
const marketplace = (typeof flags.marketplace === "string" ? flags.marketplace : process.env.GPUBNB_MARKETPLACE) || DEFAULT_MARKETPLACE;
const allowSimulated = flags.simulated === true;
const json = flags.json === true;
const err = (m: string) => { console.error(m); process.exit(1); };

function usage(): never {
  console.error(`gpubnb — attested confidential-GPU inference, paid in Monero

  gpubnb ls [--simulated] [--gpu X] [--model Y] [--json]
  gpubnb verify <listing-id|endpoint-url> [--simulated] [--json]
  gpubnb session <endpoint-url> [--simulated] [--amount <xmr>]
  gpubnb status <endpoint-url>
  gpubnb chat <endpoint-url> "prompt" [--simulated] [--system S] [--model M] [--max-tokens N] [--no-stream]

  --marketplace URL   (or GPUBNB_MARKETPLACE; default ${DEFAULT_MARKETPLACE})
  --bundled-golden    use the golden set bundled in @gpubnb/protocol instead of fetching /api/golden
  --simulated         accept dev-root simulated attestation (no hardware protection!)
`);
  process.exit(2);
}

async function loadGolden(): Promise<GoldenSet> {
  if (flags["bundled-golden"] === true) return verifyGolden(GOLDEN_BLOB);
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 5000);
    const g = await fetchGolden(marketplace, ((u: RequestInfo | URL, init?: RequestInit) => fetch(u, { ...init, signal: ac.signal })) as typeof fetch);
    clearTimeout(t);
    return g;
  } catch (e) {
    console.error(`(warning) could not fetch golden set from ${marketplace}: ${(e as Error).message}; using the bundled copy`);
    return verifyGolden(GOLDEN_BLOB);
  }
}

function loadStore(): Record<string, SessionJSON> {
  if (!existsSync(STORE)) return {};
  try { return JSON.parse(readFileSync(STORE, "utf8")); } catch { return {}; }
}
function saveStore(s: Record<string, SessionJSON>) {
  mkdirSync(STORE_DIR, { recursive: true });
  writeFileSync(STORE, JSON.stringify(s, null, 2) + "\n", { mode: 0o600 });
}
const normEndpoint = (u: string) => u.replace(/\/+$/, "");

function printVerdict(v: Verdict, label: string) {
  if (json) { console.log(JSON.stringify(v, null, 2)); return; }
  const mark = v.status === "verified" ? "VERIFIED" : v.status === "simulated" ? "SIMULATED (no hardware protection)" : "FAILED";
  console.log(`${label}: ${mark}`);
  for (const c of v.checks) console.log(`  ${c.ok ? "ok " : "BAD"} ${c.id.padEnd(18)} ${c.detail}`);
  if (v.doc) console.log(`  model ${v.doc.model.id} (${v.doc.model.digest.slice(0, 16)}…) runner ${v.doc.runner_version} platform ${v.doc.platform.kind}/${v.doc.platform.cc_mode ?? "-"} gpu ${v.doc.platform.gpu_model ?? "-"}`);
}

function pricePerM(p: number | string | undefined): string {
  if (p === undefined || p === null) return "-";
  return `${piconeroToXmr(BigInt(p))} XMR/Mtok`;
}

async function cmdLs() {
  const listings = await fetchListings(marketplace, { simulated: allowSimulated, gpu: typeof flags.gpu === "string" ? flags.gpu : undefined, model: typeof flags.model === "string" ? flags.model : undefined });
  if (json) { console.log(JSON.stringify(listings, null, 2)); return; }
  if (!listings.length) { console.log(`no listings${allowSimulated ? "" : " (add --simulated to include simulated runners)"}`); return; }
  const rows = listings.map((l: ListingRecord) => [String(l.id ?? l.slug ?? "?"), String(l.trust_status ?? "?"), String(l.gpu_model ?? "?"), String(l.model_id ?? "?"), pricePerM(l.price_in_piconero), pricePerM(l.price_out_piconero), String(l.region ?? ""), l.endpoint_url]);
  const head = ["id", "trust", "gpu", "model", "in", "out", "region", "endpoint"];
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  console.log(head.map((h, i) => h.padEnd(w[i]!)).join("  "));
  for (const r of rows) console.log(r.map((c, i) => c.padEnd(w[i]!)).join("  "));
}

async function cmdVerify() {
  const target = pos[1] ?? usage();
  const golden = await loadGolden();
  let listing: ListingRecord;
  if (/^https?:\/\//.test(target)) listing = { endpoint_url: target };
  else listing = await fetchListing(marketplace, target);
  const v = await verifyListing(listing, { golden, allowSimulated, challenge: true });
  printVerdict(v, `${listing.endpoint_url} (fresh challenge)`);
  if (listing.attestation || listing.attestation_doc) {
    const v2 = await verifyListing(listing, { golden, allowSimulated });
    if (!json) printVerdict(v2, "marketplace-stored doc");
  }
  process.exit(v.status === "failed" ? 1 : 0);
}

async function connect(endpoint: string) {
  const golden = await loadGolden();
  try {
    return await GpubnbClient.connect({ endpointUrl: endpoint, golden, allowSimulated });
  } catch (e) {
    if (e instanceof NotVerifiedError) {
      printVerdict(e.verdict, endpoint);
      if (e.verdict.status === "failed" && e.verdict.checks.some((c) => c.id === "sim.allowed")) console.error("hint: this is a simulated runner; pass --simulated to accept it");
      process.exit(1);
    }
    throw e;
  }
}

function showPayment(subaddress: string, price: { in_per_m: number; out_per_m: number }, amountXmr?: string) {
  const pico = amountXmr ? BigInt(Math.round(Number(amountXmr) * 1e12)) : undefined;
  const uri = moneroUri(subaddress, pico);
  console.log(`\npay-to subaddress: ${subaddress}`);
  console.log(`price: in ${piconeroToXmr(BigInt(price.in_per_m))} XMR/Mtok, out ${piconeroToXmr(BigInt(price.out_per_m))} XMR/Mtok`);
  console.log(`uri: ${uri}\n`);
  console.log(renderUnicodeCompact(uri));
}

async function cmdSession() {
  const endpoint = normEndpoint(pos[1] ?? usage());
  const { client, verdict } = await connect(endpoint);
  if (!json) printVerdict(verdict, endpoint);
  const s = await client.openSession();
  const store = loadStore();
  store[endpoint] = client.exportSession();
  saveStore(store);
  if (json) { console.log(JSON.stringify({ ...client.exportSession(), session_key: "<stored>" }, null, 2)); return; }
  console.log(`session opened and stored in ${STORE}`);
  showPayment(s.subaddress, s.price, typeof flags.amount === "string" ? flags.amount : undefined);
}

async function withSession(endpoint: string): Promise<{ client: GpubnbClient; persist: () => void }> {
  const store = loadStore();
  const saved = store[endpoint];
  let client: GpubnbClient;
  if (saved) {
    client = GpubnbClient.fromSession(saved);
  } else {
    const c = await connect(endpoint);
    client = c.client;
    const s = await client.openSession();
    console.error(`(no stored session for ${endpoint}; opened a new one)`);
    showPayment(s.subaddress, s.price);
  }
  const persist = () => { const st = loadStore(); st[endpoint] = client.exportSession(); saveStore(st); };
  persist();
  return { client, persist };
}

async function cmdStatus() {
  const endpoint = normEndpoint(pos[1] ?? usage());
  const { client, persist } = await withSession(endpoint);
  try {
    const st = await client.status();
    persist();
    if (json) { console.log(JSON.stringify(st, null, 2)); return; }
    console.log(`balance   ${piconeroToXmr(BigInt(st.balance_piconero))} XMR  (credited ${piconeroToXmr(BigInt(st.credited_piconero))}, pending ${piconeroToXmr(BigInt(st.pending_piconero))}, spent ${piconeroToXmr(BigInt(st.cumulative_debit_piconero))})`);
    console.log(`subaddress ${st.subaddress}`);
  } catch (e) { persist(); throw e; }
}

async function cmdChat() {
  const endpoint = normEndpoint(pos[1] ?? usage());
  const prompt = pos[2] ?? usage();
  const { client, persist } = await withSession(endpoint);
  const messages: { role: string; content: string }[] = [];
  if (typeof flags.system === "string") messages.push({ role: "system", content: flags.system });
  messages.push({ role: "user", content: prompt });
  const req: Record<string, unknown> = { messages, stream: flags["no-stream"] !== true };
  if (typeof flags.model === "string") req.model = flags.model;
  if (typeof flags["max-tokens"] === "string") req.max_tokens = Number(flags["max-tokens"]);
  try {
    let receipt: any;
    for await (const ev of client.chatStream(req as any)) {
      if (ev.t === "chunk") { const d = (ev.data as any)?.choices?.[0]?.delta?.content; if (typeof d === "string") process.stdout.write(d); }
      else if (ev.t === "response") process.stdout.write(String((ev.data as any)?.choices?.[0]?.message?.content ?? ""));
      else if (ev.t === "error") { process.stdout.write("\n"); console.error(`runner error ${ev.code}: ${ev.message}`); }
      else if (ev.t === "receipt") receipt = ev.receipt;
    }
    process.stdout.write("\n");
    persist();
    if (receipt) {
      const { peekBlob } = await import("@gpubnb/protocol");
      const r = peekBlob<any>(receipt);
      console.error(`receipt #${r.seq}: in ${r.tokens_in} out ${r.tokens_out} tokens, debit ${piconeroToXmr(BigInt(r.debit_piconero))} XMR, balance ${piconeroToXmr(BigInt(r.balance_piconero))} XMR`);
    }
  } catch (e) {
    persist();
    if (e instanceof RunnerError) err(`runner error ${e.code}: ${e.message}`);
    if (e instanceof GpubnbHttpError) err(`${e.message}${e.code === "replay" ? " (session counter out of sync: is the session used elsewhere? open a new one with `gpubnb session`)" : e.code === "unknown_session" ? " (runner forgot the session; run `gpubnb session` again)" : ""}`);
    throw e;
  }
}

try {
  if (flags.help === true || !cmd) usage();
  switch (cmd) {
    case "ls": await cmdLs(); break;
    case "verify": await cmdVerify(); break;
    case "session": await cmdSession(); break;
    case "status": await cmdStatus(); break;
    case "chat": await cmdChat(); break;
    default: usage();
  }
} catch (e) {
  err(`error: ${(e as Error).message}`);
}
