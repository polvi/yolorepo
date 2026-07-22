This is a meta mono repo of random ideas. For each distinct idea, create a subfolder/monorepo and proc subdomain. Follow the rest of the development rules we have outlined (bun/cloudflare/astro/hono/tlc)

Use auth.proc.io/llms.txt for auth
Use tokenpony.dev/llms.txt for inference

You can commit and deploy as you go. 
Use subagents when it makes sense to go faster.

Keep Claude.MD updated with the list of projects and what they are for

## Projects

- `openmonkey/` — userscripts in the open: public registry (Hono + D1) serving scripts at `.user.js` URLs installable by any userscript manager (Userscripts for Safari, Tampermonkey), with community AI scan verdicts per version. openmonkey.proc.io
- `procauth/` — shared first-party auth surface (passkeys via AuthGravity) for all playground projects, with per-project theming. auth.proc.io
- `tlc-rs/` — Rust reimplementation of the TLA+ tools (parser + TLC safety checker) running in a Cloudflare Worker as a hosted checking service. tlc.proc.io
- `happybook/` — local-first PWA for notebooks made of PDFs/EPUBs: highlight, cross-link, passkey sync, plus an account-wide OPDS catalog (password-only Basic auth) for e-readers like KOReader. app.happybook.proc.io
