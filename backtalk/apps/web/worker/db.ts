// All SQL lives here. Idempotent writes use client-generated UUID PKs +
// INSERT OR IGNORE. The error-group hot path never read-modify-writes: the
// resolved->regressed flip rides inside a single conditional UPDATE
// (model-checked in specs/BacktalkGroups.tla). Insert order there is
// group -> event -> update so the events FK always has a parent row.

import type { ErrorStatus, FeedbackStatus } from './lifecycle';

export interface Project {
  id: string;
  owner_id: string;
  name: string;
  public_key: string;
  allowed_origins: string;
  created_at: number;
}

export interface FeedbackItem {
  id: string;
  project_id: string;
  kind: string;
  message: string;
  page_url: string | null;
  viewport: string | null;
  ua: string | null;
  tz: string | null;
  metadata: string | null;
  breadcrumbs: string | null;
  release: string | null;
  status: FeedbackStatus;
  resolution_note: string | null;
  created_at: number;
  updated_at: number;
}

export interface ErrorGroup {
  id: string;
  project_id: string;
  fingerprint: string;
  title: string;
  status: ErrorStatus;
  resolution_note: string | null;
  resolved_at: number | null;
  event_count: number;
  first_seen: number;
  last_seen: number;
  first_release: string | null;
  last_release: string | null;
  resolved_in_release: string | null;
}

export interface ErrorEvent {
  id: string;
  group_id: string;
  message: string | null;
  stack: string | null;
  page_url: string | null;
  ua: string | null;
  release: string | null;
  breadcrumbs: string | null;
  created_at: number;
}

// ---------------------------------------------------------------- users

export async function upsertUser(db: D1Database, id: string): Promise<void> {
  await db
    .prepare('INSERT OR IGNORE INTO users (id, created_at) VALUES (?, ?)')
    .bind(id, Date.now())
    .run();
}

// ---------------------------------------------------------------- tokens

export async function listTokens(db: D1Database, userId: string) {
  const { results } = await db
    .prepare(
      'SELECT token_hash, name, created_at, last_used_at FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC'
    )
    .bind(userId)
    .all();
  return results;
}

export async function insertToken(
  db: D1Database,
  args: { tokenHash: string; userId: string; name: string }
): Promise<void> {
  await db
    .prepare('INSERT INTO api_tokens (token_hash, user_id, name, created_at) VALUES (?, ?, ?, ?)')
    .bind(args.tokenHash, args.userId, args.name, Date.now())
    .run();
}

