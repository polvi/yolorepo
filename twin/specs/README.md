# twin specs

## TwinPublish.tla

Models the publish protocol for twin's R2-backed scene storage. One scene
slug maps to three logical objects, each written atomically with strong
read-after-write consistency:

- **ARTIFACT**, the Gaussian-splat bytes
- **META**, scene metadata naming/describing the artifact
- **INDEX**, the global scene listing

The publisher (the CLI publish script) writes in strict order
`ARTIFACT=v`, then `META=v`, then the INDEX entry pointing at `v`.
A republish repeats the sequence with `v+1`, overwriting objects in
place. Readers (the web worker and browser) traverse INDEX, then META,
then ARTIFACT as separate non-atomic reads, so a republish can
interleave anywhere in a read sequence.

The model is finite: one slug, up to `MaxV = 2` publishes, two readers
each performing one full read sequence (`TwinPublish.cfg`).

### Invariants

- **NoDanglingIndex**: if the INDEX lists the scene, its META and
  ARTIFACT objects exist. A discovered scene is always loadable.
- **MetaNeverAheadOfArtifact**: at every state, the stored META's
  version is at most the ARTIFACT's version. META never describes bytes
  that have not been written; this is exactly what the
  artifact-before-meta write order buys.
- **ReaderSafety**: a reader that completes its sequence may observe
  stale meta paired with newer bytes (`rMeta <= rArt`, harmless), but
  can never observe meta describing an artifact newer than the bytes it
  fetched. Holds because artifact versions only increase and META never
  leads ARTIFACT.

### Status

Checked with TLC via the tlc.proc.io MCP tools: **passing**, 360 states
generated, 201 distinct, search depth 13. The exact passing spec and
config live here as `TwinPublish.tla` / `TwinPublish.cfg`. Published at
[tlc.proc.io/hub](https://tlc.proc.io/hub/623f9b12-a08b-4b6d-850a-29d58934eb61/TwinPublish).
