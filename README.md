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
| [`mtp.js/`](mtp.js/) | MTP (Media Transfer Protocol) over WebUSB as a TypeScript library: protocol core plus a path-based filesystem layer. Verified on real hardware. | — |
| [`sandcastle/`](sandcastle/) | Memory-only replicated KV on Cloudflare Durable Objects: no persistent storage, a 3-replica ring keeps state alive. Design phase. | — |

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

Each project has its own README with setup instructions. In general:

```sh
cd <project>
bun install
bun run dev
```

## License

MIT (see [LICENSE](LICENSE)), except `tlc-rs/`, which is licensed under
AGPL-3.0 (see [tlc-rs/LICENSE](tlc-rs/LICENSE)).
