# @gpubnb/client

Renter SDK for gpubnb (browser + bun) and the `gpubnb` CLI. Verifies a
listing's attestation locally with the pinned roots from `@gpubnb/protocol`,
opens an HPKE session to the enclave, shows where to pay (Monero subaddress,
`monero:` URI, QR) and streams chat completions that only the enclave can read.

```ts
import { fetchGolden, GpubnbClient, moneroUri } from "@gpubnb/client";

const golden = await fetchGolden("https://gpubnb.example");        // signed by the offline root, verified here
const { client, verdict } = await GpubnbClient.connect({ endpointUrl, golden }); // fresh random challenge; throws NotVerifiedError unless verified
const session = await client.openSession();                         // HPKE base mode; offer signature checked
console.log(moneroUri(session.subaddress));                         // pay the host directly (stagenet in dev)
const { response, receipt } = await client.chat({ messages: [{ role: "user", content: "hi" }] });
for await (const ev of client.chatStream({ messages, stream: true })) { /* chunk | response | error | receipt */ }
localStorage.sessions = JSON.stringify(client.exportSession());     // holds the session key: treat like a wallet
```

## API

- `fetchGolden(origin, fetch?)`, `fetchModels`, `fetchListings(origin, {simulated, gpu, model})`, `fetchListing(origin, id)`, `fetchAttestation(endpointUrl, challenge?)`
- `verifyListing(listing, { golden, allowSimulated?, challenge?, models?, fetch?, fetchJwks?, now? })` → `Verdict`.
  `challenge: true` fetches a fresh doc from the runner with a random 32-byte challenge; otherwise the
  doc embedded in the listing (`attestation` or `attestation_doc`) is verified. When the listing carries
  `hpke_pub`/`sign_pub` (hex or b64u), an extra `listing.keys` check confirms the doc speaks for the same
  runner identity. Extra ids: `listing.doc` (no embedded doc), `listing.fetch` (runner unreachable).
- `GpubnbClient`
  - `new GpubnbClient({ endpointUrl, hpkePub, signPub, fetch? })`
  - `static connect({ endpointUrl, golden, allowSimulated?, models?, fetch?, fetchJwks?, now? })` → `{ client, verdict, doc }`; refuses `failed` (and `simulated` unless allowed) with `NotVerifiedError` carrying the verdict.
  - `openSession()` → `Session { sessionId, sessionKey, ctr, subaddress, price, offer, offerPayload, lastSeq, lastCumulativeDebit, endpointUrl, openedAt }`; verifies the offer blob under `signPub` and that its `session_id`, `hpke_pub`, `subaddress`, `price` match the open event.
  - `restoreSession(s)`, `get session`, `exportSession()` → `SessionJSON`, `static importSession(json)`, `static fromSession(json, fetch?)` (rebuild without re-attesting).
  - `status()` → `StatusEvent`.
  - `chatStream(req)` → async generator of `ResponseEvent`; the `receipt` event is verified before it is yielded (signature under `signPub`, schema, `session_id`, strictly increasing `seq`, non-decreasing `cumulative_debit_piconero`), a stream without a receipt throws (`no_receipt`), a tampered/reordered frame throws `FrameError`.
  - `chat(req)` → `{ response, receipt, receiptBlob, events }`; an `error` event becomes `RunnerError(code, message, receipt)`; when streaming, `response` is assembled from the chunks (`assembleFromChunks`).
  - `ctr` handling: every sealed call uses `session.ctr + 1`, bumped **before** the request is sent and serialized per client, so a lost response never reuses a counter. The runner answers a stale counter with HTTP 409 `{error:"replay"}` → `GpubnbHttpError` with `code: "replay"` (404 → `unknown_session`, 400 → decrypt failure). A session must not be driven from two places at once.
- `moneroUri(subaddress, piconero?)` → `monero:<addr>[?tx_amount=<xmr>]`, `piconeroToXmr`.
- Errors: `GpubnbError` (code), `GpubnbHttpError` (status, code), `RunnerError` (code, receipt), `NotVerifiedError` (verdict).

## CLI

```
gpubnb ls [--simulated] [--gpu X] [--model Y] [--json]
gpubnb verify <listing-id|endpoint-url> [--simulated] [--json]
gpubnb session <endpoint-url> [--simulated] [--amount <xmr>]     # opens, prints subaddress + URI + QR (uqr), stores ~/.gpubnb/sessions.json
gpubnb status <endpoint-url>
gpubnb chat <endpoint-url> "prompt" [--simulated] [--system S] [--model M] [--max-tokens N] [--no-stream]
```

The marketplace origin defaults to `https://gpubnb.proc.io` and is overridden by `--marketplace` or
`GPUBNB_MARKETPLACE` (the CLI is a client, so a default origin is fine; deployables derive their own).
The golden set is fetched from the marketplace (`/api/golden`, verified under the pinned offline root)
with a fallback to the copy bundled in `@gpubnb/protocol` (`--bundled-golden` forces it). `verify` exits 0
for `verified`/`simulated`, 1 for `failed`. `chat` auto-opens a session when none is stored and
re-persists the counter after every call.

## Tests

`bun test` spins up `test/sim-runner.ts`, an in-process TypeScript twin of `gpubnbd --simulate`
(well-known attestation with challenge, `/v1/sessions`, `/v1/sessions/status`, `/v1/chat/completions`
with an echo upstream, ctr high-water mark, signed offers/receipts, free credit), and covers connect →
openSession → status → chat (stream and not) → receipt verification, export/import, replay (409),
unknown session (404), wrong PSK (400, and the forged ctr does not advance the high-water mark),
`payment_required`, tampered frames, receipts under a wrong key, a proxied doc that ignores the challenge,
and `verifyListing` in both modes.
