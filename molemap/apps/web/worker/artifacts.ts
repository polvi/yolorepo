import { Hono } from 'hono';
import type { AppContext } from './env';
import type { ArtifactKind } from './db';
import * as db from './db';
import { parseRange } from './range';

const CONTENT_TYPES: Record<ArtifactKind, string> = {
  crop: 'image/jpeg',
  preview: 'image/jpeg',
  manifest: 'application/json',
  detections: 'application/json',
  splat: 'application/octet-stream',
  pointcloud: 'application/octet-stream',
};

export const artifacts = new Hono<AppContext>();

// Range-proxying artifact reads. Ownership check is the artifacts->visits
// join; the R2 key is always <userId>/<sha256>, so even a bad row could
// never leak another user's bytes.
artifacts.on(['GET', 'HEAD'], '/:sha256', async (c) => {
  const userId = c.get('userId');
  const sha = c.req.param('sha256');
  const row = await db.artifactByShaForUser(c.env.DB, userId, sha);
  if (!row) return c.json({ error: 'not found' }, 404);

  const headers: Record<string, string> = {
    'Content-Type': CONTENT_TYPES[row.kind] ?? 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    ETag: `"${sha}"`,
    'Cache-Control': 'private, max-age=31536000, immutable',
  };

  const range = parseRange(c.req.header('range') ?? null, row.size);
  if (range === 'invalid') {
    return c.body(null, 416, { ...headers, 'Content-Range': `bytes */${row.size}` });
  }

  // Normalize the suffix form so Content-Range/Content-Length are exact.
  const offset = range === null ? 0 : 'suffix' in range ? row.size - range.suffix : range.offset;
  const length = range === null ? row.size : 'suffix' in range ? range.suffix : range.length;
  headers['Content-Length'] = String(length);
  if (range !== null) {
    headers['Content-Range'] = `bytes ${offset}-${offset + length - 1}/${row.size}`;
  }
  const status = range === null ? 200 : 206;

  if (c.req.method === 'HEAD') return c.body(null, status, headers);

  const object = await c.env.BLOBS.get(
    `${userId}/${sha}`,
    range === null ? undefined : { range: { offset, length } }
  );
  if (!object) return c.json({ error: 'not uploaded yet' }, 404);
  // Streamed straight through, never buffered.
  return c.body(object.body, status, headers);
});