export async function deleteToken(
  db: D1Database,
  userId: string,
  tokenHash: string
): Promise<boolean> {
  const res = await db
    .prepare('DELETE FROM api_tokens WHERE token_hash = ? AND user_id = ?')
    .bind(tokenHash, userId)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

// ---------------------------------------------------------------- projects

export async function createProject(
  db: D1Database,
  args: { id: string; ownerId: string; name: string; publicKey: string }
): Promise<void> {
  await db
    .prepare(
      'INSERT INTO projects (id, owner_id, name, public_key, created_at) VALUES (?, ?, ?, ?, ?)'
    )
    .bind(args.id, args.ownerId, args.name, args.publicKey, Date.now())
    .run();
}

export async function listProjects(db: D1Database, ownerId: string) {
  const { results } = await db
    .prepare(
      `SELECT p.*,
        (SELECT COUNT(*) FROM feedback f WHERE f.project_id = p.id AND f.status = 'new') AS new_feedback,
        (SELECT COUNT(*) FROM error_groups g WHERE g.project_id = p.id AND g.status IN ('open','regressed')) AS open_errors
       FROM projects p WHERE p.owner_id = ? ORDER BY p.created_at DESC`
    )
    .bind(ownerId)
    .all();
  return results;
}

export async function getProject(
  db: D1Database,
  ownerId: string,
  id: string
): Promise<Project | null> {
  return db
    .prepare('SELECT * FROM projects WHERE id = ? AND owner_id = ?')
    .bind(id, ownerId)
    .first<Project>();
}

export async function projectCounts(db: D1Database, projectId: string) {
  const [fb, eg] = await Promise.all([
    db
      .prepare('SELECT status, COUNT(*) AS n FROM feedback WHERE project_id = ? GROUP BY status')
      .bind(projectId)
      .all<{ status: string; n: number }>(),
    db
      .prepare('SELECT status, COUNT(*) AS n FROM error_groups WHERE project_id = ? GROUP BY status')
      .bind(projectId)
      .all<{ status: string; n: number }>(),
  ]);
  return {
    feedback: Object.fromEntries(fb.results.map((r) => [r.status, r.n])),
    errors: Object.fromEntries(eg.results.map((r) => [r.status, r.n])),
  };
}

export async function projectByKey(db: D1Database, publicKey: string): Promise<Project | null> {
  return db
    .prepare('SELECT * FROM projects WHERE public_key = ?')
    .bind(publicKey)
    .first<Project>();
}

export async function updateProject(
  db: D1Database,
  ownerId: string,
  id: string,
  fields: { name?: string; allowedOrigins?: string }
): Promise<boolean> {
  const res = await db
    .prepare(
      'UPDATE projects SET name = COALESCE(?, name), allowed_origins = COALESCE(?, allowed_origins) WHERE id = ? AND owner_id = ?'
    )
    .bind(fields.name ?? null, fields.allowedOrigins ?? null, id, ownerId)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

export async function deleteProject(db: D1Database, ownerId: string, id: string): Promise<boolean> {
  const owned = await getProject(db, ownerId, id);
  if (!owned) return false;
  await db.batch([
    db.prepare('DELETE FROM error_events WHERE group_id IN (SELECT id FROM error_groups WHERE project_id = ?)').bind(id),
    db.prepare('DELETE FROM error_groups WHERE project_id = ?').bind(id),
    db.prepare('DELETE FROM feedback WHERE project_id = ?').bind(id),
    db.prepare('DELETE FROM vitals_daily WHERE project_id = ?').bind(id),
    db.prepare('DELETE FROM pageviews_daily WHERE project_id = ?').bind(id),
    db.prepare('DELETE FROM ingest_daily WHERE project_id = ?').bind(id),
    db.prepare('DELETE FROM projects WHERE id = ? AND owner_id = ?').bind(id, ownerId),
  ]);
  return true;
}

// ---------------------------------------------------------------- feedback

export async function insertFeedback(
  db: D1Database,
  f: {
    id: string;
    projectId: string;
    kind: string;
    message: string;
    pageUrl: string | null;
    viewport: string | null;
    ua: string | null;
    tz: string | null;
    metadata: string | null;
    breadcrumbs: string | null;
    release: string | null;
  }
): Promise<boolean> {
  const now = Date.now();
  const res = await db
    .prepare(
      `INSERT OR IGNORE INTO feedback
        (id, project_id, kind, message, page_url, viewport, ua, tz, metadata, breadcrumbs, release, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      f.id, f.projectId, f.kind, f.message, f.pageUrl, f.viewport, f.ua, f.tz,
      f.metadata, f.breadcrumbs, f.release, now, now
    )
    .run();
  return (res.meta.changes ?? 0) > 0;
}

export async function listFeedback(
  db: D1Database,
  projectId: string,
  status: FeedbackStatus | undefined,
  limit: number
): Promise<FeedbackItem[]> {
  const { results } = status
    ? await db
        .prepare(
          'SELECT * FROM feedback WHERE project_id = ? AND status = ? ORDER BY created_at DESC LIMIT ?'
        )
        .bind(projectId, status, limit)
        .all<FeedbackItem>()
    : await db
        .prepare('SELECT * FROM feedback WHERE project_id = ? ORDER BY created_at DESC LIMIT ?')
        .bind(projectId, limit)
        .all<FeedbackItem>();
  return results;
}

/** Item + ownership check in one query (join through projects). */
export async function getFeedbackOwned(
  db: D1Database,
  ownerId: string,
  id: string
): Promise<FeedbackItem | null> {
  return db
    .prepare(
      `SELECT f.* FROM feedback f JOIN projects p ON p.id = f.project_id
       WHERE f.id = ? AND p.owner_id = ?`
    )
    .bind(id, ownerId)
    .first<FeedbackItem>();
}

/** Conditional on the expected current status; changes=0 means a concurrent writer won. */
export async function setFeedbackStatus(
  db: D1Database,
  id: string,
  from: FeedbackStatus,
  to: FeedbackStatus,
  note: string | null
): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE feedback SET status = ?, resolution_note = COALESCE(?, resolution_note), updated_at = ?
       WHERE id = ? AND status = ?`
    )
    .bind(to, note, Date.now(), id, from)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/** Public status view for the widget: only ids the caller already holds. */
export async function feedbackStatuses(
  db: D1Database,
  projectId: string,
  ids: string[]
): Promise<Pick<FeedbackItem, 'id' | 'kind' | 'status' | 'resolution_note' | 'created_at'>[]> {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  const { results } = await db
    .prepare(
      `SELECT id, kind, status, resolution_note, created_at FROM feedback
       WHERE project_id = ? AND id IN (${placeholders}) ORDER BY created_at DESC`
    )
    .bind(projectId, ...ids)
    .all<Pick<FeedbackItem, 'id' | 'kind' | 'status' | 'resolution_note' | 'created_at'>>();
  return results;
}

// ---------------------------------------------------------------- errors

/**
 * Ingest one error event. Group first (deterministic id, INSERT OR IGNORE),
 * then the event row (client UUID; changes=0 = retry duplicate, stop), then
 * one conditional UPDATE that counts the event and flips resolved->regressed
 * when the occurrence proves a resolved bug is back. No release info means
 * any reoccurrence regresses; with releases, only a different release than
 * the one it was resolved in does.
 */
export async function ingestError(
  db: D1Database,
  ev: {
    id: string;
    projectId: string;
    groupId: string;
    fingerprint: string;
    title: string;
    message: string;
    stack: string | null;
    pageUrl: string | null;
    ua: string | null;
    release: string | null;
    breadcrumbs: string | null;
  }
): Promise<'accepted' | 'duplicate'> {
  const now = Date.now();
  await db
    .prepare(
      `INSERT OR IGNORE INTO error_groups
        (id, project_id, fingerprint, title, status, event_count, first_seen, last_seen, first_release, last_release)
       VALUES (?, ?, ?, ?, 'open', 0, ?, ?, ?, ?)`
    )
    .bind(ev.groupId, ev.projectId, ev.fingerprint, ev.title, now, now, ev.release, ev.release)
    .run();

  const ins = await db
    .prepare(
      `INSERT OR IGNORE INTO error_events
        (id, group_id, message, stack, page_url, ua, release, breadcrumbs, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(ev.id, ev.groupId, ev.message, ev.stack, ev.pageUrl, ev.ua, ev.release, ev.breadcrumbs, now)
    .run();
  if ((ins.meta.changes ?? 0) === 0) return 'duplicate';

  await db
    .prepare(
      `UPDATE error_groups SET
         event_count = event_count + 1,
         last_seen = ?,
         last_release = COALESCE(?, last_release),
         status = CASE
           WHEN status = 'resolved' AND (? IS NULL OR ? IS NOT resolved_in_release)
           THEN 'regressed' ELSE status END
       WHERE id = ?`
    )
    .bind(now, ev.release, ev.release, ev.release, ev.groupId)
    .run();
  return 'accepted';
}

/** Keep only the newest 10 sample events per group (run via waitUntil). */
export async function pruneErrorSamples(db: D1Database, groupId: string): Promise<void> {
  await db
    .prepare(
      `DELETE FROM error_events WHERE group_id = ?1 AND id NOT IN
         (SELECT id FROM error_events WHERE group_id = ?1 ORDER BY created_at DESC LIMIT 10)`
    )
    .bind(groupId)
    .run();
}

export async function listErrorGroups(
  db: D1Database,
  projectId: string,
  status: ErrorStatus | undefined,
  limit: number
): Promise<ErrorGroup[]> {
  const { results } = status
    ? await db
        .prepare(
          'SELECT * FROM error_groups WHERE project_id = ? AND status = ? ORDER BY last_seen DESC LIMIT ?'
        )
        .bind(projectId, status, limit)
        .all<ErrorGroup>()
    : await db
        .prepare('SELECT * FROM error_groups WHERE project_id = ? ORDER BY last_seen DESC LIMIT ?')
        .bind(projectId, limit)
        .all<ErrorGroup>();
  return results;
}

export async function getErrorGroupOwned(
  db: D1Database,
  ownerId: string,
  groupId: string
): Promise<{ group: ErrorGroup; samples: ErrorEvent[] } | null> {
  const group = await db
    .prepare(
      `SELECT g.* FROM error_groups g JOIN projects p ON p.id = g.project_id
       WHERE g.id = ? AND p.owner_id = ?`
    )
    .bind(groupId, ownerId)
    .first<ErrorGroup>();
  if (!group) return null;
  const { results: samples } = await db
    .prepare('SELECT * FROM error_events WHERE group_id = ? ORDER BY created_at DESC LIMIT 10')
    .bind(groupId)
    .all<ErrorEvent>();
  return { group, samples };
}

/** Manual transition, conditional on the expected current status. */
export async function setErrorStatus(
  db: D1Database,
  groupId: string,
  from: ErrorStatus,
  to: ErrorStatus,
  note: string | null
): Promise<boolean> {
  const now = Date.now();
  const res =
    to === 'resolved'
      ? await db
          .prepare(
            `UPDATE error_groups SET status = 'resolved', resolution_note = COALESCE(?, resolution_note),
               resolved_at = ?, resolved_in_release = last_release
             WHERE id = ? AND status = ?`
          )
          .bind(note, now, groupId, from)
          .run()
      : await db
          .prepare(
            `UPDATE error_groups SET status = ?, resolution_note = COALESCE(?, resolution_note)
             WHERE id = ? AND status = ?`
          )
          .bind(to, note, groupId, from)
          .run();
  return (res.meta.changes ?? 0) > 0;
}

// ---------------------------------------------------------------- rollups

/** Bump the daily ingest counter; returns the count AFTER adding n (the rate limiter). */
export async function bumpIngestDaily(
  db: D1Database,
  projectId: string,
  day: string,
  kind: string,
  n: number
): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO ingest_daily (project_id, day, kind, count) VALUES (?, ?, ?, ?)
       ON CONFLICT (project_id, day, kind) DO UPDATE SET count = count + excluded.count
       RETURNING count`
    )
    .bind(projectId, day, kind, n)
    .first<{ count: number }>();
  return row?.count ?? n;
}

export async function upsertVital(
  db: D1Database,
  args: {
    projectId: string;
    day: string;
    path: string;
    metric: string;
    value: number;
    bucket: 'good' | 'needs' | 'poor';
  }
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO vitals_daily (project_id, day, path, metric, count, sum_value, good, needs, poor)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)
       ON CONFLICT (project_id, day, path, metric) DO UPDATE SET
         count = count + 1, sum_value = sum_value + excluded.sum_value,
         good = good + excluded.good, needs = needs + excluded.needs, poor = poor + excluded.poor`
    )
    .bind(
      args.projectId, args.day, args.path, args.metric, args.value,
      args.bucket === 'good' ? 1 : 0,
      args.bucket === 'needs' ? 1 : 0,
      args.bucket === 'poor' ? 1 : 0
    )
    .run();
}

export async function bumpPageview(
  db: D1Database,
  projectId: string,
  day: string,
  path: string
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO pageviews_daily (project_id, day, path, count) VALUES (?, ?, ?, 1)
       ON CONFLICT (project_id, day, path) DO UPDATE SET count = count + 1`
    )
    .bind(projectId, day, path)
    .run();
}

export async function statsOverview(db: D1Database, projectId: string, sinceDay: string) {
  const [vitals, pageviews] = await Promise.all([
    db
      .prepare(
        `SELECT day, path, metric, count, sum_value, good, needs, poor FROM vitals_daily
         WHERE project_id = ? AND day >= ? ORDER BY day ASC`
      )
      .bind(projectId, sinceDay)
      .all(),
    db
      .prepare(
        `SELECT day, path, count FROM pageviews_daily
         WHERE project_id = ? AND day >= ? ORDER BY day ASC`
      )
      .bind(projectId, sinceDay)
      .all(),
  ]);
  return { vitals: vitals.results, pageviews: pageviews.results };
}
