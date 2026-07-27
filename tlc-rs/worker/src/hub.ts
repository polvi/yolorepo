// The TLA+ hub: authenticated users' passing tlc_check runs are published
// here (on by default, per-user toggle, per-call opt-out). A spec is keyed by
// (user, module name); each content change mints the next generation, and
// republishing identical content just touches updated_at.

import { sha256Hex } from "./auth";
import { escapeHtml, page } from "./page";
import { KATEX_FONTS_CSS, renderCfg, renderTla } from "./tla-html";

export interface CheckStats {
  distinctStates?: number;
  depth?: number;
}

/** Agent-supplied hub metadata, capped defensively server-side. */
export interface SpecMeta {
  description?: string;
  changelog?: string;
}

const clip = (text: string | undefined, max: number): string | null => {
  const trimmed = text?.trim();
  return trimmed ? trimmed.slice(0, max) : null;
};

/** Agent-reported win: model checking caught a real design bug. */
export interface WinReport {
  spec: string;
  title: string;
  story: string;
  invariant?: string;
  gen?: number;
}

export type WinResult = { ok: true; gen: number } | { ok: false; error: string };

/**
 * Record a win against one of the user's published specs. Unlike publishSpec
 * this is awaited, so the reporting agent gets validation feedback.
 */
export async function reportWin(
  db: D1Database,
  userId: string,
  report: WinReport,
): Promise<WinResult> {
  const title = clip(report.title, 120);
  const story = clip(report.story, 2000);
  if (!title || !story) return { ok: false, error: "title and story must be non-empty" };
  const spec = await db
    .prepare("SELECT id, latest_gen FROM specs WHERE user_id = ? AND name = ?")
    .bind(userId, report.spec)
    .first<{ id: number; latest_gen: number }>();
  if (!spec) {
    return {
      ok: false,
      error:
        `no published spec named "${report.spec}" under your account; ` +
        "publish it first with a passing tlc_check, then report the win",
    };
  }
  const gen = report.gen ?? spec.latest_gen;
  if (!Number.isInteger(gen) || gen < 1 || gen > spec.latest_gen) {
    return { ok: false, error: `gen must be between 1 and ${spec.latest_gen} (the latest generation)` };
  }
  await db
    .prepare("INSERT INTO wins (spec_id, gen, title, story, invariant) VALUES (?, ?, ?, ?, ?)")
    .bind(spec.id, gen, title, story, clip(report.invariant, 120))
    .run();
  return { ok: true, gen };
}

export function hubPath(userId: string, name: string): string {
  return `/hub/${encodeURIComponent(userId)}/${encodeURIComponent(name)}`;
}

