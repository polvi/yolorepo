# gpubnb protocol v1

Normative wire formats shared by `packages/protocol` (TypeScript, used by the
marketplace worker and the renter SDK) and `runner/` (Rust, runs inside the
CVM). If this file and code disagree, fix the code. Test vectors live in
`fixtures/` (JSON) and are consumed by both test suites.

Encodings: binary fields are **base64url without padding** (`b64u`). Digests
that humans read (measurement, model digest, binding, nonces) are **lowercase
hex**. Integers are JSON numbers (all fit in 2^53). Times are unix seconds.

## 1. Signed blobs

Everything signed is carried as

```json
{ "payload": "<b64u of UTF-8 JSON bytes>", "sig": "<b64u Ed25519 signature>", "kid": "<key id, optional>" }
```

The signature is over `DOMAIN || payload_bytes` where `DOMAIN` is an ASCII
domain-separation string (below) and `payload_bytes` are the exact bytes that
were base64url-encoded. Verifiers decode, check the signature, then parse.
There is no canonical JSON anywhere.

| Object          | DOMAIN                      | Signed by                  |
|-----------------|-----------------------------|----------------------------|
| Attestation doc | `gpubnb-attdoc-v1`          | runner `sign_key`          |
| Session offer   | `gpubnb-offer-v1`           | runner `sign_key`          |
| Usage receipt   | `gpubnb-receipt-v1`         | runner `sign_key`          |
| Golden set      | `gpubnb-golden-v1`          | offline root (`kid` set)   |
| Model catalog   | `gpubnb-models-v1`          | offline root (`kid` set)   |
| Simulated report| `gpubnb-simulated-v1`       | dev root (checked in)      |

Pinned keys (Ed25519 public, b64u):

- offline root `gpubnb-root-2026`: `vDTaTKbOIk2FAGfIMYwICVyEHkSQq4RBEe4WOCgwb04`
  (private half lives outside the repo; signs golden + models)
- dev root `gpubnb-dev-root`: `ymOF_JrpoPhtWQ3ddhLxQ2ElP4IvWU42GJ5Y98FK4bk`
  private: `dV0ywEoe20SjGM__t7x94B9I7NWqws9oILxmNOXy9G0` — **public knowledge,
  checked in on purpose**; anything it signs is `simulated`, never `verified`.

## 2. Runner identity and binding

At boot the runner generates, RAM-only:

- `hpke_sk/hpke_pub` — X25519 (32-byte pub)
- `sign_sk/sign_pub` — Ed25519 (32-byte pub)
- `boot_nonce` — 32 random bytes

and computes `model_digest` (§8). Then

```
binding     = SHA256("gpubnb-binding-v1" || hpke_pub || sign_pub || boot_nonce
                     || SHA256(utf8(runner_version)) || model_digest)          # 32 bytes
report_data = SHA512("gpubnb-report-v1" || binding || challenge)               # 64 bytes → SNP REPORT_DATA
gpu_nonce   = SHA256("gpubnb-gpu-v1"    || binding || challenge)               # 32 bytes → GPU attestation nonce (hex)
```

`challenge` is 32 bytes; all-zero at boot, otherwise supplied by the
marketplace (heartbeat response) or a renter (`?challenge=` query, hex).

## 3. Attestation doc (payload of a signed blob, DOMAIN `gpubnb-attdoc-v1`)

```json
{
  "v": 1,
  "runner_version": "0.1.0",
  "hpke_pub": "b64u32", "sign_pub": "b64u32", "boot_nonce": "b64u32",
  "binding": "hex32",
  "challenge": "hex32",
  "issued_at": 1755600000,
  "model": { "id": "Qwen/Qwen3-8B", "digest": "hex32", "ctx_len": 32768 },
  "platform": {
    "kind": "snp" | "simulated",
    "cpu": "AMD EPYC 9375F", "gpu_model": "NVIDIA RTX PRO 6000 Blackwell Server Edition",
    "cc_mode": "on" | "devtools" | "off" | "simulated"
  },
  "snp":       { "report": "b64u(1184 bytes)", "vcek_chain": ["-----BEGIN CERTIFICATE-----..."] } | null,
  "gpu":       { "overall": "<jwt>", "devices": { "GPU-0": "<jwt>" } } | null,
  "simulated": { "payload": "...", "sig": "...", "kid": "gpubnb-dev-root" } | null
}
```

Exactly one of `snp`+`gpu` (real) or `simulated` is present. The simulated
inner payload is `{ "report_data": "hex64", "gpu_nonce": "hex32",
"measurement": "hex48", "hwmodel": "SIMULATED", "issued_at": n }`.

Served unauthenticated at `GET /.well-known/gpubnb/attestation[?challenge=hex32]`
(fresh doc per call when a challenge is given; cached boot doc otherwise) and
POSTed to the marketplace (§9). `GET /.well-known/gpubnb/info` returns the
unsigned public listing info `{ listing, price, model, runner_version, sign_pub }`.

