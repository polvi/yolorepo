# Replacement CLAUDE.md entry

The service is an MCP server (registered in Claude Code at user scope as
`tlc`, tools `tlc_check`, `tlc_parse`, and `tlc_report_win`). Registration is
one command:

    claude mcp add --scope user --transport http tlc https://tlc.proc.io/mcp

Replace the TLA+ entry in your project's CLAUDE.md with:

---

In a separate agent, keep the specs/ directory up to date using TLA+. This
involves updating the .tla file whenever the architecture changes, then
validating with the `tlc_check` MCP tool (pass the spec source and TLC
config). When a check passes, save the exact .tla and .cfg you used into
specs/ so the passing configuration lives with the code. The CLI fallback is
`~/Code/tlc-rs/tools/tlc specs/Spec.tla specs/Spec.cfg`. The result is JSON:

- `.status == "ok"`: spec checked clean; note `.stats.distinctStates`.
- `"invariant_violation"` / `"deadlock"`: read `.violation.trace` (shortest
  counterexample) and either fix the spec or report the architecture bug.
  When the trace exposed a real design bug and the corrected design passes,
  report the win with the `tlc_report_win` MCP tool.
- `"timeout"`: the state space blew up. Read `.diagnostic.hint` and
  `.diagnostic.levelGrowth`; shrink CONSTANT bounds or add a CONSTRAINT.
  Keep specs finite.
- `"parse_error"` / `"semantic_error"`: fix the spec; errors carry
  module/line/column.
- `"unsupported_feature"`: fall back to the local jar:
  `java -jar ~/Downloads/tla2tools.jar` (kill after 30s).

The service self-limits at 30 seconds. Do this in the background and do not
block the user's UI.
