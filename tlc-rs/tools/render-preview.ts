// Dev-only smoke test for the hub's LaTeX-style TLA+ typesetter. Renders
// specs/Hub.tla + Hub.cfg to a standalone HTML page on stdout, asserts the
// typesetting landed where expected, and fuzzes the renderer with random
// input. Run from the repo root: bun tools/render-preview.ts > preview.html

import { readFileSync } from "node:fs";
import { KATEX_FONTS_CSS, renderCfg, renderTla } from "../worker/src/tla-html";

const tla = readFileSync("specs/Hub.tla", "utf8");
const cfg = readFileSync("specs/Hub.cfg", "utf8");

const tlaHtml = renderTla(tla);
const cfgHtml = renderCfg(cfg);

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

for (const sym of ["∧", "∨", "∀", "∃", "≜", "↦", "⟨", "⟩", "□", "∈", "×"]) {
  assert(tlaHtml.includes(sym), `tla output contains ${sym}`);
}
// Module header becomes a rule with a label, footer a plain rule.
assert(tlaHtml.includes(`<span class="m-kw">MODULE</span> <span class="m-i">Hub</span>`), "module header label");
assert(!/-{4,}|={4,}/.test(tlaHtml), "no raw rule dashes left");
// The banner comment turns into prose paragraphs, borders stripped.
assert(tlaHtml.includes("TLA hub publishing feature"), "banner prose kept");
assert(!/\*{3,}/.test(tlaHtml), "banner borders stripped");
// Temporal subscript and prime.
assert(tlaHtml.includes("]<sub>vars</sub>"), "[Next]_vars subscript");
assert(tlaHtml.includes("′"), "primes typeset");
// Trailing comments land in the aligned comment column.
assert(/<td class="cmt">model values/.test(tlaHtml), "comment column");
// Cfg keywords styled, no unicode introduced.
assert(cfgHtml.includes(`<span class="m-kw">SPECIFICATION</span>`), "cfg keyword");
assert(!/[∧∨∀∃≜↦]/.test(cfgHtml), "cfg stays ASCII");

// Fuzz: random byte soup and random slices of the real spec must not
// throw and must never emit a tag we do not generate ourselves.
const ALLOWED = /<(?!\/?(?:span|sub|sup|table|tr|td|div|p|pre)\b)/;
const CHARS = `\\/=<>-~#[]()"'*_ \n\tabcXYZ0159|&`;
for (let round = 0; round < 1000; round++) {
  const len = Math.floor(Math.random() * 200);
  let input = "";
  if (round % 2 === 0) {
    for (let k = 0; k < len; k++) input += CHARS[Math.floor(Math.random() * CHARS.length)];
  } else {
    const start = Math.floor(Math.random() * tla.length);
    input = tla.slice(start, start + len);
  }
  const rendered = renderTla(input) + renderCfg(input);
  assert(!ALLOWED.test(rendered), `no stray tags for input ${JSON.stringify(input)}`);
}

console.error("all assertions passed");

const pageCss = readFileSync("worker/src/page.ts", "utf8");
const style = /<style>([\s\S]*?)<\/style>/.exec(pageCss)![1];

console.log(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Hub — typeset preview</title>
${KATEX_FONTS_CSS}
<style>${style}</style>
</head>
<body>
<main>
<h2>Hub.tla</h2>
<div class="typeset">${tlaHtml}</div>
<h2>Hub.cfg</h2>
<div class="typeset">${cfgHtml}</div>
</main>
</body>
</html>`);
