# tlc-rs

A ground-up Rust reimplementation of the TLA+ tools (SANY's parser/level
checker and TLC's finite-state safety model checker), built to run inside a
Cloudflare Worker (wasm32) as a hosted checking service, with the same engine
doubling as a native CLI.

**Scope (v1): the safety subset.** Full TLA+ expression parsing, semantic and
level checking, explicit-state BFS with `INVARIANT` checking, `[][A]_v`
box-action `PROPERTY` checking per transition, deadlock detection,
`CONSTANT`/`CONSTRAINT`/`ACTION_CONSTRAINT`, and shortest-path error traces.
No liveness/fairness, no symmetry, no simulation, no parameterized
`INSTANCE ... WITH`.

## Layout

- `crates/tlc-core`: the engine: lexer, parser (precedence-range climbing +
  column-aligned junction lists), semantic analysis, values/fingerprints,
  evaluator, BFS checker. No filesystem, threads, or clocks; wasm32-clean.
- `crates/tlc-cli`: native CLI (`tlc-rs parse|check`).
- `crates/tlc-diff`: differential-testing harness: runs Java TLC
  (`-tool -workers 1 -fp 0`) as the oracle and compares results.
- `worker/`: the tlc.proc.io Cloudflare Worker (routing, auth, hub).
- `engine/`: the tlc-engine Cloudflare Worker (the wasm checker), reached
  from `worker/` over a service binding so checks run in their own isolate.
- `tests/corpus/`: vendored tree-sitter-style parser corpus (182 tests).
- `tests/model/`: safety-only conformance cases mined from tlaplus
  `test-model/` (see `tools/mine_testmodel.sh`).

## Conformance

Correctness is established differentially against the Java implementation:

1. Parser: accept/reject parity on the corpus (`cargo test --test corpus`),
   modulo SANY's own documented disagreements and out-of-scope proof syntax.
2. Checker: verdict, distinct-state count, states-generated, init-state
   count, and trace length must match Java TLC exactly on the mined cases
   (`cargo run -p tlc-diff -- sweep tests/model`, `TLC_JAR` selects the jar).

## Reference

Ported from [tlaplus/tlaplus](https://github.com/tlaplus/tlaplus) (commit
`30cc36013`); `crates/tlc-core/stdlib/` contains its standard modules
verbatim. See the source headers for the specific Java files each Rust module
is grounded in.
