import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { progressIdFor, type ProgressRec } from '@happybook/shared';
import { UPSERT } from './sync';
import { generateWords, generatePassword, groupPassword } from './opds';
import type { AppContext } from './env';

/**
 * kosync: the KOReader progress-sync protocol (koreader-sync-server API).
 * KOReader's HTTP client raises on any status not in its expected list, so
 * every handler returns only the codes the plugin knows: 200/401 on sync
 * routes, 201/402/403 on user routes. "No progress" is 200 {}, never 404.
 */

const MD5_HEX = /^[0-9a-f]{32}$/;

async function md5Hex(data: BufferSource): Promise<string> {
  // MD5 in crypto.subtle is a Cloudflare Workers extension; KOReader's wire
  // format is MD5 throughout, there is no stronger-hash variant to prefer.
  const digest = await crypto.subtle.digest('MD5', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * KOReader identifies a document by its "partial MD5": one streaming MD5 over
 * up-to-12 samples of 1024 bytes at offsets 256 * 4^k (256, 1024, 4096, ...,
 * 1GiB), stopping at EOF, short final sample included. Sampling the head
 * heavily keeps the digest stable when readers append annotation data.
 */
const SAMPLE_OFFSETS = Array.from({ length: 12 }, (_, k) => 256 * 4 ** k);
const SAMPLE_BYTES = 1024;

function concatMd5(parts: Uint8Array[]): Promise<string> {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const joined = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    joined.set(p, at);
    at += p.byteLength;
  }
  return md5Hex(joined);
}

export function partialMd5FromBytes(buf: ArrayBuffer): Promise<string> {
  const parts: Uint8Array[] = [];
  for (const offset of SAMPLE_OFFSETS) {
    if (offset >= buf.byteLength) break;
    parts.push(new Uint8Array(buf.slice(offset, offset + SAMPLE_BYTES)));
  }
  return concatMd5(parts);
}

async function partialMd5FromR2(
  bucket: R2Bucket,
  key: string,
  size: number,
): Promise<string | null> {
  const parts: Uint8Array[] = [];
  for (const offset of SAMPLE_OFFSETS) {
    if (offset >= size) break;
    const object = await bucket.get(key, {
      range: { offset, length: Math.min(SAMPLE_BYTES, size - offset) },
    });
    if (!object) return null;
    parts.push(new Uint8Array(await object.arrayBuffer()));
  }
  return concatMd5(parts);
}

const unauthorized = (c: { json: (o: object, s: 401) => Response }) =>
  c.json({ code: 2001, message: 'Unauthorized' }, 401);

/**
 * x-auth-key is md5(password) computed on the device, so the server cannot
 * normalize typos the way OPDS auth does; it can only hash candidate strings.
 * The grouped display form (words separated by spaces) is accepted alongside
 * the canonical one since the UI shows the password that way.
 */
const kosyncAuth = createMiddleware<AppContext>(async (c, next) => {
  const db = c.env.DB;
  if (!db) return unauthorized(c);

  const username = (c.req.header('x-auth-user') ?? '').trim().toLowerCase();
  const key = (c.req.header('x-auth-key') ?? '').trim().toLowerCase();
  if (!username || !MD5_HEX.test(key)) return unauthorized(c);

  const row = await db
    .prepare('SELECT user_id, password FROM kosync_credentials WHERE username = ?1')
    .bind(username)
    .first<{ user_id: string; password: string }>();
  if (!row) return unauthorized(c);

  const enc = new TextEncoder();
  const candidates = [row.password, groupPassword(row.password)];
  let ok = false;
  for (const candidate of candidates) {
    if ((await md5Hex(enc.encode(candidate))) === key) {
      ok = true;
      break;
    }
  }
  if (!ok) return unauthorized(c);

  c.set('userId', row.user_id);
  await next();
});

type MatchedDoc = { id: string; notebook_id: string };

const DOC_BY_DIGEST = `
SELECT r.id, r.notebook_id FROM records r
JOIN kosync_digests d ON d.sha256 = json_extract(r.data, '$.sha256')
WHERE r.user_id = ?1 AND r.type = 'document' AND r.deleted = 0 AND d.digest = ?2
ORDER BY r.updated_at DESC LIMIT 1`;

/** Bounded so a first sync against a large pre-existing library cannot blow
 * KOReader's 5s read timeout; the remainder backfills on subsequent requests. */
const BACKFILL_CAP = 50;

async function backfillDigests(db: D1Database, bucket: R2Bucket, userId: string): Promise<boolean> {
  const missing = await db
    .prepare(
      `SELECT b.sha256, b.size FROM blobs b
       LEFT JOIN kosync_digests d ON d.sha256 = b.sha256
       WHERE b.user_id = ?1 AND d.sha256 IS NULL LIMIT ${BACKFILL_CAP}`,
    )
    .bind(userId)
    .all<{ sha256: string; size: number }>();

  for (const row of missing.results) {
    const digest = await partialMd5FromR2(bucket, `${userId}/${row.sha256}`, row.size);
    if (digest) {
      await db
        .prepare('INSERT OR IGNORE INTO kosync_digests (sha256, digest) VALUES (?1, ?2)')
        .bind(row.sha256, digest)
        .run();
    }
  }
  return missing.results.length > 0;
}

async function findDocumentByDigest(
  db: D1Database,
  bucket: R2Bucket | undefined,
  userId: string,
  digest: string,
): Promise<MatchedDoc | null> {
  const found = await db.prepare(DOC_BY_DIGEST).bind(userId, digest).first<MatchedDoc>();
  if (found || !bucket) return found;
  if (!(await backfillDigests(db, bucket, userId))) return null;
  return db.prepare(DOC_BY_DIGEST).bind(userId, digest).first<MatchedDoc>();
}

export const kosync = new Hono<AppContext>();

// Registered before kosyncAuth: KOReader sends no auth headers here. Accounts
// come from happybook's settings UI, not device-side registration.
kosync.post('/users/create', (c) =>
  c.json(
    {
      code: 2005,
      message: 'Registration is managed in happybook: enable KOReader sync in Settings, then use Login here.',
    },
    402,
  ),
);

kosync.use('*', kosyncAuth);

kosync.get('/users/auth', (c) => c.json({ authorized: 'OK' }));

kosync.put('/syncs/progress', async (c) => {
  const db = c.env.DB!;
  const userId = c.get('userId');

  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return c.json({ code: 2003, message: 'Invalid request' }, 403);

  const document = typeof body.document === 'string' ? body.document.toLowerCase() : '';
  if (!MD5_HEX.test(document)) {
    return c.json({ code: 2004, message: "Field 'document' not provided." }, 403);
  }
  const percentage = typeof body.percentage === 'number' ? body.percentage : NaN;
  const progress =
    typeof body.progress === 'string' || typeof body.progress === 'number'
      ? String(body.progress)
      : null;
  const device = typeof body.device === 'string' ? body.device : null;
  if (!Number.isFinite(percentage) || progress === null || device === null) {
    return c.json({ code: 2003, message: 'Invalid request' }, 403);
  }
  const deviceId = typeof body.device_id === 'string' ? body.device_id : undefined;
  const timestamp = Math.floor(Date.now() / 1000);

  const doc = await findDocumentByDigest(db, c.env.BLOBS, userId, document);
  if (doc) {
    const id = await progressIdFor(doc.id);
    const existing = await db
      .prepare('SELECT updated_at FROM records WHERE user_id = ?1 AND id = ?2')
      .bind(userId, id)
      .first<{ updated_at: number }>();
    // Lamport bump against the stored row, mirroring nextTimestamp(): clients
    // absorb this on pull, so server writes order correctly with client ones.
    const updatedAt = Math.max(Date.now(), (existing?.updated_at ?? 0) + 1);
    const data: ProgressRec = {
      id,
      updatedAt,
      writeId: crypto.randomUUID(),
      deleted: 0,
      notebookId: doc.notebook_id,
      documentId: doc.id,
      percentage,
      progress,
      device,
      ...(deviceId !== undefined ? { deviceId } : {}),
      timestamp,
    };
    await db.batch([
      db
        .prepare('INSERT INTO user_state (user_id, next_seq) VALUES (?1, 1) ON CONFLICT (user_id) DO NOTHING')
        .bind(userId),
      db.prepare('UPDATE user_state SET next_seq = next_seq + 1 WHERE user_id = ?1').bind(userId),
      db
        .prepare(UPSERT)
        .bind(userId, id, 'progress', doc.notebook_id, JSON.stringify(data), updatedAt, data.writeId, 0),
    ]);
  } else {
    await db
      .prepare(
        `INSERT INTO kosync_orphan_progress (user_id, document, progress, percentage, device, device_id, timestamp)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT (user_id, document) DO UPDATE SET
           progress = excluded.progress, percentage = excluded.percentage,
           device = excluded.device, device_id = excluded.device_id, timestamp = excluded.timestamp`,
      )
      .bind(userId, document, progress, percentage, device, deviceId ?? null, timestamp)
      .run();
  }

  return c.json({ document, timestamp });
});

kosync.get('/syncs/progress/:document', async (c) => {
  const db = c.env.DB!;
  const userId = c.get('userId');
  const document = c.req.param('document').toLowerCase();
  if (!MD5_HEX.test(document)) {
    return c.json({ code: 2004, message: "Field 'document' not provided." }, 403);
  }

  const doc = await findDocumentByDigest(db, c.env.BLOBS, userId, document);
  if (doc) {
    const row = await db
      .prepare('SELECT data FROM records WHERE user_id = ?1 AND id = ?2 AND deleted = 0')
      .bind(userId, await progressIdFor(doc.id))
      .first<{ data: string }>();
    // An empty progress string means only the web has written, and only
    // percentage: KOReader navigates EPUBs by the progress value alone, so an
    // empty one is "no position to jump to" and reads as no progress at all.
    if (row) {
      const p = JSON.parse(row.data) as ProgressRec;
      if (p.progress !== '') {
        return c.json({
          document,
          percentage: p.percentage,
          progress: p.progress,
          device: p.device,
          ...(p.deviceId !== undefined ? { device_id: p.deviceId } : {}),
          timestamp: p.timestamp,
        });
      }
      return c.json({});
    }
  }

  const orphan = await db
    .prepare(
      `SELECT progress, percentage, device, device_id, timestamp
       FROM kosync_orphan_progress WHERE user_id = ?1 AND document = ?2`,
    )
    .bind(userId, document)
    .first<{ progress: string; percentage: number; device: string; device_id: string | null; timestamp: number }>();
  if (orphan) {
    return c.json({
      document,
      percentage: orphan.percentage,
      progress: orphan.progress,
      device: orphan.device,
      ...(orphan.device_id !== null ? { device_id: orphan.device_id } : {}),
      timestamp: orphan.timestamp,
    });
  }

  return c.json({});
});

/** Cookie-authed management endpoints; mounted behind requireUser. */
export const kosyncSettings = new Hono<AppContext>();

type SettingsContext = Parameters<Parameters<typeof kosyncSettings.get>[1]>[0];

function credentials(c: SettingsContext, row: { username: string; password: string } | null) {
  if (!row) return c.json({ enabled: false as const });
  return c.json({
    enabled: true as const,
    username: row.username,
    password: row.password,
    passwordGrouped: groupPassword(row.password),
    url: `${new URL(c.req.url).origin}/api/kosync`,
  });
}

kosyncSettings.get('/', async (c) => {
  const db = c.env.DB;
  if (!db) return c.json({ error: 'kosync not configured' }, 503);
  const row = await db
    .prepare('SELECT username, password FROM kosync_credentials WHERE user_id = ?1')
    .bind(c.get('userId'))
    .first<{ username: string; password: string }>();
  return credentials(c, row ?? null);
});

kosyncSettings.post('/', async (c) => {
  const db = c.env.DB;
  if (!db) return c.json({ error: 'kosync not configured' }, 503);
  const userId = c.get('userId');

  // The UNIQUE(username) constraint can collide with another user's username;
  // with random words the retry is virtually never taken.
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    const username = generateWords(2);
    const password = generatePassword();
    try {
      await db
        .prepare(
          `INSERT INTO kosync_credentials (user_id, username, password, created_at) VALUES (?1, ?2, ?3, ?4)
           ON CONFLICT (user_id) DO UPDATE SET
             username = excluded.username, password = excluded.password, created_at = excluded.created_at`,
        )
        .bind(userId, username, password, Date.now())
        .run();
      return credentials(c, { username, password });
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
});

kosyncSettings.delete('/', async (c) => {
  const db = c.env.DB;
  if (!db) return c.json({ error: 'kosync not configured' }, 503);
  await db
    .prepare('DELETE FROM kosync_credentials WHERE user_id = ?1')
    .bind(c.get('userId'))
    .run();
  return credentials(c, null);
});