## 4. Verification (identical in worker and SDK)

Result: `{ status: "verified" | "simulated" | "failed", checks: [{ id, ok, detail }] }`.
Any failed check ⇒ `failed`. `simulated` only when `platform.kind == "simulated"`
AND the caller opted in (`allowSimulated: true`); otherwise `failed`.

Check ids, in order:

1. `doc.sig` — blob signature under `sign_pub` in the payload (self-signed identity).
2. `doc.binding` — recomputed binding equals `binding`.
3. `doc.fresh` — `issued_at` within ±10 min of now (skew allowance); `challenge` equals the caller's expected challenge when one was supplied.
4. `snp.parse` — 1184-byte report, version ≥ 2.
5. `snp.chain` — VCEK → ASK → ARK; ARK pinned for Genoa and Turin (`roots/amd/*.pem`); VCEK extensions (hwID = `CHIP_ID`, TCB components) match the report.
6. `snp.sig` — ECDSA P-384 over bytes 0..0x2A0 with VCEK, signature r‖s each 72-byte little-endian zero-padded in the report (reverse to big-endian 48 bytes).
7. `snp.policy` — `POLICY` DEBUG bit (19) = 0, MIGRATE_MA (18) = 0, SMT allowed; `VMPL == 0`.
8. `snp.tcb` — `REPORTED_TCB` ≥ `minTcb` (configurable floor; fixture default).
9. `snp.measurement` — `MEASUREMENT` ∈ golden(`runner_version`).
10. `snp.report_data` — equals `SHA512("gpubnb-report-v1" || binding || challenge)`.
11. `gpu.jwt` — overall JWT and every device JWT: ES384 signature against NRAS JWKS, `exp` not passed, `iss` NRAS.
12. `gpu.nonce` — `eat_nonce` (hex) == `gpu_nonce`.
13. `gpu.claims` — overall `x-nvidia-overall-att-result == true`; every device: `measres == "success"`, `dbgstat == "disabled"`, `secboot == true`, `hwmodel` ∈ allowlist (`RTX PRO 6000 Blackwell Server Edition`, `H100`, `H200`, `B200`, `B300` prefixes).
14. `sim.*` — for simulated docs: dev-root signature, `report_data`/`gpu_nonce` match, `measurement` ∈ golden with `simulated: true`.

## 5. HPKE

Suite: DHKEM(X25519, HKDF-SHA256), KDF HKDF-SHA256, AEAD ChaCha20-Poly1305
(RFC 9180 ids 0x0020 / 0x0001 / 0x0003).

### 5.1 Request envelope (JSON body of every renter → runner POST)

```json
{ "session_id": "b64u16" | null, "ctr": 7, "enc": "b64u32", "ct": "b64u" }
```

- Session open (`POST /v1/sessions`): `session_id = null`, `ctr = 0`,
  HPKE **base** mode, `info = "gpubnb-open-v1"`, `aad = "gpubnb-open-v1"`.
  Plaintext: `{ "client_nonce": "b64u32" }`.
- All other calls: HPKE **PSK** mode, `psk = session_key`, `psk_id = session_id bytes`,
  `info = "gpubnb-req-v1"`, `aad = "gpubnb-req-v1" || session_id(16) || ctr as u64 BE`.
  `ctr` must be strictly greater than the session's high-water mark; otherwise
  HTTP 409 `{ "error": "replay" }` and nothing changes. Unknown session → 404,
  decrypt failure → 400.

### 5.2 Response frames (body of every sealed response, HTTP 200, `content-type: application/octet-stream`)

From the same HPKE context: `resp_key = export("gpubnb-resp-key-v1", 32)`,
`resp_base = export("gpubnb-resp-nonce-v1", 12)`, `req_hash = SHA256(enc || ct)`.

```
frame_i = u32_be(len) || ChaCha20Poly1305.seal(resp_key, nonce = resp_base XOR u96_be(i), aad = req_hash, pt_i)
pt_i    = flags(1 byte) || payload
flags   bit0 = final
```

`i` starts at 0. Receivers reject out-of-order/missing counters (implied by the
nonce) and a stream that ends without a `final` frame. Payloads are UTF-8 JSON
events:

```json
{ "t": "open",     "session_id": "b64u16", "session_key": "b64u32", "subaddress": "5…", "price": { "in_per_m": 0, "out_per_m": 0 }, "offer": <signed blob> }
{ "t": "status",   "balance_piconero": 0, "credited_piconero": 0, "pending_piconero": 0, "subaddress": "…", "cumulative_debit_piconero": 0 }
{ "t": "chunk",    "data": <OpenAI chat.completion.chunk> }
{ "t": "response", "data": <OpenAI chat.completion> }
{ "t": "receipt",  "receipt": <signed blob> }
{ "t": "error",    "code": "payment_required" | "upstream" | "bad_request" | "busy", "message": "…" }
```

