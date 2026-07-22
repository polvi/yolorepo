import { Hono } from "hono";
import type { Context, Next } from "hono";
import { parseUserscriptMeta } from "@openmonkey/shared";

type Env = {
  DB: D1Database;
};

type Vars = {
  userId: string;
};

const AUTH_ENDPOINT = "https://authgravity.proc.io";

const app = new Hono<{ Bindings: Env; Variables: Vars }>().basePath("/api");

// ---- CORS: site + local dev, with credentials -------------------------------

const ALLOWED_ORIGIN_RE =
  /^(https:\/\/openmonkey\.proc\.io|https?:\/\/localhost(:\d+)?)$/;

app.use("*", async (c, next) => {
  const origin = c.req.header("origin");
  const allowed = origin && ALLOWED_ORIGIN_RE.test(origin);
  if (allowed) {
    c.header("Access-Control-Allow-Origin", origin);
    c.header("Access-Control-Allow-Credentials", "true");
    c.header("Vary", "Origin");
  }
  if (c.req.method === "OPTIONS") {
    c.header("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
    c.header("Access-Control-Allow-Headers", "Content-Type");
    c.header("Access-Control-Max-Age", "86400");
    return c.body(null, 204);
  }
  await next();
});

// ---- Auth middleware: validate AuthGravity session cookie -------------------

async function requireAuth(c: Context<{ Bindings: Env; Variables: Vars }>, next: Next) {
  const cookie = c.req.header("cookie");
  if (!cookie) return c.json({ error: "unauthenticated" }, 401);
  const res = await fetch(`${AUTH_ENDPOINT}/v1/whoami`, { headers: { cookie } });
  if (!res.ok) return c.json({ error: "unauthenticated" }, 401);
  const { user_id } = (await res.json()) as { user_id: string };
  await c.env.DB.prepare("INSERT OR IGNORE INTO users (id) VALUES (?)").bind(user_id).run();
  c.set("userId", user_id);
  await next();
}

// ---- Helpers -----------------------------------------------------------------

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "script"
  );
}

const SCRIPT_COLS = `s.id, s.slug, s.name, s.description, s.author_id, s.forked_from,
  s.install_count, s.created_at, u.handle AS author_handle,
  (SELECT MAX(v.version) FROM versions v WHERE v.script_id = s.id) AS latest_version`;

// ---- Public read endpoints ----------------------------------------------------

app.get("/scripts", async (c) => {
  const q = c.req.query("q");
  const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10) || 50, 100);
  let stmt;
  if (q) {
    stmt = c.env.DB.prepare(
      `SELECT ${SCRIPT_COLS} FROM scripts s LEFT JOIN users u ON u.id = s.author_id
       WHERE s.name LIKE ?1 OR s.description LIKE ?1
       ORDER BY s.created_at DESC LIMIT ?2`
    ).bind(`%${q}%`, limit);
  } else {
    stmt = c.env.DB.prepare(
      `SELECT ${SCRIPT_COLS} FROM scripts s LEFT JOIN users u ON u.id = s.author_id
       ORDER BY s.created_at DESC LIMIT ?1`
    ).bind(limit);
  }
  const { results } = await stmt.all();
  return c.json({ scripts: results });
});

async function getScriptBySlug(db: D1Database, slug: string) {
  return db
    .prepare(`SELECT ${SCRIPT_COLS} FROM scripts s LEFT JOIN users u ON u.id = s.author_id WHERE s.slug = ?`)
    .bind(slug)
    .first();
}

// Raw latest code at a *.user.js path. Userscript managers (Userscripts for
// Safari, Tampermonkey, Violentmonkey) key their install flow off the URL
// ending in .user.js, so this route is what makes one-click installs work.
// A fetch here is the closest observable proxy for an install, so it counts.
app.get("/scripts/:file{.+\\.user\\.js}", async (c) => {
  const slug = c.req.param("file").replace(/\.user\.js$/, "");
  const script = await getScriptBySlug(c.env.DB, slug);
  if (!script) return c.text("not found", 404);
  const version = await c.env.DB.prepare(
    "SELECT code FROM versions WHERE script_id = ? ORDER BY version DESC LIMIT 1"
  )
    .bind(script.id)
    .first<{ code: string }>();
  if (!version) return c.text("not found", 404);
  c.executionCtx.waitUntil(
    c.env.DB.prepare("UPDATE scripts SET install_count = install_count + 1 WHERE id = ?")
      .bind(script.id)
      .run()
  );
  return c.text(version.code, 200, { "Content-Type": "text/javascript; charset=utf-8" });
});

