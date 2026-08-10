# tabby

Splitwise for Monero: split group-trip expenses with friends and settle up in
XMR via [Cake Wallet](https://cakewallet.com) (or any wallet that opens
`monero:` URIs). Live at [tabby.proc.io](https://tabby.proc.io).

## How it works

- Expenses are entered in **USD, CAD, or TAB** — a custom unit where
  **1 TAB = 10 USD** exactly. The ledger normalizes everything to integer
  µTAB (100,000 per TAB), so USD amounts are exact and CAD uses an
  ECB rate ([frankfurter.dev](https://frankfurter.dev)) snapshotted per
  expense.
- Balances are always **derived** from expenses + payments (double-entry,
  never stored), so there are no read-modify-write races.
- Settlement is a **greedy minimal-transfer** simplification (at most n−1
  transfers), recomputed live. Each suggested transfer renders the exact XMR
  amount at the current rate (Kraken public ticker), a `monero:` deep link
  that opens Cake Wallet on mobile, and a QR code for desktop→phone.
- The payer taps **"I paid this"** to record the payment — no on-chain
  verification. Payment and expense writes are idempotent (client-generated
  UUID + `INSERT OR IGNORE`), so double-taps and retries never double-count.
- Your Monero address is set once (with copy-from-Cake-Wallet instructions)
  and carries across trips; update it any time in the profile.
- **Ghost members**: add someone to a split by name before they've ever
  signed in. When they eventually join (via the invite link), they tap
  "This is me" and their whole ledger identity merges into their account
  atomically (overlapping shares sum, so conservation is untouched).
- Auth is fully in-page: Sign in / Create account run the WebAuthn ceremony
  directly against AuthGravity from the homepage and invite landing. No
  hosted auth screens.

## Architecture

Single Cloudflare Worker (`apps/web`): Hono API + static assets from one
origin, D1 for the ledger. Vanilla-TS SPA with hash routing; the homepage is
a three.js product explainer, lazy-loaded so app screens skip the bundle.
Passkey auth via the shared [procauth](../procauth) surface
([AuthGravity](https://authgravity.org)); the worker validates sessions by
forwarding cookies to `/v1/whoami`.

The expense/payment ledger and the mark-paid protocol are model-checked in
[`specs/`](specs/) (conservation, exact shares, settlement soundness,
payment idempotency).

## Dev

```sh
bun install
echo 'DEV_USER_ID=dev-you' > apps/web/.dev.vars   # auth escape hatch
(cd ../.. && bun run configure)                    # renders wrangler.jsonc
cd apps/web
bunx wrangler d1 migrations apply tabby --local
bun run dev
bun run test                                       # settle/money property tests
```

## Deploy

```sh
bun run deploy       # from tabby/ or tabby/apps/web
bun run migrate      # d1 migrations apply tabby --remote
```
