import { Hono } from 'hono';
import { partialMd5FromBytes } from './kosync';
import type { AppContext } from './env';

const MAX_BLOB_BYTES = 50 * 1024 * 1024;
const SHA256_HEX = /^[0-9a-f]{64}$/;

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Blobs are PDFs or EPUBs; sniff magic bytes rather than trusting the client. */
function sniffContentType(buf: ArrayBuffer): string {
  const head = new Uint8Array(buf.slice(0, 4));
  if (head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46) {
    return 'application/pdf'; // %PDF
  }
  if (head[0] === 0x50 && head[1] === 0x4b) {
    return 'application/epub+zip'; // PK zip container
  }
  return 'application/octet-stream';
}

export const blobs = new Hono<AppContext>();

blobs.put('/:sha256', async (c) => {
  const bucket = c.env.BLOBS;
  const db = c.env.DB;
  if (!bucket || !db) return c.json({ error: 'blob storage not configured' }, 503);
  const userId = c.get('userId');
  const sha = c.req.param('sha256');
  if (!SHA256_HEX.test(sha)) return c.json({ error: 'invalid sha256' }, 400);

  const length = Number(c.req.header('content-length') ?? '0');
  if (length > MAX_BLOB_BYTES) return c.json({ error: 'too large' }, 413);

  const body = await c.req.arrayBuffer();
  if (body.byteLength === 0) return c.json({ error: 'empty body' }, 400);
  if (body.byteLength > MAX_BLOB_BYTES) return c.json({ error: 'too large' }, 413);
  if ((await sha256Hex(body)) !== sha) return c.json({ error: 'hash mismatch' }, 400);

  await bucket.put(`${userId}/${sha}`, body, {
    httpMetadata: { contentType: sniffContentType(body) },
  });
  await db
    .prepare(
      'INSERT INTO blobs (user_id, sha256, size, created_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (user_id, sha256) DO NOTHING',
    )
    .bind(userId, sha, body.byteLength, Date.now())
    .run();
  await db
    .prepare('INSERT OR IGNORE INTO kosync_digests (sha256, digest) VALUES (?1, ?2)')
    .bind(sha, await partialMd5FromBytes(body))
    .run();

  return c.json({ ok: true });
});

blobs.on('HEAD', '/:sha256', async (c) => {
  const bucket = c.env.BLOBS;
  if (!bucket) return c.body(null, 503);
  const head = await bucket.head(`${c.get('userId')}/${c.req.param('sha256')}`);
  return c.body(null, head ? 200 : 404);
});

blobs.get('/:sha256', async (c) => {
  const bucket = c.env.BLOBS;
  if (!bucket) return c.json({ error: 'blob storage not configured' }, 503);
  const object = await bucket.get(`${c.get('userId')}/${c.req.param('sha256')}`);
  if (!object) return c.json({ error: 'not found' }, 404);
  return c.body(object.body, 200, {
    // Objects written before EPUB support carry the old hardcoded PDF type.
    'Content-Type': object.httpMetadata?.contentType ?? 'application/pdf',
    'Content-Length': String(object.size),
    'Cache-Control': 'private, max-age=31536000, immutable',
  });
});
