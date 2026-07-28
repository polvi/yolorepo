This is a meta mono repo of random ideas. For each distinct idea, create a subfolder/monorepo and proc subdomain. Follow the rest of the development rules we have outlined (bun/cloudflare/astro/hono/tlc)

Use auth.proc.io/llms.txt for auth
Use tokenpony.dev/llms.txt for inference

Domain configuration: every `wrangler.jsonc` is GENERATED from a sibling
`wrangler.template.jsonc` by `bun run configure` (tokens `__BASE_DOMAIN__`,
`__AUTH_ENDPOINT__`, `__D1:<key>__` resolved from `stack.config.jsonc` +
gitignored `stack.local.jsonc`). Edit templates, never generated files, and
never hardcode proc.io in code: browser code derives peer origins from
location.hostname, workers read vars (AUTH_ENDPOINT etc.) with proc.io
fallbacks, build-time code reads `stack.generated.json`. This keeps forks
runnable on their own domain from one untracked file (see FORKING.md).

You can commit and deploy as you go. 
Use subagents when it makes sense to go faster.

Keep Claude.MD updated with the list of projects and what they are for

## Projects

- `openmonkey/` — userscripts in the open: public registry (Hono + D1) serving scripts at `.user.js` URLs installable by any userscript manager (Userscripts for Safari, Tampermonkey), with community AI scan verdicts per version. openmonkey.proc.io
- `procauth/` — shared first-party auth surface (passkeys via AuthGravity) for all playground projects, with per-project theming. auth.proc.io
- `tlc-rs/` — Rust reimplementation of the TLA+ tools (parser + TLC safety checker) running in a Cloudflare Worker as a hosted checking service; checking requires an API key (passkey account), and the wasm checker runs in a separate `tlc-engine` worker behind a service binding so the website never blocks on a heavy check. tlc.proc.io
- `happybook/` — local-first PWA for notebooks made of PDFs/EPUBs: highlight, cross-link, passkey sync, an account-wide OPDS catalog (password-only Basic auth) for e-readers like KOReader, and one-click notebook sync to USB e-readers over MTP (via the `mtp-ts` package). app.happybook.proc.io
- `sandcastle/` — memory-only replicated KV on Cloudflare: state lives purely in DO RAM (no storage/KV/D1/R2), kept alive by a 3-replica ring with quorum writes, epoch-tagged versions, Paxos-style collect/announce recovery, and gossip; loss on total death is the accepted design. Currently design-phase only: `DESIGN.md` + model-checked `specs/Handoff.{tla,cfg}` (TLC caught a real snapshot/in-flight-delivery race, see DESIGN.md §7). Future home sandcastle.proc.io.
- `devpod/` — persistent Claude Code environment in the `proc-proc-dev` k8s cluster: single-replica Deployment (stock `debian:bookworm`, no custom image) with a 50Gi PVC home, idempotent bootstrap that installs tmux/bun/Claude Code, and helper scripts (`devpod/bin/devpod-{up,attach,shell,sync-claude}`) so sessions in tmux survive the laptop going down. Infra-only, no proc subdomain.
- `mtp-ts/` — MTP (Media Transfer Protocol) over WebUSB, packaged as a raw-TS library (`exports: src/index.ts`, consumed by happybook via a `file:` dependency). Protocol core (PTP containers, transactions, sessions) plus `MtpFs`, a path-based readdir/stat/readFile/writeFile/mkdirp/rm layer with overwrite semantics for sync use cases. Verified byte-exact on real hardware; TLA+ spec of the session/transaction machine in `specs/`. Demo file browser: `bun serve.ts` on :8321, deployed at mtp.proc.io (`bun run deploy`).