Every sealed response ends with a `receipt` event in the final frame (also on
`error`), except `open`/`status`, which end with their own event as final.

### 5.3 Endpoints (runner)

| Method/path                    | Auth            | Plaintext request → events |
|--------------------------------|-----------------|----------------------------|
| `POST /v1/sessions`            | base mode       | `{client_nonce}` → `open` |
| `POST /v1/sessions/status`     | PSK             | `{}` → `status` |
| `POST /v1/chat/completions`    | PSK             | OpenAI chat request (`stream` honored; runner forces `stream_options.include_usage=true` upstream) → `chunk`* / `response`, then `receipt` |
| `GET /v1/models`               | none            | OpenAI models list (public) |
| `GET /.well-known/gpubnb/attestation` | none     | signed doc (§3) |
| `GET /.well-known/gpubnb/info` | none            | public info |

Offer payload (DOMAIN `gpubnb-offer-v1`): `{ "session_id", "subaddress",
"price": {in_per_m,out_per_m}, "hpke_pub", "created_at", "expires_at" }`.

Receipt payload (DOMAIN `gpubnb-receipt-v1`): `{ "session_id", "seq",
"tokens_in", "tokens_out", "debit_piconero", "cumulative_debit_piconero",
"balance_piconero", "ts" }`. `seq` strictly increases per session;
`cumulative_debit_piconero` never decreases.

## 6. Metering

- Price is piconero per 1,000,000 tokens, separately for input and output.
  `cost = ceil(tokens_in * in_per_m / 1e6) + ceil(tokens_out * out_per_m / 1e6)`.
- On request: `reserve = cost(prompt_tokens_estimate, max_tokens ?? default_max)`;
  if `balance - reserved < reserve` → `error payment_required` + receipt.
  On completion settle to actual usage from upstream `usage`; release the rest.
- Credit arrives only from transfers with `confirmations >= K` (config, default 10);
  keyed by `(txid, subaddr_major, subaddr_minor)`, credited once. A transfer
  that disappears (reorg) is un-credited; balance may go negative.

## 7. Monero

- Runner config holds the host's primary address + private view key + node URL.
- Wallet: view-only `monero-wallet-rpc` (bundled / in PATH) opened with
  `generate_from_keys`; one subaddress per session via `create_address` with
  `label = session_id`; the label is how sessions are re-linked after a restart.
- Watcher polls `get_transfers {in, pool}` + `get_height`; credits per §6.
- Stagenet for development (`network = "stagenet"`). `--simulate` additionally
  allows `xmr.mode = "free"` which credits every session a fixed balance —
  refused unless `--simulate`.

## 8. Model digest

`model_digest = SHA256` over the sorted list of `(relative_path, SHA256(file))`
pairs of the weights directory, encoded as `path || 0x00 || sha256 || 0x0a`
per entry. `models.json` (signed, DOMAIN `gpubnb-models-v1`) maps model id →
digest; the runner refuses to start when the configured model's digest is not
listed, unless `--simulate`.

## 9. Marketplace API (worker)

Host auth: `Authorization: Bearer gb_…` (token minted in the dashboard).

| Method/path | Auth | Body / result |
|---|---|---|
| `GET /api/listings?simulated=1&gpu=&model=` | none | `{ listings: [...] }` (simulated hidden unless asked) |
| `GET /api/listings/:id` | none | listing + latest doc + verdict |
| `GET /api/golden` | none | signed golden blob |
| `GET /api/models` | none | signed models blob |
| `GET /api/rate/xmr` | none | `{ usd_per_xmr_micro }` |
| `POST /api/disputes` | none | `{ listing_id, offer: blob, tx_proof }` |
| `PUT /api/listings/:slug` | gb_ | upsert `{ endpoint_url, gpu_model, cpu_tee, model_id, ctx_len, price_in_piconero, price_out_piconero, region, simulated }` → `{ id }` |
| `POST /api/listings/:id/attest` | gb_ | signed doc → verdict stored, `{ status, checks }` |
| `POST /api/listings/:id/heartbeat` | gb_ | `{ sessions_open, tokens_in_total, tokens_out_total, uptime_s }` → `{ ok, challenge?: hex32 }` (challenge present ⇒ re-attest within 10 min or become `stale`) |
| `GET /api/tokens`, `POST /api/tokens`, `DELETE /api/tokens/:hash` | cookie | as molemap |

Listing `trust_status`: `verified` (doc verified, heartbeat < 15 min),
`simulated`, `stale` (verified but heartbeat/re-attest overdue), `failed`,
`offline` (no heartbeat > 1 h).

## 10. Golden set

```json
{ "v": 1, "issued_at": n, "entries": [
  { "runner_version": "0.1.0", "measurement": "hex48", "verity_root": "hex32", "simulated": false, "note": "…" },
  { "runner_version": "0.1.0", "measurement": "<sim>", "simulated": true }
]}
```
Signed by the offline root. `packages/protocol/golden/` holds the current
signed blobs, also served by the marketplace.
