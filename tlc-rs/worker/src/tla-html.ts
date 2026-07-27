// Server-side LaTeX-style typesetting for TLA+ specs shown on the hub,
// in the spirit of tla2tex: Computer Modern fonts (via the KaTeX font
// files, CSS only), math-italic identifiers, small-cap keywords, unicode
// operators, subscripted temporal actions, comment banners as flowing
// prose, and module rules. Fail safe by construction: unknown input is
// emitted verbatim and any renderer exception falls back to the plain
// escaped source in a <pre>.

import { escapeHtml } from "./page";

/** Stylesheet link that provides the KaTeX_* font faces; no JS involved. */
export const KATEX_FONTS_CSS =
  `<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css" crossorigin="anonymous">`;

const KEYWORDS = new Set([
  "MODULE", "EXTENDS", "CONSTANT", "CONSTANTS", "VARIABLE", "VARIABLES",
  "ASSUME", "ASSUMPTION", "AXIOM", "THEOREM", "LEMMA", "INSTANCE", "LOCAL",
  "LET", "IN", "IF", "THEN", "ELSE", "CASE", "OTHER", "CHOOSE", "ENABLED",
  "UNCHANGED", "SUBSET", "UNION", "DOMAIN", "EXCEPT", "WITH", "RECURSIVE",
  "LAMBDA", "TRUE", "FALSE", "BOOLEAN",
]);

/** \word operators; a miss keeps the ASCII spelling. */
const BACKSLASH: Record<string, string> = {
  "\\A": "∀", "\\E": "∃", "\\in": "∈", "\\notin": "∉",
  "\\subseteq": "⊆", "\\subset": "⊂", "\\supseteq": "⊇", "\\supset": "⊃",
  "\\cup": "∪", "\\union": "∪", "\\cap": "∩", "\\intersect": "∩",
  "\\X": "×", "\\times": "×", "\\equiv": "⇔", "\\lnot": "¬", "\\neg": "¬",
  "\\land": "∧", "\\lor": "∨", "\\o": "∘", "\\circ": "∘", "\\div": "÷",
  "\\leq": "≤", "\\geq": "≥", "\\oplus": "⊕", "\\otimes": "⊗",
  "\\ominus": "⊖", "\\odot": "⊙", "\\uplus": "⊎",
  "\\sqsubseteq": "⊑", "\\sqsupseteq": "⊒", "\\prec": "≺", "\\succ": "≻",
  "\\preceq": "⪯", "\\succeq": "⪰", "\\approx": "≈", "\\cong": "≅",
  "\\cdot": "⋅", "\\bullet": "•", "\\star": "⋆",
};

/** Multi-char ASCII operators, longest first. Runs of - and = are handled
 * separately, as are the backslash forms. */
const ASCII_OPS: [string, string][] = [
  ["|->", "↦"], ["<=>", "⇔"], ["~>", "↝"], ["<<", "⟨"], [">>", "⟩"],
  ["<=", "≤"], [">=", "≥"], ["/=", "≠"], ["<-", "←"], ["[]", "□"],
  ["<>", "◇"], ["#", "≠"], ["~", "¬"],
];

const kw = (word: string): string => `<span class="m-kw">${word}</span>`;
const ident = (word: string): string => `<span class="m-i">${escapeHtml(word)}</span>`;

interface CodeLine {
  indent: number;
  code: string;
  comment: string | null;
  /** Block-comment depth left open at end of line. */
  carry: number;
}

/** Typeset one line of TLA+ (or cfg) code. Whitespace runs collapse to a
 * single space; the caller renders leading indentation. */
