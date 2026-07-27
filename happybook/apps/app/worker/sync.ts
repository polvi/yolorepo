import { Hono } from 'hono';
import { pushRequestSchema } from '@happybook/shared';
import type { AppContext } from './env';

/**
 * LWW is applied inside the SQL upsert so a whole push batch is atomic in D1
 * and concurrent pushes from two devices cannot interleave a read-then-write.
 * The WHERE clause mirrors compareVersions() in @happybook/shared exactly:
 * incoming wins iff (updated_at, write_id) is strictly greater.
 */
export const UPSERT = `
INSERT INTO records (user_id, id, type, notebook_id, data, updated_at, write_id, deleted, seq)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, (SELECT next_seq - 1 FROM user_state WHERE user_id = ?1))
ON CONFLICT (user_id, id) DO UPDATE SET
  type = excluded.type,
  notebook_id = excluded.notebook_id,
  data = excluded.data,
  updated_at = excluded.updated_at,
  write_id = excluded.write_id,
  deleted = excluded.deleted,
  seq = excluded.seq
WHERE excluded.updated_at > records.updated_at
   OR (excluded.updated_at = records.updated_at AND excluded.write_id > records.write_id)`;

export const sync = new Hono<AppContext>();

sync.post('/push', async (c) => {
  const db = c.env.DB;
  if (!db) return c.json({ error: 'sync not configured' }, 503);
  const userId = c.get('userId');

  const parsed = pushRequestSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid push body' }, 400);
  const { changes } = parsed.data;

  const statements = [
    db.prepare('INSERT INTO user_state (user_id, next_seq) VALUES (?1, 1) ON CONFLICT (user_id) DO NOTHING').bind(userId),
  ];
  for (const ch of changes) {
    statements.push(
      db.prepare('UPDATE user_state SET next_seq = next_seq + 1 WHERE user_id = ?1').bind(userId),
      db
        .prepare(UPSERT)
        .bind(userId, ch.id, ch.type, ch.notebookId, JSON.stringify(ch.data), ch.updatedAt, ch.writeId, ch.deleted),
    );
  }
  statements.push(db.prepare('SELECT next_seq FROM user_state WHERE user_id = ?1').bind(userId));

  const results = await db.batch(statements);

  const outcomes = changes.map((ch, i) => ({
    id: ch.id,
    // statement layout: [ensure] + per-change [bump, upsert] + [read next_seq]
    status: (results[2 + i * 2]!.meta.changes ?? 0) > 0 ? ('applied' as const) : ('stale' as const),
  }));
  const last = results[results.length - 1]!.results as { next_seq: number }[];
  const cursor = (last[0]?.next_seq ?? 1) - 1;

  return c.json({ cursor, results: outcomes });
});

sync.get('/pull', async (c) => {
  const db = c.env.DB;
  if (!db) return c.json({ error: 'sync not configured' }, 503);
  const userId = c.get('userId');

  const since = Number(c.req.query('since') ?? '0');
  const limit = Math.min(Number(c.req.query('limit') ?? '500'), 500);
  if (!Number.isFinite(since) || since < 0 || !Number.isFinite(limit) || limit < 1) {
    return c.json({ error: 'invalid cursor' }, 400);
  }

  const rows = await db
    .prepare(
      `SELECT id, type, notebook_id, data, updated_at, write_id, deleted, seq
       FROM records WHERE user_id = ?1 AND seq > ?2 ORDER BY seq LIMIT ?3`,
    )
    .bind(userId, since, limit + 1)
    .all<{
      id: string;
      type: string;
      notebook_id: string;
      data: string;
      updated_at: number;
      write_id: string;
      deleted: number;
      seq: number;
    }>();

  const hasMore = rows.results.length > limit;
  const page = rows.results.slice(0, limit);
  const changes = page.map((r) => ({
    id: r.id,
    type: r.type,
    notebookId: r.notebook_id,
    data: JSON.parse(r.data),
    updatedAt: r.updated_at,
    writeId: r.write_id,
    deleted: r.deleted as 0 | 1,
    seq: r.seq,
  }));

  return c.json({ changes, cursor: page.length ? page[page.length - 1]!.seq : since, hasMore });
});
