# Running the stack on your own domain

This repo is designed so a fork can run everything on its own domain while
staying mergeable with upstream: **your fork's entire divergence is one
untracked file**, `stack.local.jsonc`. No tracked file ever contains your
domain, so `git pull upstream main` stays clean and PRs back upstream carry
no domain noise. The upstream proc.io deployment goes through the exact same
mechanism, so it can't silently regress.

## How it works

- `stack.config.jsonc` (tracked) holds the upstream defaults: base domain,
  auth endpoint, D1 database IDs.
- `stack.local.jsonc` (gitignored) deep-merges over it with your values.
- `bun run configure` renders every `wrangler.template.jsonc` into a sibling
  `wrangler.jsonc` (gitignored) and writes `stack.generated.json` for
  build-time consumers. Templates are the tracked source of truth; never
  edit a generated `wrangler.jsonc`.
- Browser code derives peer origins from its own hostname at runtime, worker
  code reads them from injected vars, so most of the stack needs no
  configuration at all.

Subdomains are fixed by convention off your base domain: `auth.<base>`,
`openmonkey.<base>`, `api.openmonkey.<base>`, `happybook.<base>`,
`app.happybook.<base>`, `tlc.<base>`, `mtp.<base>`, and
`authgravity.<base>` for the auth backend.

## Setup

Prerequisites: [bun](https://bun.sh), a Cloudflare account with your domain's
zone active on it, and `wrangler login` completed (any project's
`node_modules` has wrangler after `bun install`).

1. **Fork and clone**, then create your one local file:

   ```sh
   cp stack.local.example.jsonc stack.local.jsonc
   # edit baseDomain; leave "d1": {} so databases auto-provision
   ```

2. **Stand up AuthGravity on your domain** at `authgravity.<yourdomain>`.
   The whole stack's passkey single sign-on rides a session cookie scoped to
   the registrable domain, so every app and the AuthGravity deployment must
   share one registrable domain — pointing at someone else's AuthGravity
   (including upstream's) cannot work. See
   [authgravity.org](https://authgravity.org) for deployment options; if
   yours lives at a different host on your domain, set `authEndpoint` in
   `stack.local.jsonc`.

3. **Configure and deploy:**

   ```sh
   bun run configure
   cd procauth   && bun install && bun run deploy   # auth surface first
   cd ../openmonkey && bun install && bun run deploy
   cd ../happybook  && bun install && bun run deploy
   cd ../mtp-ts     && bun install && bun run deploy
   cd ../tlc-rs/worker && bun install && bunx wrangler deploy   # needs the wasm engine; see tlc-rs/README
   ```

   Custom domains are attached automatically by wrangler because the zone is
   on your account. Missing D1 databases and R2 buckets are provisioned on
   first deploy; afterwards run `bunx wrangler d1 list` and paste the created
   IDs into the `d1` map in `stack.local.jsonc` so later deploys reuse them.

4. **forkable only — wildcard subdomain, two manual zone steps.** Sites are
   served at `<site>.forkable.<base>`, which wrangler cannot fully set up:

   - DNS: add a proxied record covering the wildcard, e.g. type `AAAA`,
     name `*.forkable`, value `100::`, proxy ON.
   - TLS: Universal SSL covers only one label (`*.<base>`), so
     `*.forkable.<base>` needs Advanced Certificate Manager (or Total TLS):
     SSL/TLS → Edge Certificates → Order Advanced Certificate with
     hostnames `*.forkable.<base>` and `forkable.<base>`.

   ```sh
   cd ../forkable && bun install && bun run deploy
   bunx wrangler d1 migrations apply forkable --remote
   ```

5. **Pull upstream whenever:**

   ```sh
   git pull upstream main
   bun run configure
   # redeploy whatever changed
   ```

## What still says proc.io

Grep will find `proc.io` in three legitimate places: localhost/dev fallback
literals (so `wrangler dev` and `bun run dev` work without configuration),
prose and TLA+ specs describing the canonical deployment, and the published
userscript sources in `openmonkey/userscripts/` — those are rewritten to the
serving deployment's domain at serve time, so installs from your fork target
your fork.

TPX ([tokenpony.dev](https://tokenpony.dev)) needs no configuration: apps
obtain user-granted inference through OAuth dynamic client registration from
whatever origin they run on.
