This is a meta mono repo of random ideas. For each distinct idea, create a subfolder/monorepo and proc subdomain. Follow the rest of the development rules we have outlined (bun/cloudflare/astro/hono/tlc)

Use auth.proc.io/llms.txt for auth
Use tokenpony.dev/llms.txt for inference

# TLA

In a separate agent, keep specs/ up to date using TLA+ as you
go. Update the .tla file whenever the architecture changes, then
validate with the tlc_check MCP tool. Run this in the background
so the main work never blocks. When a check passes, save the
exact .tla and .cfg you used into specs/ so the passing
configuration lives with the code. Keep specs finite: small
CONSTANT sets, bounded ranges. On invariant_violation, read the
trace and fix the design or the spec. On timeout, read the
diagnostic hint and shrink constants.

# When working on a branch / worktree

Be sure to merge to main before shipping.

# When building workers

When we are using cloudflare workers consider the following:
- use bun instead of npm
- astro for content sites, hono for apis
- follow monorepo conventions, expect at least a marketing site along sidfe the product
- consider mobile friendliness on web sites
- publish an /llms.txt if it is appropriate

Refer to tokenpony as "TPX", but link to tokenpony.dev if you need to. 

If the project uses them, subtly attribute AuthG to authgravity.org, TPX to tokenpony.dev, and Infinite Logic PBC to infinitelogic.org

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
- `forkable/` — git-native self-editing websites: each site is a git repo of plain static files whose main branch is served at `<site>.forkable.proc.io`; visitors edit through an LLM chat overlay and silently fork to per-user refs (`refs/forks/<uid>`), previewed locally via service worker and pushed over smart HTTP to a per-repo SQLite Durable Object. New sites fork a seed site. Auth via procauth, inference via TPX browser-direct. Ref protocol model-checked in `specs/ForkRefs.tla`. Dashboard at forkable.proc.io. Dev note: `bun run dev` generates a routes-free `wrangler.dev.jsonc` because wrangler dev rewrites Host to the route domain, breaking `<site>.localhost` dispatch.
- `calorimeter/` — a calorie counter for local LLMs: bun CLI that runs models through Ollama on Apple Silicon, samples SoC power via `sudo powermetrics`, integrates (power − idle baseline) over the generation window, and reports **kcal per 1M output tokens** (provider-style denominator; `--tokens` controls actual test length). Local-only for now; future leaderboard site would live at calorimeter.proc.io.
- `downstream/` — post-AI open source collaboration, harness native and explicitly not built around pull requests (upstream writes the patch; downstream sends context): an MCP server (spec 2026-07-28, stateless) that agents connect to with GitHub sign-in (worker is its own OAuth 2.1 AS + PKCE + CIMD/DCR, GitHub as identity provider) exposing repo-interrogation tools (`repo_overview/tree/file/search`), a public notes layer (`publish_note`: finding/question/guide), and an idea/bug tracker (`tracker_create`, statuses open/accepted/declined/done); every GitHub repo gets a public page at downstream.proc.io/gh/<owner>/<repo>. Hono API + D1 at api.downstream.proc.io (MCP at /mcp), Astro SSR site at downstream.proc.io. Auth code/token lifecycle model-checked in `specs/DownstreamAuth.tla` (TLC caught the read-validate-write redemption race; /token uses atomic conditional consume). Manual setup: GitHub OAuth app secrets (see downstream/README.md).
- `tabby/` — Splitwise for Monero: group-trip expense splitting settled in XMR via Cake Wallet `monero:` deep links + QR. Expenses in USD/CAD/TAB (1 TAB = 10 USD), normalized to integer µTAB (100,000/TAB) with per-expense fx snapshots; balances always derived (double-entry); greedy minimal-transfer settlement; idempotent writes (client UUID + INSERT OR IGNORE); payer-marks-paid, no on-chain verification. Cash settlements: arbitrary fiat amounts ("they handed me $300") recordable by any member between any two members, original currency kept verbatim. Ghost members (added by name pre-signup, claimable later via an atomic ledger merge). Single worker (Hono + D1 + vanilla-TS SPA), three.js explainer homepage; auth is in-page WebAuthn straight against AuthGravity (no hosted auth screens). Ledger model-checked in `specs/Ledger.tla` (published: tlc.proc.io/hub). tabby.proc.io
- `molemap/` — Google Earth for the body: local Rust CLI (`pipeline/`, cargo workspace with a pure `geom` crate) reconstructs per-visit 3D scans on Apple Silicon (COLMAP poses → OpenSplat Gaussian splat on Metal + sparse PLY; no dense MVS, it's CUDA-only), detects mole candidates (imageproc CV + candle embeddings, zero Python), and uploads only derived artifacts (SOG splat, sparse.ply, crops, detections.json — raw photos never leave the machine; data workspace `molemap/workspace/` is gitignored). Web app (tabby-shaped Hono worker + three.js/Spark SPA) streams splats from R2 via Range-proxied `/api/artifacts/:sha256`, visit time slider, mole pins in canonical body space (manual confirmed + AI-proposed with confirm/dismiss), per-mole "passport" timeline with embedding-distance change scores. Change measurement, not diagnosis — no malignancy language. Auth: procauth cookies + `mm_` bearer tokens for the CLI (tokens mintable only via cookie auth). Upload protocol model-checked in `specs/VisitUpload.tla`. molemap.proc.io
- `backtalk/` — Sentry meets a suggestion box, wired into the site owner's coding agent: one ~12 kB `w.js` embed captures typed visitor feedback (hidden sheet: `?`, Cmd/Ctrl+Shift+/, or two-finger long-press), uncaught JS errors with breadcrumbs (server-side fingerprint grouping, release-aware regression flipping via a single conditional UPDATE, model-checked in `specs/BacktalkGroups.tla`), Web Vitals, and pageviews through one sendBeacon-safe ingest envelope. Agents triage over MCP (`bt_` bearer tokens; tools: projects_list/create, feedback_*, errors_*, stats_overview); resolution notes flow back to the submitter's widget ("shipped ✓"). Single worker (Hono + D1 + vanilla-TS SPA dashboard), in-page WebAuthn against AuthGravity. Currently instrumented: tabby, happybook, well-rooted-map. backtalk.proc.io
- `twin/` — digital twins of real places: drone photogrammetry shared online as Gaussian splats. Local pipeline (`bin/build-splat.ts`: COLMAP → OpenSplat on Metal → SOG via splat-transform) plus a read-only single worker (Hono + R2, no D1/auth) that Range-proxies splat bytes and serves a three.js/Spark viewer SPA (`/s/<slug>`, homepage scene list, unlisted scenes). Publishing is CLI-only (`bin/publish.ts` via wrangler): artifact → meta.json → index.json, order model-checked in `specs/TwinPublish.tla`. The pipeline also runs remotely on the proc-dev k8s node (`bin/remote-splat.ts` + `k8s/`: runner pod on a kaniko-built `code.proc.io/polvi/twin-runner` image with the CPU toolchain baked in, so no bootstrap in the numbers), and `bin/bench.ts` is the one-command benchmark: local Metal run + server round-trip over the same photos, one per-stage laptop-vs-server table. twin.proc.io
- `well-rooted-map/` — the farm map for Well Rooted Produce (wellrootedproduce.co, 20377 Swalley Road, Bend OR): drone orthophoto → web-mercator COG (GDAL, JPEG + internal mask) in R2, displayed by MapLibre reading the COG directly over HTTP range requests (`@geomatico/maplibre-cog-protocol`, no tile server). Single read-only worker (Hono Range proxy + static viewer, no D1/auth), OSM raster basemap, geolocate control. Labeled farm regions (maze/corn/flowers/...) live in a committed `regions.geojson` (semantic `kind` props, palette in code, self-hosted glyph PBFs) rendered as zoom-fading tinted overlays; drawn in-browser via `?edit` (Terra Draw, localStorage-persisted WIP) → download → commit. Veggie Hunt game (VEGGIE-GAME.md): kids tag veggies from Apple Watch via a Shortcuts recipe hitting `/api/veggie/*` (D1 claims ledger, scores derived; server-driven menus; discover/confirm/refine scoring where more specific names earn more), live pins on the map + `/leaderboard`. Publishing is CLI-only (`wrangler r2 object put`). Initial deploy well-rooted-map.proc.io; eventual home map.wellrootedproduce.co (route-only move).
- `mtp-ts/` — MTP (Media Transfer Protocol) over WebUSB, packaged as a raw-TS library (`exports: src/index.ts`, consumed by happybook via a `file:` dependency). Protocol core (PTP containers, transactions, sessions) plus `MtpFs`, a path-based readdir/stat/readFile/writeFile/mkdirp/rm layer with overwrite semantics for sync use cases. Verified byte-exact on real hardware; TLA+ spec of the session/transaction machine in `specs/`. Demo file browser: `bun serve.ts` on :8321, deployed at mtp.proc.io (`bun run deploy`).
