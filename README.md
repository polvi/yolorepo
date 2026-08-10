# yolorepo

A meta monorepo of random ideas. Each top-level folder is a self-contained
project (usually its own bun workspace) deployed to a `*.proc.io` subdomain on
Cloudflare Workers. Designs are model-checked with TLA+ as they evolve; each
project keeps its passing spec and config in a `specs/` folder.

## Projects

| Project | What it is | Live |
| --- | --- | --- |
| [`openmonkey/`](openmonkey/) | Userscripts in the open: a public registry serving installable `.user.js` URLs, with community AI scan verdicts per version. | [openmonkey.proc.io](https://openmonkey.proc.io) |
| [`procauth/`](procauth/) | Shared passkey auth surface for all proc.io projects, with per-project theming. | [auth.proc.io](https://auth.proc.io) |
| [`tlc-rs/`](tlc-rs/) | Rust reimplementation of the TLA+ tools (parser + TLC safety checker), running natively and as a hosted checking service in a Cloudflare Worker. | [tlc.proc.io](https://tlc.proc.io) |
| [`happybook/`](happybook/) | Local-first PWA for notebooks made of PDFs/EPUBs: highlights, cross-links, passkey sync, an OPDS catalog for e-readers, and USB e-reader sync over MTP. | [happybook.proc.io](https://happybook.proc.io) |
| [`mtp-ts/`](mtp-ts/) | MTP (Media Transfer Protocol) over WebUSB as a TypeScript library: protocol core plus a path-based filesystem layer. Verified on real hardware. | [mtp.proc.io](https://mtp.proc.io) |
| [`sandcastle/`](sandcastle/) | Memory-only replicated KV on Cloudflare Durable Objects: no persistent storage, a 3-replica ring keeps state alive. Design phase. | — |
| [`forkable/`](forkable/) | Git-native self-editing websites: sites are repos of plain files served from their main branch; visitors edit by chatting with an LLM and silently fork. | [forkable.proc.io](https://forkable.proc.io) |
| [`downstream/`](downstream/) | Post-AI open source collaboration: an MCP server your coding harness signs into with GitHub to interrogate repos and publish findings, questions, ideas, and bugs on public per-repo pages. Send context, not patches. | [downstream.proc.io](https://downstream.proc.io) |
| [`tabby/`](tabby/) | Splitwise for Monero: split trip expenses in USD/CAD/TAB, get a minimal set of transfers, and pay each other in XMR via Cake Wallet deep links + QR. | [tabby.proc.io](https://tabby.proc.io) |

## Stack

- [bun](https://bun.sh) for package management and scripts
- [Cloudflare Workers](https://workers.cloudflare.com) for hosting (Astro for
  content sites, Hono for APIs)
- [AuthGravity](https://authgravity.org) for passkey auth, via the shared
  `procauth` surface
- [TPX](https://tokenpony.dev) for user-granted AI inference where projects
  need it
- TLA+ (checked with `tlc-rs` itself) for design verification

## Develop

Run `bun run configure` once after cloning — it renders each app's
`wrangler.jsonc` from its `wrangler.template.jsonc` using
`stack.config.jsonc` (plus your `stack.local.jsonc` override, if any). Then
each project has its own README with setup instructions. In general:

```sh
bun run configure   # once, at the repo root
cd <project>
bun install
bun run dev
```

## Fork it

The stack runs on any domain: your fork's entire divergence from this repo
is one untracked file, so pulling upstream stays clean. See
[FORKING.md](FORKING.md).

## License

AGPL-3.0-or-later (see [LICENSE](LICENSE)).