app.get("/scripts/:slug", async (c) => {
  const script = await getScriptBySlug(c.env.DB, c.req.param("slug"));
  if (!script) return c.json({ error: "not_found" }, 404);
  const version = await c.env.DB.prepare(
    "SELECT * FROM versions WHERE script_id = ? ORDER BY version DESC LIMIT 1"
  )
    .bind(script.id)
    .first();
  return c.json({ script, version });
});

app.get("/scripts/:slug/versions", async (c) => {
  const script = await getScriptBySlug(c.env.DB, c.req.param("slug"));
  if (!script) return c.json({ error: "not_found" }, 404);
  const { results } = await c.env.DB.prepare(
    "SELECT id, version, changelog, created_at FROM versions WHERE script_id = ? ORDER BY version DESC"
  )
    .bind(script.id)
    .all();
  return c.json({ versions: results });
});

app.get("/scripts/:slug/versions/:n", async (c) => {
  const script = await getScriptBySlug(c.env.DB, c.req.param("slug"));
  if (!script) return c.json({ error: "not_found" }, 404);
  const version = await c.env.DB.prepare(
    "SELECT * FROM versions WHERE script_id = ? AND version = ?"
  )
    .bind(script.id, parseInt(c.req.param("n"), 10))
    .first();
  if (!version) return c.json({ error: "not_found" }, 404);
  return c.json({ script, version });
});

// Legacy raw URL: send managers to the canonical .user.js path.
app.get("/scripts/:slug/raw", (c) =>
  c.redirect(`/api/scripts/${c.req.param("slug")}.user.js`, 301)
);

