This is a meta mono repo of random ideas. For each distinct idea, create a subfolder/monorepo and proc subdomain. Follow the rest of the development rules we have outlined (bun/cloudflare/astro/hono/tlc)

Use auth.proc.io/llms.txt for auth
Use tokenpony.dev/llms.txt for inference

You can commit and deploy as you go. 
Use subagents when it makes sense to go faster.

Keep Claude.MD updated with the list of projects and what they are for

## Projects

- `openmonkey/` — userscripts in the open: public registry (Hono + D1) serving scripts at `.user.js` URLs installable by any userscript manager (Userscripts for Safari, Tampermonkey), with community AI scan verdicts per version. openmonkey.proc.io
- `procauth/` — shared first-party auth surface (passkeys via AuthGravity) for all playground projects, with per-project theming. auth.proc.io
- `tlc-rs/` — Rust reimplementation of the TLA+ tools (parser + TLC safety checker) running in a Cloudflare Worker as a hosted checking service; checking requires an API key (passkey account), and the wasm checker runs in a separate `tlc-engine` worker behind a service binding so the website never blocks on a heavy check. tlc.proc.io
- `happybook/` — local-first PWA for notebooks made of PDFs/EPUBs: highlight, cross-link, passkey sync, an account-wide OPDS catalog (password-only Basic auth) for e-readers like KOReader, and one-click notebook sync to USB e-readers over MTP (via the `webmtp` package). app.happybook.proc.io
- `webmtp/` — MTP (Media Transfer Protocol) over WebUSB, packaged as a raw-TS library (`exports: src/index.ts`, consumed by happybook via a `file:` dependency). Protocol core (PTP containers, transactions, sessions) plus `MtpFs`, a path-based readdir/stat/readFile/writeFile/mkdirp/rm layer with overwrite semantics for sync use cases. Verified byte-exact on real hardware; TLA+ spec of the session/transaction machine in `specs/`. Demo file browser: `bun serve.ts` on :8321.
