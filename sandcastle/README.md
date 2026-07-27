# sandcastle

A memory-only replicated KV store on Cloudflare: state lives purely in
Durable Object RAM, with no storage, KV, D1, or R2 behind it. A 3-replica
ring keeps the data alive through quorum writes, epoch-tagged versions,
Paxos-style collect/announce recovery, and gossip. Like a sandcastle, it
stands only while something keeps it standing: if every replica dies at
once, the data is gone, and that loss is the accepted design.

Currently design phase only; nothing is deployed.

- [`DESIGN.md`](DESIGN.md) — the full design: ring membership, write/read
  paths, epoch recovery, failure analysis. Section 7 covers a real
  snapshot/in-flight-delivery race that TLC caught in the handoff protocol.
- [`specs/Handoff.tla`](specs/Handoff.tla) — TLA+ model of replica handoff,
  with the passing TLC config in `specs/Handoff.cfg`.
