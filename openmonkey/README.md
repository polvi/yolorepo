# openmonkey

Userscripts in the open. Greasemonkey for the AI era:

- **Creation is publication.** Write a userscript by hand or have your model generate it; either way it lands in a public registry the moment it exists.
- **Installs through the manager you already have.** Every script is served at a standard `<slug>.user.js` URL, so [Userscripts for Safari](https://github.com/quoid/userscripts), Tampermonkey, and Violentmonkey install it with one click. There is no first-party extension.
- **Foreign code gets scanned by *your* AI.** Before running someone else's script, audit the exact source with your own TPX inference grant (tokenpony by default, any OpenAI-compatible endpoint you choose) and publish the verdict (`pass` / `warn` / `fail`) back to the registry, so trust accumulates in the open.
- **Fork anything.** Every script can be forked, edited, and republished with public lineage.

Live: [openmonkey.proc.io](https://openmonkey.proc.io) · API: `api.openmonkey.proc.io/api` · [/llms.txt](https://openmonkey.proc.io/llms.txt)

## Layout

- `apps/api` — Hono worker + D1: the public registry (scripts, immutable versions, forks, scan reports, raw `.user.js` serving). Auth via [AuthGravity](https://authgravity.proc.io) passkey sessions; sign-in UI is the shared [auth.proc.io](https://auth.proc.io) surface (`../procauth`).
- `apps/web` — Astro (SSR on Workers): marketing + script directory, plus the pretty install URL `openmonkey.proc.io/scripts/<slug>.user.js`. Talks to the API over a service binding.
- `packages/shared` — types, userscript metadata parsing, reference scan/generation prompts.
- `specs/` — TLA+ model of the registry lifecycle (publish → version → fork, plus advisory per-version scan verdicts), checked with TLC.

## Develop

```sh
bun install
bun run dev:api    # wrangler dev on apps/api
bun run dev:web    # astro dev on apps/web
```

## Deploy

```sh
bun run deploy:api
bun run deploy:web
```

D1 schema: `apps/api/schema.sql` (apply with `wrangler d1 execute openmonkey --remote --file=schema.sql`).

## Known v1 limitations

- Scan verdicts are advisory: installs happen in third-party userscript managers, so the registry surfaces verdicts prominently but cannot block an install.
- Install counts are approximated by `.user.js` fetches (manager update checks inflate them slightly).
- Publishing is API-only; a web publish flow is the natural next step.