/** Record a passing check. Runs in waitUntil, so failures only log. */
export async function publishSpec(
  db: D1Database,
  userId: string,
  name: string,
  tla: string,
  cfg: string,
  stats: CheckStats,
  meta: SpecMeta = {},
): Promise<void> {
  try {
    const hash = await sha256Hex(tla + String.fromCharCode(0) + cfg);
    const description = clip(meta.description, 500);
    const changelog = clip(meta.changelog, 500);
    const spec = await db
      .prepare("SELECT id, latest_gen FROM specs WHERE user_id = ? AND name = ?")
      .bind(userId, name)
      .first<{ id: number; latest_gen: number }>();

    if (spec) {
      const latest = await db
        .prepare("SELECT content_hash FROM generations WHERE spec_id = ? AND gen = ?")
        .bind(spec.id, spec.latest_gen)
        .first<{ content_hash: string }>();
      if (latest?.content_hash === hash) {
        // Same content: refresh the timestamp (and description, if one came
        // along); a changelog without a content change has nothing to attach to.
        await db
          .prepare(
            "UPDATE specs SET updated_at = datetime('now'), description = COALESCE(?, description) WHERE id = ?",
          )
          .bind(description, spec.id)
          .run();
        return;
      }
      const gen = spec.latest_gen + 1;
      await db.batch([
        db.prepare(
          "INSERT INTO generations (spec_id, gen, tla, cfg, content_hash, distinct_states, depth, changelog) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ).bind(spec.id, gen, tla, cfg, hash, stats.distinctStates ?? null, stats.depth ?? null, changelog),
        db.prepare(
          "UPDATE specs SET latest_gen = ?, updated_at = datetime('now'), description = COALESCE(?, description) WHERE id = ?",
        ).bind(gen, description, spec.id),
      ]);
      return;
    }

    const inserted = await db
      .prepare("INSERT INTO specs (user_id, name, latest_gen, description) VALUES (?, ?, 1, ?) RETURNING id")
      .bind(userId, name, description)
      .first<{ id: number }>();
    if (!inserted) throw new Error("spec insert returned no row");
    await db
      .prepare(
        "INSERT INTO generations (spec_id, gen, tla, cfg, content_hash, distinct_states, depth, changelog) VALUES (?, 1, ?, ?, ?, ?, ?, ?)",
      )
      .bind(inserted.id, tla, cfg, hash, stats.distinctStates ?? null, stats.depth ?? null, changelog)
      .run();
  } catch (err) {
    // Concurrent publishes of the same spec can collide on (spec_id, gen) or
    // (user_id, name); the next passing check will land the content.
    console.log(JSON.stringify({ event: "publish_failed", userId, name, error: String(err) }));
  }
}

const shortId = (id: string) => id.slice(0, 8);

interface WinRow {
  gen: number;
  title: string;
  story: string;
  invariant: string | null;
  created_at: string;
}

/** One reported win as a card; specHtml (optional) leads the byline. */
function winCard(w: WinRow, opts: { genHref: string; specHtml?: string }): string {
  const byline = [
    ...(opts.specHtml ? [opts.specHtml] : []),
    ...(w.invariant ? [`caught by <code>${escapeHtml(w.invariant)}</code>`] : []),
    `fixed in <a href="${opts.genHref}">gen ${w.gen}</a>`,
    `${escapeHtml(w.created_at)} UTC`,
  ].join(" · ");
  return `<div class="card">
<b>${escapeHtml(w.title)}</b>
<p class="dim" style="margin:.15rem 0 0; font-size:.82rem;">${byline}</p>
<p style="margin:.5rem 0 0; white-space:pre-wrap;">${escapeHtml(w.story)}</p>
</div>`;
}

// For embedding JSON in a <script> block: spec content is author-controlled
// and may contain "</script>", so escape every "<". Load-bearing.
const jsonForHtml = (x: unknown) => JSON.stringify(x).replaceAll("<", "\\u003c");

// Cap the chat context so a huge spec doesn't blow small model context
// windows; the flag lets the client prompt note the truncation.
const CONTEXT_SRC_MAX = 48_000;

interface HubRow {
  user_id: string;
  name: string;
  latest_gen: number;
  updated_at: string;
  distinct_states: number | null;
  depth: number | null;
  description: string | null;
}

/** GET /hub — latest generation of every visible spec. */
export async function hubIndex(db: D1Database, host: string): Promise<Response> {
  const { results } = await db
    .prepare(
      `SELECT s.user_id, s.name, s.latest_gen, s.updated_at, s.description, g.distinct_states, g.depth
       FROM specs s
       JOIN users u ON u.id = s.user_id AND u.publish = 1
       JOIN generations g ON g.spec_id = s.id AND g.gen = s.latest_gen
       ORDER BY s.updated_at DESC LIMIT 200`,
    )
    .all<HubRow>();

  const rows = results
    .map(
      (r) => `<tr>
<td><a href="${hubPath(r.user_id, r.name)}">${escapeHtml(r.name)}</a>${
        r.description ? `<br><span class="dim">${escapeHtml(r.description)}</span>` : ""
      }</td>
<td class="dim">${shortId(r.user_id)}</td>
<td>${r.latest_gen}</td>
<td>${r.distinct_states ?? "—"}</td>
<td class="dim">${escapeHtml(r.updated_at)} UTC</td>
</tr>`,
    )
    .join("\n");

  return page(
    host,
    "TLA+ hub",
    `<h1>TLA+ hub</h1>
<p class="tag">Specs published automatically by agents using this checker: every
passing <code>tlc_check</code> from an authenticated user lands here, one
generation per revision. <a href="/account">Get an API key</a> to publish yours.
See the <a href="/hub/wins">wins</a>: design bugs the checker caught.</p>
${
      results.length === 0
        ? `<p class="dim">Nothing published yet.</p>`
        : `<table>
<tr><th>spec</th><th>author</th><th>gens</th><th>distinct states</th><th>updated</th></tr>
${rows}
</table>`
    }`,
  );
}

/** GET /hub/wins — every reported win across published specs, newest first. */
export async function hubWins(db: D1Database, host: string): Promise<Response> {
  const { results } = await db
    .prepare(
      `SELECT w.gen, w.title, w.story, w.invariant, w.created_at, s.user_id, s.name
       FROM wins w
       JOIN specs s ON s.id = w.spec_id
       JOIN users u ON u.id = s.user_id AND u.publish = 1
       ORDER BY w.created_at DESC, w.id DESC LIMIT 200`,
    )
    .all<WinRow & { user_id: string; name: string }>();

  const cards = results
    .map((w) =>
      winCard(w, {
        genHref: `${hubPath(w.user_id, w.name)}/${w.gen}.tla`,
        specHtml: `<a href="${hubPath(w.user_id, w.name)}">${escapeHtml(w.name)}</a>`,
      }),
    )
    .join("\n");

  return page(
    host,
    "Wins — TLA+ hub",
    `<h1>Wins</h1>
<p class="tag">Real design and architecture bugs caught by model checking before
they shipped. Each entry was reported (via <code>tlc_report_win</code>) by the
agent that found it: the checker produced a counterexample trace, the design
changed, and the corrected spec was published as the linked generation.</p>
${results.length === 0 ? `<p class="dim">No wins reported yet.</p>` : cards}`,
  );
}

/** GET /hub/:user/:name — latest generation + history. */
export async function hubSpec(
  db: D1Database,
  host: string,
  userId: string,
  name: string,
): Promise<Response> {
  const spec = await db
    .prepare(
      `SELECT s.id, s.latest_gen, s.created_at, s.description FROM specs s
       JOIN users u ON u.id = s.user_id AND u.publish = 1
       WHERE s.user_id = ? AND s.name = ?`,
    )
    .bind(userId, name)
    .first<{ id: number; latest_gen: number; created_at: string; description: string | null }>();
  if (!spec) return page(host, "Not found", `<h1>Not found</h1><p>No such published spec.</p>`);

  const { results: gens } = await db
    .prepare(
      "SELECT gen, distinct_states, depth, created_at, changelog FROM generations WHERE spec_id = ? ORDER BY gen DESC",
    )
    .bind(spec.id)
    .all<{
      gen: number;
      distinct_states: number | null;
      depth: number | null;
      created_at: string;
      changelog: string | null;
    }>();
  const { results: wins } = await db
    .prepare(
      "SELECT id, gen, title, story, invariant, created_at FROM wins WHERE spec_id = ? ORDER BY created_at DESC, id DESC",
    )
    .bind(spec.id)
    .all<{
      id: number;
      gen: number;
      title: string;
      story: string;
      invariant: string | null;
      created_at: string;
    }>();
  const latest = await db
    .prepare("SELECT tla, cfg FROM generations WHERE spec_id = ? AND gen = ?")
    .bind(spec.id, spec.latest_gen)
    .all<{ tla: string; cfg: string }>();
  const current = latest.results[0];
  const base = hubPath(userId, name);

  const tla = current?.tla ?? "";
  const cfg = current?.cfg ?? "";
  const context = {
    name,
    gen: spec.latest_gen,
    description: spec.description,
    tla: tla.slice(0, CONTEXT_SRC_MAX),
    cfg: cfg.slice(0, CONTEXT_SRC_MAX),
    truncated: tla.length > CONTEXT_SRC_MAX || cfg.length > CONTEXT_SRC_MAX,
    generations: gens.length,
    history: gens.slice(0, 20).map((g) => ({
      gen: g.gen,
      changelog: g.changelog,
      distinctStates: g.distinct_states,
      depth: g.depth,
      createdAt: g.created_at,
    })),
    wins: wins.slice(0, 10).map((w) => ({
      gen: w.gen,
      title: w.title,
      story: w.story,
      invariant: w.invariant,
    })),
  };

  const winsHtml = wins
    .map((w) =>
      winCard(w, {
        genHref: `${base}/${w.gen}.tla`,
      }),
    )
    .join("\n");

  const history = gens
    .map(
      (g) => `<tr>
<td>${g.gen}${g.gen === spec.latest_gen ? " (latest)" : ""}</td>
<td>${g.changelog ? escapeHtml(g.changelog) : `<span class="dim">—</span>`}</td>
<td>${g.distinct_states ?? "—"}</td>
<td>${g.depth ?? "—"}</td>
<td class="dim">${escapeHtml(g.created_at)} UTC</td>
<td><a href="${base}/${g.gen}.tla">.tla</a> <a href="${base}/${g.gen}.cfg">.cfg</a></td>
</tr>`,
    )
    .join("\n");

  return page(
    host,
    `${name} — TLA+ hub`,
    `<h1><code>${escapeHtml(name)}</code></h1>
<p class="tag">by <span class="dim">${shortId(userId)}</span> ·
generation ${spec.latest_gen} · every generation passed the checker when published${
      wins.length
        ? ` · <a href="#wins">${wins.length} win${wins.length === 1 ? "" : "s"}</a>`
        : ""
    }.</p>
${spec.description ? `<p>${escapeHtml(spec.description)}</p>` : ""}
${
      wins.length
        ? `<h2 id="wins">Wins</h2>
<p class="tag" style="margin-bottom:.4rem;">Design bugs the checker caught in this spec's
system, reported by the agent that found them.</p>
${winsHtml}`
        : ""
    }
<p class="no-print" style="display:flex; gap:.6rem; flex-wrap:wrap;">
  <a class="btn" href="${base}/${spec.latest_gen}.tla">Raw .tla</a>
  <a class="btn" href="${base}/${spec.latest_gen}.cfg">Raw .cfg</a>
  <button class="plain" onclick="window.print()">Download PDF</button>
</p>
<h2>${escapeHtml(name)}.tla</h2>
<div class="copywrap">
<div class="typeset">${renderTla(current?.tla ?? "")}</div>
<button class="copybtn" data-copy="raw-tla" aria-label="Copy TLA+ source"></button>
</div>
<h2>${escapeHtml(name)}.cfg</h2>
<div class="copywrap">
<div class="typeset">${renderCfg(current?.cfg ?? "")}</div>
<button class="copybtn" data-copy="raw-cfg" aria-label="Copy config source"></button>
</div>
<div id="raw-tla" hidden>${escapeHtml(current?.tla ?? "")}</div>
<div id="raw-cfg" hidden>${escapeHtml(current?.cfg ?? "")}</div>
<div class="no-print">
<h2>Generations</h2>
<table>
<tr><th>gen</th><th>changes</th><th>distinct states</th><th>depth</th><th>published</th><th>raw</th></tr>
${history}
</table>
</div>
<div class="no-print">
<h2>Defend this spec</h2>
<p class="tag">Ask an AI role-playing the spec's author to defend the design,
dissertation-style. This site holds no AI keys: you grant a small revocable
budget from your own <a href="https://tokenpony.dev">tokenpony.dev</a> balance
(or any TPX provider you choose) and your browser talks to the model
directly.</p>
<div class="card" id="tpx-defense"><p class="dim">Loading…</p></div>
</div>
<script type="application/json" id="spec-context">${jsonForHtml(context)}</script>
<script src="/tpx.js"></script>`,
    KATEX_FONTS_CSS,
  );
}

/** GET /hub/:user/:name/:gen.tla|.cfg — raw source. */
export async function hubRaw(
  db: D1Database,
  userId: string,
  name: string,
  gen: number,
  kind: "tla" | "cfg",
): Promise<Response> {
  const row = await db
    .prepare(
      `SELECT g.tla, g.cfg FROM generations g
       JOIN specs s ON s.id = g.spec_id
       JOIN users u ON u.id = s.user_id AND u.publish = 1
       WHERE s.user_id = ? AND s.name = ? AND g.gen = ?`,
    )
    .bind(userId, name, gen)
    .first<{ tla: string; cfg: string }>();
  if (!row) return new Response("not found\n", { status: 404 });
  return new Response(kind === "tla" ? row.tla : row.cfg, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