app.get("/versions/:id/scans", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT r.id, r.version_id, r.reporter_id, u.handle AS reporter_handle,
            r.verdict, r.summary, r.model, r.created_at
     FROM scan_reports r LEFT JOIN users u ON u.id = r.reporter_id
     WHERE r.version_id = ? ORDER BY r.created_at DESC LIMIT 100`
  )
    .bind(c.req.param("id"))
    .all();
  return c.json({ scans: results });
});

// ---- Authenticated endpoints ----------------------------------------------------

app.get("/me", requireAuth, async (c) => {
  const userId = c.get("userId");
  const row = await c.env.DB.prepare("SELECT id, handle, created_at FROM users WHERE id = ?")
    .bind(userId)
    .first();
  return c.json({ user: row });
});

app.post("/me/handle", requireAuth, async (c) => {
  const { handle } = await c.req.json<{ handle: string }>();
  if (!handle || !/^[a-z0-9][a-z0-9-]{1,30}$/.test(handle)) {
    return c.json({ error: "invalid_handle" }, 400);
  }
  try {
    await c.env.DB.prepare("UPDATE users SET handle = ? WHERE id = ?")
      .bind(handle, c.get("userId"))
      .run();
  } catch {
    return c.json({ error: "handle_taken" }, 409);
  }
  return c.json({ ok: true, handle });
});

// Publish a new script. Done in the open: publicly listed immediately.
app.post("/scripts", requireAuth, async (c) => {
  const body = await c.req.json<{ name?: string; description?: string; code: string }>();
  if (!body.code || body.code.length > 200_000) return c.json({ error: "invalid_code" }, 400);
  const meta = parseUserscriptMeta(body.code);
  const name = body.name || meta.name;
  if (!name) return c.json({ error: "missing_name" }, 400);
  if (meta.matches.length === 0) return c.json({ error: "missing_match_pattern" }, 400);

  const id = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const slug = `${slugify(name)}-${id.slice(0, 6)}`;
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO scripts (id, slug, name, description, author_id) VALUES (?,?,?,?,?)"
    ).bind(id, slug, name, body.description ?? meta.description ?? null, c.get("userId")),
    c.env.DB.prepare(
      "INSERT INTO versions (id, script_id, version, code, match_patterns) VALUES (?,?,1,?,?)"
    ).bind(versionId, id, body.code, JSON.stringify(meta.matches)),
  ]);
  const script = await getScriptBySlug(c.env.DB, slug);
  return c.json({ script }, 201);
});

// Publish a new version (author only).
app.post("/scripts/:slug/versions", requireAuth, async (c) => {
  const script = await getScriptBySlug(c.env.DB, c.req.param("slug"));
  if (!script) return c.json({ error: "not_found" }, 404);
  if (script.author_id !== c.get("userId")) return c.json({ error: "forbidden" }, 403);
  const body = await c.req.json<{ code: string; changelog?: string }>();
  if (!body.code || body.code.length > 200_000) return c.json({ error: "invalid_code" }, 400);
  const meta = parseUserscriptMeta(body.code);
  if (meta.matches.length === 0) return c.json({ error: "missing_match_pattern" }, 400);
  const next = ((script.latest_version as number) ?? 0) + 1;
  const versionId = crypto.randomUUID();
  await c.env.DB.prepare(
    "INSERT INTO versions (id, script_id, version, code, match_patterns, changelog) VALUES (?,?,?,?,?,?)"
  )
    .bind(versionId, script.id, next, body.code, JSON.stringify(meta.matches), body.changelog ?? null)
    .run();
  return c.json({ version: { id: versionId, version: next } }, 201);
});

// Fork: new script authored by the caller, lineage recorded, seeded from latest
// source version (or caller-modified code).
app.post("/scripts/:slug/fork", requireAuth, async (c) => {
  const source = await getScriptBySlug(c.env.DB, c.req.param("slug"));
  if (!source) return c.json({ error: "not_found" }, 404);
  const latest = await c.env.DB.prepare(
    "SELECT code, match_patterns FROM versions WHERE script_id = ? ORDER BY version DESC LIMIT 1"
  )
    .bind(source.id)
    .first<{ code: string; match_patterns: string }>();
  if (!latest) return c.json({ error: "not_found" }, 404);

  const body = await c.req.json<{ name?: string; code?: string }>().catch(() => ({}) as any);
  const code = body.code ?? latest.code;
  if (code.length > 200_000) return c.json({ error: "invalid_code" }, 400);
  const meta = parseUserscriptMeta(code);
  const matches = meta.matches.length > 0 ? JSON.stringify(meta.matches) : latest.match_patterns;
  const name = body.name ?? `${source.name} (fork)`;

  const id = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const slug = `${slugify(name)}-${id.slice(0, 6)}`;
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO scripts (id, slug, name, description, author_id, forked_from) VALUES (?,?,?,?,?,?)"
    ).bind(id, slug, name, source.description, c.get("userId"), source.id),
    c.env.DB.prepare(
      "INSERT INTO versions (id, script_id, version, code, match_patterns) VALUES (?,?,1,?,?)"
    ).bind(versionId, id, code, matches),
  ]);
  const script = await getScriptBySlug(c.env.DB, slug);
  return c.json({ script }, 201);
});

// Publish a scan report (transparency: scans are shared with the community).
app.post("/versions/:id/scans", requireAuth, async (c) => {
  const versionId = c.req.param("id");
  const version = await c.env.DB.prepare("SELECT id FROM versions WHERE id = ?")
    .bind(versionId)
    .first();
  if (!version) return c.json({ error: "not_found" }, 404);
  const body = await c.req.json<{ verdict: string; summary?: string; model?: string }>();
  if (!["pass", "warn", "fail"].includes(body.verdict)) return c.json({ error: "invalid_verdict" }, 400);
  await c.env.DB.prepare(
    `INSERT INTO scan_reports (id, version_id, reporter_id, verdict, summary, model)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT (version_id, reporter_id) DO UPDATE SET
       verdict = excluded.verdict, summary = excluded.summary,
       model = excluded.model, created_at = datetime('now')`
  )
    .bind(
      crypto.randomUUID(),
      versionId,
      c.get("userId"),
      body.verdict,
      body.summary?.slice(0, 2000) ?? null,
      body.model?.slice(0, 100) ?? null
    )
    .run();
  return c.json({ ok: true }, 201);
});

app.get("/health", (c) => c.json({ ok: true }));

export default app;
