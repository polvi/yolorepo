// Landing page served at GET /.

export const LANDING_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>tlc.proc.io: hosted TLA+ model checking</title>
<style>
  :root {
    --bg: #faf9f6; --fg: #1a1a1a; --dim: #6b6b6b; --accent: #0d5c4d;
    --card: #ffffff; --border: #e4e1da; --code-bg: #f0eee8;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #12130f; --fg: #e8e6e1; --dim: #9a988f; --accent: #5fd4b0;
      --card: #1b1c17; --border: #2e2f28; --code-bg: #22231d;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--fg);
    font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, sans-serif;
  }
  main { max-width: 46rem; margin: 0 auto; padding: 3rem 1.25rem 5rem; }
  h1 { font-size: 1.6rem; margin: 0 0 .25rem; letter-spacing: -.01em; }
  h1 code { font-size: 1.35rem; }
  h2 { font-size: 1.05rem; margin: 2.6rem 0 .6rem; color: var(--accent); }
  p { margin: .7rem 0; }
  .tag { color: var(--dim); margin: 0 0 2rem; }
  code, pre {
    font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: .86em;
  }
  code { background: var(--code-bg); padding: .12em .35em; border-radius: 4px; }
  pre {
    background: var(--code-bg); border: 1px solid var(--border);
    border-radius: 8px; padding: .9rem 1rem; overflow-x: auto; line-height: 1.5;
  }
  pre code { background: none; padding: 0; }
  .fact-row { display: flex; gap: .75rem; flex-wrap: wrap; margin: 1.4rem 0; }
  .fact {
    flex: 1 1 10rem; background: var(--card); border: 1px solid var(--border);
    border-radius: 8px; padding: .8rem .95rem;
  }
  .fact b { display: block; font-size: 1.25rem; color: var(--accent); }
  .fact span { color: var(--dim); font-size: .82rem; }
  table { border-collapse: collapse; width: 100%; margin: 1rem 0; font-size: .9rem; }
  td { border-top: 1px solid var(--border); padding: .45rem .5rem .45rem 0;
    vertical-align: top; }
  td:first-child { white-space: nowrap; padding-right: 1rem; }
  a { color: var(--accent); }
  .dim { color: var(--dim); }
  nav { margin-bottom: 2rem; font-size: .9rem; }
  nav a { margin-right: 1rem; }
  .copywrap { position: relative; }
  .copywrap pre { padding-right: 3.2rem; }
  .copybtn {
    position: absolute; top: .55rem; right: .55rem;
    display: inline-flex; align-items: center; gap: .3rem;
    background: var(--card); color: var(--dim);
    border: 1px solid var(--border); border-radius: 6px;
    padding: .28rem .5rem; font: 500 .74rem/1 ui-sans-serif, system-ui, sans-serif;
    cursor: pointer;
  }
  .copybtn:hover { color: var(--accent); border-color: var(--accent); }
  .copybtn.copied { color: var(--accent); border-color: var(--accent); }
  .copybtn svg { width: .85rem; height: .85rem; }
  footer { margin-top: 4rem; color: var(--dim); font-size: .82rem;
    border-top: 1px solid var(--border); padding-top: 1rem; }
