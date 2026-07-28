# forkable

Git-native, self-editing websites. Every site is a git repository of plain
HTML/CSS/JS files; the repository's `main` branch **is** the live site,
served at `<site>.forkable.proc.io`. Any visitor can change a site by
talking to an LLM in an overlay panel — the moment they do, they silently
fork: the repo is cloned into their browser, the LLM edits files and
commits, and a service worker shows their version in place of the original.
Drafts push to the server as per-user refs, so they survive cleared caches
and follow you across devices. Git is the substrate; users never see it.

New sites are forks of the seed site at `start.forkable.proc.io` — real git
ancestry, which is what will make cross-site forks and merge proposals
("propose the live site take my changes") work later.

## How it fits together

- **One worker** (`apps/web`) host-dispatches: `forkable.<base>` is the
  dashboard, `*.forkable.<base>` serves sites. Serving reads blobs straight
  from the repo; HTML gets `<script src="/__forkable__/widget.js">` injected
  via HTMLRewriter.
- **One Durable Object per repo** (`worker/git/`): a hand-rolled git
  smart-HTTP server over DO SQLite — pkt-line, pack read (incl. deltas from
  native git), pack write (no deltas, stored-bytes copied verbatim),
  upload-pack, receive-pack with per-ref permissions (`main` = owner only,
  `refs/forks/<uid>` = that user only, old-oid CAS always). isomorphic-git
  and native git both clone/push against it; `test/` runs both.
- **Browser editor** (`src/`): isomorphic-git clone into lightning-fs, chat
  panel runs a tool loop (`list/read/write/delete_file`) against the working
  tree, commits and force-pushes the draft, service worker serves the
  checkout. Anyone can also just `git clone
  https://<site>.forkable.proc.io/__forkable__/git`.
- **Auth**: passkeys via the stack's procauth/AuthGravity; the cookie is
  registrable-domain-scoped so one sign-in covers every site.
- **Inference**: TPX (tokenpony.dev) — the browser is the OAuth client and
  pays with a user-granted budget; the backend holds no LLM credentials.
- **Spec**: `specs/ForkRefs.tla` model-checks the ref-update protocol
  (CAS pushes, per-ref permissions, the future merge-proposal action).

## Dev

```sh
bun install
cd apps/web
bun run dev        # builds client bundles, generates a routes-free
                   # wrangler.dev.jsonc, starts wrangler dev on :8787
```

Dashboard at `http://localhost:8787`, sites at `http://<site>.localhost:8787`.
Set `DEV_USER_ID=<anything>` in `apps/web/.dev.vars` to skip real auth
locally. Apply migrations with
`bunx wrangler d1 migrations apply forkable --local -c wrangler.dev.jsonc`.
TPX registration needs an https origin, so grant/chat flows are exercised on
the deployed site. `bun run test` runs the git server suite
(vitest-pool-workers, isomorphic-git as the client); `bun test` at the repo
root covers the shared package.

Deploying to a fork's own domain needs two manual zone steps (wildcard DNS +
an ACM cert) — see ../FORKING.md.
