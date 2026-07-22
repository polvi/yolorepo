# procauth

The proc.io-wide auth surface: first-party sign-in, registration, and account
management for every project in this playground, served at
[auth.proc.io](https://auth.proc.io).

Built on [AuthGravity](https://authgravity.proc.io)'s raw API (passkeys,
12-word account keys, silent device keys) instead of its hosted pages. The
`session_id` cookie lives on the `proc.io` registrable domain, so one sign-in
here is valid on every `*.proc.io` app.

## Integrating an app

Link to the surface with a `return_to` back to your app (must be `https`
on `proc.io` or a subdomain):

- `https://auth.proc.io/login?return_to=https://yourapp.proc.io/somewhere`
- `https://auth.proc.io/register?return_to=…`
- `https://auth.proc.io/account` — credentials, recovery keys, sign out

The surface lightly skins itself per project: register a palette in
`apps/web/src/lib/theme.ts` keyed by your `*.proc.io` hostname (resolved from
`return_to`, rendered server-side), or pass sanitized query overrides
(`?app=name&accent=hex&bg=hex…`). Colors and an app-name chip only — the page
structure always stays auth.proc.io.

Validate sessions server-side by forwarding the incoming `Cookie` header to
`https://authgravity.proc.io/v1/whoami` (401 = signed out). Client-side, the
same endpoint with `credentials: "include"` powers signed-in nav states.

See [/llms.txt](https://auth.proc.io/llms.txt) for the agent-readable version.

## Layout

- `apps/web` — Astro on Cloudflare Workers, the whole surface.
- `specs/` — TLA+ model of the ceremony/session lifecycle.
