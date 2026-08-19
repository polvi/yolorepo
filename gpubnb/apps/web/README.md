# @gpubnb/web

The gpubnb marketplace: one Cloudflare Worker (Hono + D1) serving the public
directory/verifier API, the host API (`gb_` tokens), and the vanilla-TS SPA
(directory, in-browser verify panel, HPKE chat with XMR pay, host dashboard).
Normative protocol: `../../PROTOCOL.md` (§9 is this API).

## Dev

```sh
# once, from the repo root: renders wrangler.jsonc from wrangler.template.jsonc
bun run configure
cd gpubnb && bun install

cd apps/web
bun run dev            # vite build + wrangler dev (local D1, DEV_USER_ID=dev-alex from .dev.vars)
wrangler d1 migrations apply gpubnb --local
bun run test           # vitest: trust-status rules, schemas, llms.txt (no D1)
bun run typecheck
```

`.dev.vars` sets `DEV_USER_ID` so cookie auth is bypassed locally; never set it
in production.

## Deploy

```sh
bun run deploy         # vite build + wrangler deploy (route gpubnb.<base domain>)
bun run migrate        # wrangler d1 migrations apply gpubnb --remote
```

First deploy with an empty `d1.gpubnb` in `stack.config.jsonc` lets wrangler
provision the database; paste the id back and re-run `bun run configure`.

## Layout

- `worker/index.ts` routes; `public.ts` (no auth), `listings.ts` (host), `tokens.ts` (cookie-only),
  `attest.ts` (shared verifier + NRAS JWKS cache), `heartbeat.ts`, `trust.ts` (pure rules + zod), `db.ts`,
  `serialize.ts` (public shape, never host ids), `rates.ts` (XMR/USD), `llms.ts`.
- `src/` SPA: `main.ts` hash router, `views/*`, `lib/gp.ts` wraps `@gpubnb/client` (verification runs
  in the browser with pinned roots), `lib/sessions.ts` localStorage sessions keyed by endpoint.
- `migrations/0001_init.sql`.