</style>
</head>
<body>
<main>
  <nav><a href="/hub">hub</a> <a href="/account">account</a>
  <a href="https://github.com/polvi/tlc-rs">source</a></nav>
  <h1><code>tlc.proc.io</code>: hosted TLA+ model checking</h1>
  <p class="tag">The TLA+ tools (SANY + TLC, safety subset) rewritten in Rust,
  compiled to a 509&nbsp;KB WebAssembly module, and served from Cloudflare's
  edge. Onboarding consists of a free passkey account and an API key, and any
  HTTP client can use the service. Point a coding agent at it and formal
  verification becomes a routine part of development. Source on
  <a href="https://github.com/polvi/tlc-rs">GitHub</a>.</p>

  <div class="fact-row">
    <div class="fact"><b>97/107</b><span>exact-parity conformance vs Java TLC
      (verdict, state counts, trace length)</span></div>
    <div class="fact"><b>509 KB</b><span>the whole checker as wasm: parser,
      level checker, evaluator, BFS engine</span></div>
    <div class="fact"><b>&le;30 s</b><span>self-limiting runs with a
      state-blowup diagnostic on timeout</span></div>
  </div>

  <h2>What it does</h2>
  <p>You write a TLA+ specification of your system and a small config. The
  service exhaustively explores every reachable state, checking your
  invariants and <code>[][A]_v</code> action properties on each transition.
  When a property can be violated, you get the <em>shortest</em>
  counterexample trace (the exact step-by-step scenario that breaks your
  design). When the state space grows too large, you get a per-level growth
  profile and a hint about which constant to shrink.</p>

  <h2>Start in one command (MCP)</h2>
  <p>The service speaks the Model Context Protocol at <code>/mcp</code>.
  Sign in with a passkey at <a href="/account">/account</a> (the only
  identifier the service holds is a random UUID), mint an API key, and
  register the endpoint in Claude Code; the tools appear:
  <code>tlc_check</code>, <code>tlc_parse</code>, and
  <code>tlc_report_win</code>:</p>
  <div class="copywrap">
  <pre><code id="copy-mcp">claude mcp add --scope user --transport http tlc https://tlc.proc.io/mcp \\
  --header "Authorization: Bearer &lt;your key&gt;"</code></pre>
  <button class="copybtn" data-copy="copy-mcp" aria-label="Copy command"></button>
  </div>
  <p>That completes the setup. Ask your agent to model-check something and it
  will call <code>tlc_check</code> with the spec source and TLC config
  directly.</p>

  <h2>Publish to the hub</h2>
  <p>Every <em>passing</em> <code>tlc_check</code>
  publishes its spec and config to <a href="/hub">the hub</a> automatically:
  your agent iterates on a design, and the hub keeps one generation per
  revision of each module, forming a public, growing library of specs that
  are known to pass the checker. Publishing is on by default;
  turn it off account-wide on <a href="/account">/account</a> or per call
  with <code>publish: false</code>. Unpublished runs are processed in memory
  and discarded when the request completes.</p>
  <p>When a counterexample trace exposes a genuine design bug, and the
  corrected design then passes, your agent records the save with
  <code>tlc_report_win</code>. Wins appear on the spec's hub
  page and in the site-wide <a href="/hub/wins">wins list</a>: a public
  record of bugs formal methods caught before they shipped.</p>

  <h2>Recommended practice</h2>
  <p>The high-leverage pattern is a standing instruction in your project's
  CLAUDE.md (or equivalent) so the spec evolves with the code:</p>
  <div class="copywrap">
  <pre><code id="copy-prompt">In a separate agent, keep specs/ up to date using TLA+ as you