function tokenizeTlaLine(text: string): CodeLine {
  const out: string[] = [];
  let comment: string | null = null;
  let carry = 0;
  const n = text.length;
  let i = 0;
  let lastSig = ""; // last significant char, for subscript detection

  while (i < n) {
    const c = text[i];

    if (c === " " || c === "\t") {
      while (i < n && (text[i] === " " || text[i] === "\t")) i++;
      out.push(" ");
      continue;
    }

    if (c === "\\") {
      if (text[i + 1] === "*") {
        comment = escapeHtml(text.slice(i + 2).trim());
        break;
      }
      if (text[i + 1] === "/") { out.push("∨"); lastSig = "∨"; i += 2; continue; }
      const m = /^\\[a-zA-Z]+/.exec(text.slice(i));
      if (m) {
        const sub = BACKSLASH[m[0]];
        out.push(sub ?? escapeHtml(m[0]));
        lastSig = sub ?? "x";
        i += m[0].length;
        continue;
      }
      out.push(escapeHtml(c));
      lastSig = c;
      i++;
      continue;
    }

    // Inline block comment; unterminated turns the rest into a comment
    // and carries the open depth to the following lines.
    if (c === "(" && text[i + 1] === "*") {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (text[j] === "(" && text[j + 1] === "*") { depth++; j += 2; }
        else if (text[j] === "*" && text[j + 1] === ")") { depth--; j += 2; }
        else j++;
      }
      if (depth > 0) {
        comment = escapeHtml(stripStars(text.slice(i + 2)));
        carry = depth;
        break;
      }
      const inner = text.slice(i + 2, j - 2).trim();
      if (j >= n || !text.slice(j).trim()) {
        // Comment closes the line: set it in the comment column.
        comment = escapeHtml(inner);
        i = n;
        continue;
      }
      out.push(`<span class="m-c">${escapeHtml(inner)}</span>`);
      i = j;
      continue;
    }

    if (c === "/" && text[i + 1] === "\\") { out.push("∧"); lastSig = "∧"; i += 2; continue; }

    if (c === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      if (text[j] === '"') j++;
      out.push(`<span class="m-str">${escapeHtml(text.slice(i, j))}</span>`);
      lastSig = '"';
      i = j;
      continue;
    }

    // Runs of - and =: mid-line rules are emitted verbatim; == is a
    // definition; single = may start => or =<.
    if (c === "-" || c === "=") {
      let j = i;
      while (j < n && text[j] === c) j++;
      const run = j - i;
      if (run === 2 && c === "=") { out.push("≜"); lastSig = "≜"; i = j; continue; }
      if (run === 1) {
        if (c === "=" && text[i + 1] === ">") { out.push("⇒"); lastSig = "⇒"; i += 2; continue; }
        if (c === "=" && text[i + 1] === "<") { out.push("≤"); lastSig = "≤"; i += 2; continue; }
        if (c === "-" && text[i + 1] === ">") { out.push("→"); lastSig = "→"; i += 2; continue; }
      }
      out.push(escapeHtml(text.slice(i, j)));
      lastSig = c;
      i = j;
      continue;
    }

    const op = ASCII_OPS.find(([ascii]) => text.startsWith(ascii, i));
    if (op) {
      out.push(op[1]);
      lastSig = op[1];
      i += op[0].length;
      continue;
    }

    if (c === "'") { out.push(`<sup class="m-pr">′</sup>`); lastSig = "′"; i++; continue; }

    // Subscript after a closing bracket: [Next]_vars, <<A>>_vars.
    if (c === "_") {
      const m = /^_[A-Za-z][A-Za-z0-9_]*/.exec(text.slice(i));
      if (m && (lastSig === "]" || lastSig === "⟩" || lastSig === ")")) {
        out.push(`<sub>${escapeHtml(m[0].slice(1))}</sub>`);
        lastSig = "x";
        i += m[0].length;
        continue;
      }
      out.push("_");
      lastSig = "_";
      i++;
      continue;
    }

    if (c >= "0" && c <= "9") {
      let j = i;
      while (j < n && text[j] >= "0" && text[j] <= "9") j++;
      out.push(text.slice(i, j));
      lastSig = "0";
      i = j;
      continue;
    }

    if (/[A-Za-z]/.test(c)) {
      const word = /^[A-Za-z][A-Za-z0-9_]*/.exec(text.slice(i))![0];
      const wf = /^(WF|SF)_([A-Za-z0-9_]+)$/.exec(word);
      if (wf) out.push(`${wf[1]}<sub>${escapeHtml(wf[2])}</sub>`);
      else if (KEYWORDS.has(word)) out.push(kw(word));
      else out.push(ident(word));
      lastSig = "x";
      i += word.length;
      continue;
    }

    out.push(escapeHtml(c));
    lastSig = c;
    i++;
  }

  return { indent: 0, code: out.join(""), comment, carry };
}

