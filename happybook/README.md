# Happybook

Notebooks made of PDFs and EPUBs. Add a document to start a notebook, add more, highlight
passages, and cross-link locations between documents. Local-first PWA: fully
usable offline with no account; passkey sign-in syncs notebooks across devices.

- Marketing: https://happybook.proc.io
- App: https://app.happybook.proc.io

## Layout

- `apps/marketing` — Astro static site (assets-only Worker).
- `apps/app` — SvelteKit static SPA + Hono API in one Worker.
  `worker/` is the API (`/api/*`, D1 + R2); `src/` is the client
  (Dexie for structured state, OPFS for document bytes, pdf.js + EPUB viewers,
  SVG annotation layer, workbox service worker).
- `packages/shared` — types, zod schemas, and the LWW merge + Lamport clock
  used identically by client and server.
- `specs/` — TLA+ model of the sync protocol (TLC-checked; see Sync.tla).

## Develop

```sh
bun install
bun test                      # shared merge/clock + anchor resolution tests
cd apps/app
bun run build                 # SvelteKit → build/
bunx wrangler d1 migrations apply happybook --local
bunx wrangler dev             # serves SPA + API at localhost:8787
```

Auth notes: AuthGravity's session cookie is scoped to `.proc.io` and never
reaches localhost. `.dev.vars` sets `DEV_USER_ID` so the API treats you as a
fixed dev user locally; real passkey flows only work on deployed proc.io hosts.

## Deploy

```sh
bun run deploy                # from repo root: both workers
bunx wrangler d1 migrations apply happybook --remote   # when migrations change
```

## Sync protocol

Single LWW record stream. Every record carries `(updatedAt, writeId)`;
`updatedAt` is a Lamport-bumped wall clock, `writeId` a per-write UUID
tie-breaker. Deletes are tombstone writes. The server assigns a per-user
`seq` to accepted writes; clients pull `seq > cursor`, skipping overwrites
of dirty rows that win LWW locally. The protocol is modeled in
`specs/Sync.tla`; TLC verifies convergence, no-resurrection, log
immutability, and cursor monotonicity.
