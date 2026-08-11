# backtalk

Sentry meets a suggestion box, wired into the site owner's coding agent.
Live at [backtalk.proc.io](https://backtalk.proc.io).

Sites embed one script tag. Visitors summon a hidden sheet (Cmd/Ctrl+Shift+/,
or a two-finger long-press on touch) to submit bugs, ideas, and feedback;
uncaught JavaScript errors report themselves. A coding agent (Claude Code or
any MCP client) reads both, offers to implement fixes, and marks items done
with a note the original submitter sees in the widget: "shipped ✓". Feedback
that visibly lands begets more feedback.

## How it works

- **One embed, four signals.** `w.js` (~12 kB, zero deps) captures typed
  feedback, uncaught errors + unhandled rejections, Web Vitals (LCP/INP/CLS),
  and pageviews. Everything batches through one `POST /api/ingest` envelope,
  sent as `text/plain` so `sendBeacon` on pagehide never preflights.
- **Breadcrumbs.** A 20-entry ring buffer (clicks, navigations,
  console.errors) rides along with every error and feedback event.
- **Server-side grouping.** Errors are fingerprinted (normalized message +
  top stack frame, volatile tokens collapsed) into groups with a
  deterministic id, so concurrent ingests collide harmlessly on
  `INSERT OR IGNORE`. `event_count` is exact; only the newest 10 sample
  events are retained per group.
- **Regressions.** Resolving a group records the release it was resolved in.
  A reoccurrence in a different release (or with no release info) flips it to
  `regressed` inside a single conditional `UPDATE` — never a read-modify-write.
  Model-checked in [`specs/BacktalkGroups.tla`](specs/): TLC caught the naive
  variant silently losing the regression flag when a resolve interleaves.
- **The closed loop.** Submission ids live in the submitter's localStorage;
  the widget's "your submissions" view fetches their statuses and resolution
  notes (capability-by-UUID, no accounts for visitors).
- **Idempotent by construction.** Client-generated UUIDs +
  `INSERT OR IGNORE` make widget retries safe.
- **Works on a plane.** Feedback submitted offline is parked in a
  localStorage outbox ("Saved — you're offline") and drained automatically
  on the next page load or the moment connectivity returns; idempotent ids
  make the resend race-free.
- **Rate limiting.** Per-project per-kind daily caps counted in one UPSERT
  (feedback 200, errors 5 000, vitals/pageviews 20 000 each), plus payload
  caps and an optional exact-origin allowlist. No IPs stored, no cookies set.

## Agent side (MCP)

```
claude mcp add --transport http backtalk https://backtalk.proc.io/mcp \
  --header "Authorization: Bearer bt_..."
```

Mint `bt_` tokens in Settings (cookie-authed only; sha256 stored). Tools:
`projects_list`, `feedback_list/get/set_status`, `errors_list/get/set_status`,
`stats_overview`. See [/llms.txt](https://backtalk.proc.io/llms.txt).

## Architecture

Single Cloudflare Worker (Hono + D1) serving the ingest API, dashboard API,
MCP endpoint, and static assets: the vanilla-TS SPA dashboard plus `w.js`,
a second Vite build target (`vite.widget.config.mts`, IIFE). Auth is in-page
WebAuthn against AuthGravity ([authgravity.org](https://authgravity.org));
dashboard sessions are cookies, agents use `bt_` bearer tokens resolved
locally by hash.

## Dev

```sh
bun run configure       # repo root, once
cd backtalk && bun install
cd apps/web
echo 'DEV_USER_ID=dev-you' > .dev.vars
bunx wrangler d1 migrations apply backtalk --local
bun run dev             # builds SPA + widget, starts wrangler dev
bun run test            # vitest: fingerprint, lifecycle, ingest, tokens
```

Embed against a local project: create one in the dashboard, then point any
page at `http://localhost:8787/w.js` with its `data-key`.

## Deploy

```sh
bun run deploy          # from backtalk/, builds then wrangler deploy
bun run migrate         # remote D1 migrations
```

An [Infinite Logic PBC](https://infinitelogic.org) playground project.
