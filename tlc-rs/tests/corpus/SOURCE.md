# Parser corpus provenance

Vendored from the tlaplus/tlaplus repository:

- Path: `tlatools/org.lamport.tlatools/test/tla2sany/corpus/`
- Commit: `30cc3601321c3fc02e044d0ecb5c58d8921e18df`

Format: tree-sitter corpus files (the `|||`-suffixed separator variant described in
the upstream `README.md`). Each test is a named TLA+ module snippet followed by an
expected S-expression parse tree whose node names come from the tree-sitter-tlaplus
grammar. Tests marked `:error` expect a parse failure.

To re-sync, re-copy the directory and update the commit hash here.
