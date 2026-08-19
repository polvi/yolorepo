# gpubnb — Airbnb for confidential GPUs

**gpubnb.proc.io** is an open marketplace of *attested inference endpoints*.
Anyone with a confidential-compute-capable NVIDIA GPU (RTX PRO 6000 Blackwell
Server Edition first; H100/H200/B200/B300 too) inside an AMD SEV-SNP
confidential VM can run the open-source runner and list an OpenAI-compatible
endpoint. Renters stay anonymous: their browser or SDK verifies the hardware
attestation itself, sends prompts sealed to a key that only exists inside the
enclave, and pays the host directly in Monero per token.

The marketplace never sees prompts and never touches money. It is a
directory, a verifier, and a reputation ledger.

```
  host box (untrusted operator)                       renter (anonymous)
 ┌──────────────────────────────────────┐
 │ SEV-SNP confidential VM              │     1. fetch listing + signed attestation doc
 │  ┌────────────────────────────────┐  │     2. verify in YOUR client:
 │  │ gpubnbd  (open source, Rust)   │  │          SNP chain → AMD root, policy, golden measurement
 │  │  keys: X25519 HPKE + Ed25519   │◄─┼──────   GPU EAT → NVIDIA NRAS keys, nonce, secboot, no devtools
 │  │  vLLM / llama-server           │  │          keys bound into REPORT_DATA + GPU nonce
 │  │  view-only monero-wallet-rpc   │  │     3. HPKE-seal prompts to the enclave key (PSK session)
 │  └───────────┬────────────────────┘  │     4. pay the host's per-session XMR subaddress
 │   RTX PRO 6000 Blackwell SE, CC on   │        tokens metered, signed receipts inside the stream
 └──────────────┼───────────────────────┘
                │ attestation doc, heartbeats (gb_ token)
                ▼
        gpubnb.proc.io  — directory · verifier · reputation · signed golden set
```

## Layout

| Path | What |
|---|---|
| `PROTOCOL.md` | **Normative** wire formats: signed blobs, binding, attestation doc, verification checks, HPKE sessions/frames, metering, Monero, marketplace API. |
| `apps/web/` | Marketplace: one Cloudflare Worker (Hono + D1) + vanilla-TS SPA. Host accounts via passkeys ([AuthG](https://authgravity.org)), `gb_` bearer tokens for runners, in-browser Verify panel and an XMR-paid chat demo. |
| `packages/protocol/` | `@gpubnb/protocol`: schemas, binding, SNP + NVIDIA EAT verifiers (pinned AMD/NVIDIA roots), HPKE session/stream format, signed golden set + model catalog. Shared by worker and SDK. |
| `packages/client/` | `@gpubnb/client`: renter SDK (browser + bun) and the `gpubnb` CLI (`ls`, `verify`, `session`, `chat`). |
| `runner/` | `gpubnbd`, the Rust runner that lives inside the CVM; `runner/image/` is the deterministic CVM image plan whose measurement becomes "golden". |
| `specs/` | TLA+ model of metering: confirmations, reorgs, reserve/settle, receipts, crash/restore. |
| `fixtures/` | Cross-language test vectors (TS ↔ Rust). |

## Trust model in one paragraph

The runner generates ephemeral keys at boot and commits to them in
`binding = SHA256(hpke_pub ‖ sign_pub ‖ boot_nonce ‖ H(runner_version) ‖ model_digest)`.
That binding (plus an optional challenge) is what goes into the SEV-SNP
`REPORT_DATA` and the NVIDIA GPU attestation nonce, so a verifier who checks
the SNP chain (VCEK → ASK → ARK), the policy bits (no debug, no migration), the
launch measurement against the **offline-signed golden set**, and the NVIDIA
EAT (signature against NRAS keys, nonce match, `measres`, `secboot`,
`dbgstat == disabled`, hardware model allowlist; devtools mode always fails)
knows that *these* keys belong to *that* runner image on *that* GPU in CC
mode. Everything the renter sends is HPKE-sealed to `hpke_pub`; after session
open it switches to PSK mode, so even the host's own TLS terminator can
neither read prompts nor spend the session. Receipts are Ed25519-signed by
`sign_pub` and travel inside the encrypted stream.

The golden set and model catalog are signed by a key that is **not** on the
marketplace (`kid gpubnb-root-2026`, pinned in the SDK), so compromising
gpubnb.proc.io cannot mint a golden image. A separate, deliberately public dev
root signs `--simulate` docs; those listings are marked SIMULATED and hidden
by default.

## Host quick start

1. Sign in at gpubnb.proc.io → Host → mint a `gb_` token.
2. Real hardware: follow `runner/README.md` (SEV-SNP host, GPU bound to
   vfio-pci, `nvidia_gpu_tools.py --set-cc-mode=on`, boot the gpubnb CVM
   image with the GPU passed through). Development: `gpubnbd run --config
   gpubnbd.toml --simulate` against any OpenAI-compatible server (pi-local's
   llama-server works), Monero **stagenet**.
3. Put your XMR primary address + private **view** key + a TLS remote node in
   the config; the runner derives one subaddress per renter session.
4. The runner registers the listing, attests, and heartbeats every 5 minutes.

## Renter quick start

Browse gpubnb.proc.io, open a listing, press **Verify** (checks run in your
browser), open a session, pay the subaddress from Cake Wallet, chat. Or from
a terminal: `bunx gpubnb ls`, `bunx gpubnb verify <id>`, `bunx gpubnb chat <endpoint> "…"`.

## Limitations (read before trusting money to it)

- **The host can still turn the machine off.** Non-custodial prepay means a
  host can stop serving after you pay. Keep top-ups small; signed offers +
  receipts feed reputation and disputes, nothing more.
- **Side channels.** The host sees traffic volume and chunk timing (≈ token
  counts), payment amounts and timing. It cannot read prompts, weights in
  VRAM, or guest RAM.
- **SEV-SNP only in v1.** Intel TDX quote verification is next. Multi-GPU CC
  is HGX-only; RTX PRO 6000 is one GPU per VM.
- **The real runner image has not been measured on hardware yet.** Until a
  golden measurement for a real image is published, only simulated listings
  can exist. The verifiers are written against the AMD/NVIDIA specs and
  tested with sample material; see the package READMEs for what is real vs
  synthetic.
- **Ledger lives in RAM.** A VM restart rebuilds credits from the chain;
  unsnapshotted debits are the host's loss, never the renter's.
- No marketplace fee. Payments never pass through gpubnb.

Auth by [AuthG](https://authgravity.org). An [Infinite Logic PBC](https://infinitelogic.org) experiment.