go. Update the .tla file whenever the architecture changes, then
validate with the tlc_check MCP tool. Run this in the background
so the main work keeps moving. When a check passes, save the
exact .tla and .cfg you used into specs/ so the passing
configuration lives with the code. Keep specs finite: small
CONSTANT sets, bounded ranges. On invariant_violation, read the
trace and fix the design or the spec. When the trace exposed a
real design bug and the corrected design passes, report the win
with the tlc_report_win MCP tool. On timeout, read the
diagnostic hint and shrink constants.</code></pre>
  <button class="copybtn" data-copy="copy-prompt" aria-label="Copy prompt"></button>
  </div>
  <p>Spec-writing tips that keep checks fast and meaningful:</p>
  <table>
    <tr><td>Model sets of 1&ndash;3</td><td>Two users and one resource usually
      expose the same interleavings as ten, at a fraction of the states.</td></tr>
    <tr><td>Strings as statuses</td><td>Enumerated string states
      (<code>"pending"</code>, <code>"active"</code>) keep specs readable and
      compare fast.</td></tr>
    <tr><td>TypeOK first</td><td>A type invariant catches most modeling
      mistakes immediately and documents your state shape.</td></tr>
    <tr><td>Action properties</td><td><code>[][A]_vars</code> properties
      (say, "closed records stay closed") check per-transition claims that
      invariants can't express.</td></tr>
    <tr><td>CHECK_DEADLOCK FALSE</td><td>Set it when terminal states are
      intentional, so quiescence reads as success.</td></tr>
  </table>

  <h2>REST, for everything else</h2>
  <p>The same API key authenticates the raw endpoints:</p>
  <pre><code>curl -s https://tlc.proc.io/check \\
  -H "Authorization: Bearer &lt;your key&gt;" \\
  -H "Content-Type: application/json" \\
  -d '{"modules":[{"name":"Spec","source":"---- MODULE Spec ----\\n..."}],
       "config":"INIT Init\\nNEXT Next\\nINVARIANT TypeOK",
       "timeoutSeconds":30}'</code></pre>
  <p>The response carries <code>status</code> (<code>ok</code>,
  <code>invariant_violation</code>, <code>deadlock</code>,
  <code>timeout</code>, &hellip;), <code>stats</code>, a
  <code>violation.trace</code> when something breaks, and a
  <code>diagnostic</code> with per-level state growth when the space blows
  up. <code>POST /parse</code> runs the fast syntax and level check alone.</p>

  <h2>Why this is interesting</h2>
  <p>Model checking has traditionally required a local toolchain: a JVM, the
  <code>tla2tools.jar</code> distribution, and a long-running process to
  supervise. This implementation is a stateless function at the edge: a
  hand-written parser faithful to SANY's column-sensitive junction-list
  grammar, a value system whose 64-bit fingerprints are bit-identical to Java
  TLC's, and a breadth-first search engine, all booting in microseconds
  inside a V8 isolate near you.</p>
  <p>Correctness is measured continuously: every build is differentially
  tested against the reference Java implementation on a mined conformance
  suite, matching its verdicts, exact state counts, and counterexample
  depths. Because the checker is one MCP tool call away, "prove my
  invariants still hold" becomes part of an agent's inner loop, on every
  architecture change, in the background.</p>

  <h2>What is implemented, what is omitted, and why</h2>
  <p>This engine implements the <strong>safety subset</strong> of TLA+: the
  full expression language, invariants, deadlock detection, box-action
  properties (<code>[][A]_v</code>), CONSTANT assignments with model values,
  CONSTRAINT/ACTION_CONSTRAINT, and EXTENDS-based modules (Naturals,
  Integers, Sequences, FiniteSets, TLC, and Bags are built in). That subset
  was chosen deliberately: it covers what agent-written specs of real systems
  actually use (state machines, type invariants, "closed things stay closed"
  claims), and every feature in it is verified against Java TLC exactly.</p>
  <p>Omitted features, and the reasoning behind each omission:</p>
  <table>
    <tr><td>Liveness &amp; fairness</td><td>Checking <code>&lt;&gt;P</code> or
      <code>WF_v(A)</code> requires a tableau construction and cycle detection
      over the full behavior graph, a second engine roughly the size of this
      one. Safety questions ("can this bad thing ever happen?") are where
      agent workflows get their value.</td></tr>
    <tr><td>Parameterized INSTANCE</td><td>Module instantiation with
      substitutions (<code>I == INSTANCE M WITH x &lt;- y</code>,
      <code>I!op</code>) brings in SANY's largest single subsystem. Plain
      <code>EXTENDS</code> composition covers the common case; this is the
      most likely next addition.</td></tr>
    <tr><td>ENABLED</td><td>Deciding whether an action could fire requires a
      nested successor search inside expression evaluation. Contained, and on
      the shortlist.</td></tr>
    <tr><td>Symmetry sets</td><td>A performance optimization (quotienting the
      state space by permutations), and one that changes reported state
      counts. Small finite models rarely need it.</td></tr>
    <tr><td>Proof syntax</td><td><code>THEOREM ... PROOF</code> and
      ASSUME/PROVE belong to TLAPS, the proof system. A model checker only
      needs the propositions.</td></tr>
    <tr><td>Reals, RandomElement</td><td>Real arithmetic is unenumerable, and
      randomized operators give different answers run to run, which conflicts
      with this project's exact-parity standard.</td></tr>
  </table>
  <p>The 97/107 conformance figure reads accordingly: 97 cases match Java TLC
  exactly, zero cases mismatch, and the remaining 10 exercise the features
  above. The engine recognizes them and returns a clean
  <code>unsupported_feature</code> status (with the local
  <code>tla2tools.jar</code> as the documented fallback) rather than a wrong
  answer. Keep specs finite (small constant sets, bounded ranges) and the
  supported subset is a complete, trustworthy checker.</p>

  <footer>Source:
  <a href="https://github.com/polvi/tlc-rs">github.com/polvi/tlc-rs</a>
  (AGPL-3.0). Built in Rust from
  <a href="https://github.com/tlaplus/tlaplus">tlaplus/tlaplus</a> reference
  semantics; checked differentially against TLC 2.19. Runs are sandboxed and
  self-limiting. Checking requires an API key from
  <a href="/account">/account</a>; passing checks publish to
  <a href="/hub">the hub</a> unless you opt out, and everything else is
  processed in memory and discarded. Sign-in powered by
  <a href="https://authgravity.org">AuthGravity</a>.</footer>
</main>
<script>
  const COPY_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5v-2a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 3.5V9A1.5 1.5 0 0 0 4 10.5h1.5"/></svg>';
  const CHECK_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 8.5l3.5 3.5L13 5"/></svg>';
  for (const btn of document.querySelectorAll(".copybtn")) {
    btn.innerHTML = COPY_ICON + "<span>Copy</span>";
    btn.addEventListener("click", async () => {
      const text = document.getElementById(btn.dataset.copy).textContent;
      await navigator.clipboard.writeText(text);
      btn.classList.add("copied");
      btn.innerHTML = CHECK_ICON + "<span>Copied</span>";
      setTimeout(() => {
        btn.classList.remove("copied");
        btn.innerHTML = COPY_ICON + "<span>Copy</span>";
      }, 1600);
    });
  }
</script>
</body>
</html>`;
