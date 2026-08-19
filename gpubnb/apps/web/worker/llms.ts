export function llmsTxt(hostname: string): string {
  const origin = `https://${hostname}`;
  return `# gpubnb

Airbnb for confidential GPUs. Hosts with confidential-computing GPUs (NVIDIA
RTX PRO 6000 Blackwell Server Edition first; H100/H200/B200/B300) inside
AMD SEV-SNP confidential VMs run an open-source runner that serves an
attested, OpenAI-compatible inference endpoint. Renters verify the hardware
attestation themselves, send HPKE-sealed prompts straight to the enclave, and
pay the host directly in Monero per token. This site is directory, verifier,
and reputation only: it never sees prompts or money, and renters need no
account.

## Trust model (short)

- The runner boots inside a CVM, generates RAM-only keys, and signs an
  attestation doc binding {hpke_pub, sign_pub, runner_version, model_digest}
  into the SEV-SNP REPORT_DATA and the NVIDIA GPU attestation nonce.
- The marketplace verifies the doc (AMD VCEK chain to pinned ARKs, policy,
  TCB floor, golden MEASUREMENT for the runner version, NVIDIA NRAS EAT
  JWTs: signature, nonce, secboot, dbgstat, hwmodel allowlist) and records a
  verdict per check. Renters re-run the same checks in their own client with
  @gpubnb/client, optionally with their own fresh challenge against the
  runner's well-known URL.
- Golden measurements and the model catalog are signed offline by a key
  pinned in the client; the marketplace merely serves the signed blobs.
- "simulated" listings carry a dev-root-signed fake report. They are hidden
  by default and never count as verified.

## Public API (no auth)

- GET  ${origin}/api/listings?simulated=1&gpu=&model=&status=  -> { listings: [...] }
- GET  ${origin}/api/listings/:id   -> listing + latest attestation blob + verdict + stats
- GET  ${origin}/api/listings/:id/attestations  -> recent verdict history
- GET  ${origin}/api/golden         -> signed golden set (verify with the pinned root)
- GET  ${origin}/api/models         -> signed model catalog
- GET  ${origin}/api/rate/xmr       -> { usd_per_xmr_micro } (display only)
- POST ${origin}/api/disputes       -> { listing_id, offer: signed blob, tx_proof, note? }

Listing JSON fields: id, slug, endpoint_url, gpu_model, cpu_tee, model_id,
model_digest, ctx_len, price_in_piconero, price_out_piconero (per 1,000,000
tokens), region, simulated, trust_status (verified | simulated | stale |
failed | offline), runner_version, hpke_pub, sign_pub, attestation (signed
blob), verdict ({status, checks[]}), verified_at, last_heartbeat, stats.

## Host API (Authorization: Bearer gb_...)

Tokens are minted in the dashboard at ${origin}/#/host (passkey account).

- PUT  ${origin}/api/listings/:slug          upsert -> { id }
- POST ${origin}/api/listings/:id/attest     signed attestation doc -> { status, checks }
- POST ${origin}/api/listings/:id/heartbeat  { sessions_open, tokens_in_total, tokens_out_total, uptime_s } -> { ok, challenge? }
  (a challenge in the response means: re-attest with it within 10 minutes or
  the listing shows as stale)
- DELETE ${origin}/api/listings/:id          remove one of your listings
- GET  ${origin}/api/host/listings           your listings with pending-challenge state

Renting is done directly against the host's endpoint with @gpubnb/client
(HPKE-sealed sessions, receipts inside the encrypted stream); see
PROTOCOL.md in the repository. The full protocol is public and the runner is
open source.

## Auth

Host accounts are passkeys via ${origin.replace(/^https:\/\/gpubnb\./, 'https://auth.')}
(AuthGravity, https://authgravity.org). Renters never sign in.

Built on Cloudflare Workers. An Infinite Logic PBC (https://infinitelogic.org)
experiment.
`;
}
