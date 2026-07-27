// Shared HTML shell for the server-rendered pages (/hub, /account), styled
// to match the landing page.

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function page(title: string, body: string, extraHead = ""): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
${extraHead}<style>
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
  h1 { font-size: 1.4rem; margin: 0 0 .25rem; letter-spacing: -.01em; }
  h2 { font-size: 1.05rem; margin: 2.2rem 0 .6rem; color: var(--accent); }
  p { margin: .7rem 0; }
  .tag { color: var(--dim); margin: 0 0 2rem; }
  code, pre { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: .86em; }
  code { background: var(--code-bg); padding: .12em .35em; border-radius: 4px; }
  pre {
    background: var(--code-bg); border: 1px solid var(--border);
    border-radius: 8px; padding: .9rem 1rem; overflow-x: auto; line-height: 1.5;
  }
  pre code { background: none; padding: 0; }
  table { border-collapse: collapse; width: 100%; margin: 1rem 0; font-size: .9rem; }
  td, th { border-top: 1px solid var(--border); padding: .45rem .5rem .45rem 0;
    vertical-align: top; text-align: left; }
  th { border-top: none; color: var(--dim); font-weight: 500; font-size: .82rem; }
  a { color: var(--accent); }
  .dim { color: var(--dim); }
  .card {
    background: var(--card); border: 1px solid var(--border);
    border-radius: 8px; padding: .9rem 1rem; margin: 1rem 0;
  }
  button, .btn {
    background: var(--accent); color: var(--bg); border: none; border-radius: 6px;
    padding: .45rem .9rem; font: 500 .9rem/1 ui-sans-serif, system-ui, sans-serif;
    cursor: pointer; text-decoration: none; display: inline-block;
  }
  button.plain { background: var(--card); color: var(--fg);
    border: 1px solid var(--border); }
  form { display: inline; }
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
  .copybtn:hover, .copybtn.copied { color: var(--accent); border-color: var(--accent); }
  .copybtn svg { width: .85rem; height: .85rem; }
  .chat-log { max-height: 24rem; overflow-y: auto; display: flex;
    flex-direction: column; gap: .7rem; margin: .7rem 0; }
  .chat-log:empty { display: none; }
  .chat-msg { font-size: .92rem; }
  .chat-msg .who { display: block; color: var(--dim); font-size: .76rem; }
  .chat-msg.user .who { color: var(--accent); }
  .chat-msg .text { white-space: pre-wrap; word-break: break-word; }
  .chat-row { display: flex; gap: .5rem; margin-top: .6rem; align-items: flex-start; }
  .chat-row textarea, .chat-row input {
    flex: 1; resize: vertical; background: var(--bg); color: var(--fg);
    border: 1px solid var(--border); border-radius: 6px;
    padding: .5rem .6rem; font: inherit; font-size: .92rem; }
  .chat-row input[type="number"] { flex: 0 0 auto; }
  .chat-row > span { align-self: center; white-space: nowrap; }
  .chat-meta { display: flex; gap: .8rem; align-items: center; flex-wrap: wrap;
    font-size: .82rem; color: var(--dim); }
  .chat-meta select { background: var(--bg); color: var(--fg);
    border: 1px solid var(--border); border-radius: 6px; padding: .25rem .4rem;
    font: inherit; font-size: .82rem; }
  .chat-err { color: #c25450; font-size: .86rem; }
  .chat-err:empty { display: none; }
  nav { margin-bottom: 2rem; font-size: .9rem; }
  nav a { margin-right: 1rem; }
  footer { margin-top: 4rem; color: var(--dim); font-size: .82rem;
    border-top: 1px solid var(--border); padding-top: 1rem; }
  .typeset {
    background: var(--card); border: 1px solid var(--border); border-radius: 8px;
    padding: 1.3rem 1.5rem; overflow-x: auto;
    font-family: "KaTeX_Main", Georgia, "Times New Roman", serif;
    font-size: 1.02rem; line-height: 1.5;
  }
  .copywrap .typeset { padding-right: 3.2rem; }
  .typeset .m-i { font-family: "KaTeX_Math", Georgia, serif; font-style: italic; }
  .typeset sub { font-family: "KaTeX_Math", Georgia, serif; font-style: italic;
    font-size: .72em; }
  .typeset .m-kw { font-size: .78em; letter-spacing: .06em; }
  .typeset .m-str { font-family: "KaTeX_Typewriter", ui-monospace, Menlo, monospace;
    font-size: .88em; }
  .typeset .m-c, .typeset td.cmt { color: var(--dim); }
  .typeset table.blk { width: auto; margin: .55rem 0; border-collapse: collapse;
    font-size: 1em; }
  .typeset table.blk td { border: none; padding: .05rem 0; vertical-align: baseline; }
  .typeset table.blk td.code { white-space: nowrap; }
  .typeset table.blk td.cmt { font-size: .9em; padding-left: 2.2em; color: var(--dim); }
  .typeset sup.m-pr { font-size: .8em; vertical-align: .35em; line-height: 0; }
  .typeset .cprose { max-width: 36em; margin: .7rem 0; }
  .typeset .cprose p { margin: .45rem 0; }
  .typeset .modrule { display: flex; align-items: center; gap: .75em;
    margin: 1.1rem 0; }
  .typeset .modrule .hr { flex: 1; border-top: 1px solid var(--fg); height: 0; }
  .typeset .modlabel { white-space: nowrap; }
  @media print {
    nav, footer, button, .copybtn, .no-print { display: none !important; }
    body { background: #fff; color: #000; }
    main { max-width: none; padding: 0; }
    pre { background: none; border: none; padding: 0;
      overflow: visible; white-space: pre-wrap; word-break: break-word; }
    a { color: #000; text-decoration: none; }
    h2 { color: #000; }
    .typeset { background: none; border: none; padding: 0; overflow: visible; }
    .typeset .m-c, .typeset td.cmt, .typeset .cprose { color: #333; }
    .typeset .modrule .hr { border-top-color: #000; }
  }
  @page { margin: 2cm; }
</style>
</head>
<body>
<main>
<nav><a href="/">tlc.proc.io</a> <a href="/hub">hub</a> <a href="/hub/wins">wins</a> <a href="/account">account</a></nav>
${body}
<footer>Source: <a href="https://github.com/polvi/tlc-rs">github.com/polvi/tlc-rs</a>
(AGPL-3.0). Sign-in powered by <a href="https://authgravity.org">AuthGravity</a>.</footer>
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
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}
