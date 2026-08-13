import { Hono } from 'hono';
import type { AppContext } from './env';
import { llmsTxt } from './llms';
import { parseRange } from './range';

const app = new Hono<AppContext>();

const KEY = /^[a-z0-9][a-z0-9.-]{0,127}\.tif$/;

app.get('/llms.txt', (c) => {
  const host = c.req.header('host') ?? new URL(c.req.url).host;
  return c.text(llmsTxt(host));
});

// Range-proxied COG bytes out of R2. The MapLibre COG protocol reads tiles
// with byte-range requests, so 206 support is the whole point of this route.
app.on(['GET', 'HEAD'], '/cog/:key', async (c) => {
  const key = c.req.param('key');
  if (!KEY.test(key)) return c.json({ error: 'bad key' }, 400);

  const head = await c.env.COGS.head(`cogs/${key}`);
  if (!head) return c.json({ error: 'not found' }, 404);
  const size = head.size;

  const headers: Record<string, string> = {
    'Content-Type': 'image/tiff',
    'Accept-Ranges': 'bytes',
    ETag: head.httpEtag,
    // Re-uploading a key overwrites in place, so hours not forever.
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

  const object = await c.env.COGS.get(
    `cogs/${key}`,
    range === null ? undefined : { range: { offset, length } }
  );
  if (!object) return c.json({ error: 'not found' }, 404);
  return c.body(object.body, status, headers);
});

// Anything else falls through to the static assets.
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
