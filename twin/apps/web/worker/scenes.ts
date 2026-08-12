import { Hono } from 'hono';
import type { AppContext } from './env';
import { parseRange } from './range';

// Bucket layout (written by twin/bin/publish.ts, strictly in this order):
//   scenes/<slug>/splat      the Gaussian splat bytes (.sog/.spz/.ply)
//   scenes/<slug>/meta.json  scene metadata (title, file name, size, sha256)
//   index.json               { scenes: [...] } listing for the homepage
// Publish order artifact -> meta -> index means anything reachable from the
// index is fully readable (model-checked in twin/specs/TwinPublish.tla).

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const scenes = new Hono<AppContext>();

scenes.get('/', async (c) => {
  const obj = await c.env.SCENES.get('index.json');
  if (!obj) return c.json({ scenes: [] });
  return c.body(obj.body, 200, {
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=60',
  });
});

scenes.get('/:slug', async (c) => {
  const slug = c.req.param('slug');
  if (!SLUG.test(slug)) return c.json({ error: 'bad slug' }, 400);
  const obj = await c.env.SCENES.get(`scenes/${slug}/meta.json`);
  if (!obj) return c.json({ error: 'not found' }, 404);
  return c.body(obj.body, 200, {
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=60',
  });
});

// Range-proxied splat bytes. No D1 row to consult: size and etag come from a
// HEAD on the object itself.
scenes.on(['GET', 'HEAD'], '/:slug/artifact', async (c) => {
  const slug = c.req.param('slug');
  if (!SLUG.test(slug)) return c.json({ error: 'bad slug' }, 400);
  const key = `scenes/${slug}/splat`;

  const head = await c.env.SCENES.head(key);
  if (!head) return c.json({ error: 'not found' }, 404);
  const size = head.size;

  const headers: Record<string, string> = {
    'Content-Type': 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    ETag: head.httpEtag,
    // Republishing a slug overwrites in place, so hours not forever.
    'Cache-Control': 'public, max-age=3600',
  };

  const range = parseRange(c.req.header('range') ?? null, size);
  if (range === 'invalid') {
    return c.body(null, 416, { ...headers, 'Content-Range': `bytes */${size}` });
  }

  const offset = range === null ? 0 : 'suffix' in range ? size - range.suffix : range.offset;
  const length = range === null ? size : 'suffix' in range ? range.suffix : range.length;
  headers['Content-Length'] = String(length);
  if (range !== null) {
    headers['Content-Range'] = `bytes ${offset}-${offset + length - 1}/${size}`;
  }
  const status = range === null ? 200 : 206;

  if (c.req.method === 'HEAD') return c.body(null, status, headers);

  const object = await c.env.SCENES.get(
    key,
    range === null ? undefined : { range: { offset, length } }
  );
  if (!object) return c.json({ error: 'not found' }, 404);
  return c.body(object.body, status, headers);
});
