# openmonkey

Userscripts in the open. Greasemonkey for the AI era:

- **Creation is publication.** Write a userscript by hand or describe it and your own model generates it; either way it lands in a public registry the moment it exists.
- **Foreign code gets scanned by *your* AI.** Installing someone else's script triggers a security audit through your own TPX inference grant (tokenpony by default, any OpenAI-compatible endpoint you choose). `pass` installs, `warn` needs your explicit override, `fail` never installs. Verdicts are published back to the registry so trust accumulates in the open.
- **Fork anything.** Every script can be forked, edited, and republished with public lineage.

Live: [openmonkey.proc.io](https://openmonkey.proc.io) · API: `api.openmonkey.proc.io/api` · [/llms.txt](https://openmonkey.proc.io/llms.txt)

## Layout

- `apps/api` — Hono worker + D1: the public registry (scripts, immutable versions, forks, scan reports). Auth via [AuthGravity](https://authgravity.proc.io) passkey sessions; sign-in UI is the shared [auth.proc.io](https://auth.proc.io) surface (`../procauth`).
- `apps/web` — Astro (SSR on Workers): marketing + script directory. Talks to the API over a service binding.
- `apps/extension` — cross-browser WebExtension (MV3). Safari is the first target; the same folder loads in Chrome/Firefox dev mode.
- `packages/shared` — types, userscript metadata parsing, scan/generation prompts.
- `specs/` — TLA+ model of the publish → scan → install → run → fork lifecycle, checked with TLC. The key invariant: no foreign script version ever runs without a pass (or explicitly accepted warn) scan of exactly that version.

## Develop

```sh
bun install
bun run dev:api    # wrangler dev on apps/api
bun run dev:web    # astro dev on apps/web
```

Load `apps/extension` unpacked in Chrome (`chrome://extensions`) or Firefox (`about:debugging`).

### Safari

```sh
xcrun safari-web-extension-converter apps/extension \
  --project-location build/safari --app-name OpenMonkey
```

Open the generated Xcode project, run, and enable the extension in Safari settings.

## Deploy

```sh
bun run deploy:api
bun run deploy:web
```

D1 schema: `apps/api/schema.sql` (apply with `wrangler d1 execute openmonkey --remote --file=schema.sql`).

## Known v1 limitations

- Script injection uses content-world `new Function` with a page-world `<script>` fallback; pages with strict CSP can block the fallback path.
- No GM_* API surface yet; scripts are plain DOM JavaScript.
- TPX connection is key-paste (personal key or access token); the full OAuth/PKCE grant flow in-extension is the natural next step.