const CFG_KEYWORDS = new Set([
  "SPECIFICATION", "INIT", "NEXT", "INVARIANT", "INVARIANTS", "PROPERTY",
  "PROPERTIES", "CONSTANT", "CONSTANTS", "CONSTRAINT", "CONSTRAINTS",
  "ACTION_CONSTRAINT", "ACTION_CONSTRAINTS", "SYMMETRY", "VIEW", "ALIAS",
  "POSTCONDITION", "CHECK_DEADLOCK", "TRUE", "FALSE",
]);

function tokenizeCfgLine(text: string): CodeLine {
  const out: string[] = [];
  let comment: string | null = null;
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === " " || c === "\t") {
      while (i < n && (text[i] === " " || text[i] === "\t")) i++;
      out.push(" ");
      continue;
    }
    if (c === "\\" && text[i + 1] === "*") {
      comment = escapeHtml(text.slice(i + 2).trim());
      break;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      if (text[j] === '"') j++;
      out.push(`<span class="m-str">${escapeHtml(text.slice(i, j))}</span>`);
      i = j;
      continue;
    }
    if (c >= "0" && c <= "9") {
      let j = i;
      while (j < n && text[j] >= "0" && text[j] <= "9") j++;
      out.push(text.slice(i, j));
      i = j;
      continue;
    }
    if (/[A-Za-z]/.test(c)) {
      const word = /^[A-Za-z][A-Za-z0-9_]*/.exec(text.slice(i))![0];
      out.push(CFG_KEYWORDS.has(word) ? kw(word) : ident(word));
      i += word.length;
      continue;
    }
    out.push(escapeHtml(c));
    i++;
  }
  return { indent: 0, code: out.join(""), comment, carry: 0 };
}

/** Strip banner decoration from a comment line: border runs of * and
 * closing/opening debris. An empty result marks a paragraph break. */
function stripStars(line: string): string {
  return line.replace(/\*+\)?\s*$/, "").replace(/^\s*\(?\*+/, "").trim();
}

/** If the trimmed line consists purely of block comments, return their
 * text pieces (empty string = paragraph break) and any depth left open;
 * otherwise null (it is a code line). */
function fullLineComments(t: string): { texts: string[]; carry: number } | null {
  const texts: string[] = [];
  let rest = t;
  while (rest.startsWith("(*")) {
    let depth = 1;
    let j = 2;
    while (j < rest.length && depth > 0) {
      if (rest[j] === "(" && rest[j + 1] === "*") { depth++; j += 2; }
      else if (rest[j] === "*" && rest[j + 1] === ")") { depth--; j += 2; }
      else j++;
    }
    if (depth > 0) {
      texts.push(stripStars(rest.slice(2)));
      return { texts, carry: depth };
    }
    texts.push(stripStars(rest.slice(2, j - 2)));
    rest = rest.slice(j).trim();
    if (rest === "") return { texts, carry: 0 };
  }
  return null;
}

/** Render buffered comment lines as flowing prose paragraphs. */
function proseBlock(lines: string[]): string {
  const paras: string[] = [];
  let cur: string[] = [];
  for (const line of lines) {
    if (line === "") {
      if (cur.length) { paras.push(cur.join(" ")); cur = []; }
    } else cur.push(line);
  }
  if (cur.length) paras.push(cur.join(" "));
  if (!paras.length) return "";
  return `<div class="cprose">${paras.map((p) => `<p>${escapeHtml(p)}</p>`).join("")}</div>`;
}

/** Render a run of code lines as a table so trailing comments align. */
function codeBlock(rows: CodeLine[]): string {
  const hasComment = rows.some((r) => r.comment);
  const trs = rows.map((r) => {
    const pad = r.indent ? ` style="padding-left:${(r.indent * 0.55).toFixed(2)}em"` : "";
    const cmt = hasComment ? `<td class="cmt">${r.comment ?? ""}</td>` : "";
    return `<tr><td class="code"${pad}>${r.code}</td>${cmt}</tr>`;
  });
  return `<table class="blk">${trs.join("")}</table>`;
}

const modRule = (label?: string): string =>
  `<div class="modrule">${label !== undefined ? `<span class="hr"></span><span class="modlabel">${label}</span>` : ""}<span class="hr"></span></div>`;

function typeset(src: string, isTla: boolean): string {
  const tokenize = isTla ? tokenizeTlaLine : tokenizeCfgLine;
  const out: string[] = [];
  let prose: string[] = [];
  let rows: CodeLine[] = [];
  let carry = 0;

  const flushProse = () => {
    const html = proseBlock(prose);
    if (html) out.push(html);
    prose = [];
  };
  const flushRows = () => {
    if (rows.length) out.push(codeBlock(rows));
    rows = [];
  };

  for (const raw of src.split("\n")) {
    if (carry > 0) {
      // Whole line lives inside an open block comment.
      let depth = carry;
      let j = 0;
      while (j < raw.length && depth > 0) {
        if (raw[j] === "(" && raw[j + 1] === "*") { depth++; j += 2; }
        else if (raw[j] === "*" && raw[j + 1] === ")") { depth--; j += 2; }
        else j++;
      }
      prose.push(stripStars(raw.slice(0, depth > 0 ? raw.length : j)));
      carry = depth;
      if (depth === 0 && raw.slice(j).trim()) {
        flushProse();
        const line = tokenize(raw.slice(j).trim());
        line.indent = j;
        carry = line.carry;
        rows.push(line);
      }
      continue;
    }

    const t = raw.trim();
    if (t === "") { flushProse(); flushRows(); continue; }

    if (isTla) {
      const mh = /^-{4,}\s*MODULE\s+([A-Za-z0-9_!]+)\s*-{4,}$/.exec(t);
      if (mh) {
        flushProse(); flushRows();
        out.push(modRule(`${kw("MODULE")} ${ident(mh[1])}`));
        continue;
      }
      if (/^-{4,}$/.test(t) || /^={4,}$/.test(t)) {
        flushProse(); flushRows();
        out.push(modRule());
        continue;
      }
    }

    if (t.startsWith("\\*")) {
      flushRows();
      prose.push(t.slice(2).trim());
      continue;
    }
    if (t.startsWith("(*")) {
      const fc = fullLineComments(t);
      if (fc) {
        flushRows();
        prose.push(...fc.texts);
        carry = fc.carry;
        continue;
      }
    }

    flushProse();
    const line = tokenize(t);
    line.indent = raw.length - raw.trimStart().length;
    carry = line.carry;
    rows.push(line);
  }
  flushProse();
  flushRows();
  return out.join("\n");
}

/** Typeset a .tla source as LaTeX-style HTML for a .typeset container.
 * Falls back to plain escaped text on any failure. */
export function renderTla(source: string): string {
  try {
    return typeset(source, true);
  } catch {
    return `<pre>${escapeHtml(source)}</pre>`;
  }
}

/** Typeset a .cfg source in the same document style (no unicode). */
export function renderCfg(source: string): string {
  try {
    return typeset(source, false);
  } catch {
    return `<pre>${escapeHtml(source)}</pre>`;
  }
}
