// The public edge: one envelope endpoint every widget event type rides
// through, plus the submitter's status view. CORS is wide open (no
// credentials); real enforcement is the server-side Origin check against the
// project's allowlist, plus payload caps and per-project per-kind daily
// counters in ingest_daily. Bodies arrive as text/plain so sendBeacon never
// triggers a preflight — Content-Type is ignored, the raw body is parsed.

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { z } from 'zod';
import type { AppContext } from './env';
import * as db from './db';
import { fingerprint, groupIdFor, normalizeMessage } from './fingerprint';

export const DAILY_CAPS: Record<string, number> = {
  feedback: 200,
  error: 5000,
  vital: 20000,
  pageview: 20000,
};
const MAX_BODY_BYTES = 64 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const breadcrumbsSchema = z
  .array(
    z.object({
      t: z.number(),
      type: z.enum(['click', 'nav', 'console']),
      data: z.string().max(500),
    })
  )
  .max(20);

const feedbackEvent = z.object({
  type: z.literal('feedback'),
  id: z.string().regex(UUID_RE),
  kind: z.enum(['bug', 'idea', 'feedback']),
  message: z.string().trim().min(1).max(5000),
  page_url: z.string().max(1000).optional(),
  viewport: z.string().max(50).optional(),
  ua: z.string().max(500).optional(),
  tz: z.string().max(100).optional(),
  metadata: z.record(z.unknown()).optional(),
  breadcrumbs: breadcrumbsSchema.optional(),
});

const errorEvent = z.object({
  type: z.literal('error'),
  id: z.string().regex(UUID_RE),
  message: z.string().max(2000),
  stack: z.string().max(8192).optional(),
  page_url: z.string().max(1000).optional(),
  ua: z.string().max(500).optional(),
  breadcrumbs: breadcrumbsSchema.optional(),
});

const vitalEvent = z.object({
  type: z.literal('vital'),
  metric: z.enum(['LCP', 'INP', 'CLS']),
  value: z.number().finite().nonnegative(),
  path: z.string().max(500),
});

const pageviewEvent = z.object({
  type: z.literal('pageview'),
  path: z.string().max(500),
});

const eventSchema = z.discriminatedUnion('type', [
  feedbackEvent,
  errorEvent,
  vitalEvent,
  pageviewEvent,
]);

const envelopeSchema = z.object({
  key: z.string().min(1).max(100),
  release: z.string().trim().min(1).max(100).optional(),
  events: z.array(z.unknown()).min(1).max(25),
});

type IngestEvent = z.infer<typeof eventSchema>;

// ------------------------------------------------- pure helpers (tested)

/** web.dev thresholds; LCP/INP in ms, CLS unitless. */
export function bucketVital(metric: 'LCP' | 'INP' | 'CLS', value: number): 'good' | 'needs' | 'poor' {
  const [good, poor] =
    metric === 'LCP' ? [2500, 4000] : metric === 'INP' ? [200, 500] : [0.1, 0.25];
  return value <= good ? 'good' : value <= poor ? 'needs' : 'poor';
}

/** Rollup key: pathname only, no query/hash, bounded length. */
export function normalizePath(path: string): string {
  let p = path.replace(/[?#].*$/, '');
  if (!p.startsWith('/')) {
    try {
      p = new URL(p).pathname;
    } catch {
      p = `/${p}`;
    }
  }
  return p.slice(0, 200) || '/';
}

/** Empty allowlist = allow anyone. Otherwise the Origin header must match exactly. */
export function originAllowed(allowedOrigins: string, origin: string | null): boolean {
  const list = allowedOrigins
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.length === 0) return true;
  return origin !== null && list.includes(origin);
}

export function parseEnvelope(raw: string):
  | { ok: true; key: string; release: string | null; events: unknown[] }
  | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'body must be JSON' };
  }
  const env = envelopeSchema.safeParse(parsed);
  if (!env.success) return { ok: false, error: 'invalid envelope' };
  return { ok: true, key: env.data.key, release: env.data.release ?? null, events: env.data.events };
}

const today = () => new Date().toISOString().slice(0, 10);

// ------------------------------------------------------------- routes

export const ingest = new Hono<AppContext>();

ingest.use('/ingest', cors());
ingest.use('/submissions', cors());

ingest.post('/ingest', async (c) => {
  const raw = await c.req.text();
  if (raw.length > MAX_BODY_BYTES) return c.json({ error: 'payload too large' }, 413);
  const envd = parseEnvelope(raw);
  if (!envd.ok) return c.json({ error: envd.error }, 400);

  const project = await db.projectByKey(c.env.DB, envd.key);
  if (!project) return c.json({ error: 'unknown project key' }, 403);
  if (!originAllowed(project.allowed_origins, c.req.header('origin') ?? null)) {
    return c.json({ error: 'origin not allowed' }, 403);
  }

  let accepted = 0;
  let dropped = 0;

  const byKind = new Map<string, IngestEvent[]>();
  for (const rawEvent of envd.events) {
    const parsed = eventSchema.safeParse(rawEvent);
    if (!parsed.success) {
      dropped++;
      continue;
    }
    const list = byKind.get(parsed.data.type) ?? [];
    list.push(parsed.data);
    byKind.set(parsed.data.type, list);
  }

  // Daily caps: count first (single UPSERT per kind), drop the whole kind
  // when over. Always 200 — clients must never retry dropped events.
  const day = today();
  const allowed: IngestEvent[] = [];
  for (const [kind, events] of byKind) {
    const count = await db.bumpIngestDaily(c.env.DB, project.id, day, kind, events.length);
    if (count > (DAILY_CAPS[kind] ?? 0)) dropped += events.length;
    else allowed.push(...events);
  }

  for (const ev of allowed) {
    if (ev.type === 'feedback') {
      const metadata =
        ev.metadata && JSON.stringify(ev.metadata).length <= 2048
          ? JSON.stringify(ev.metadata)
          : null;
      await db.insertFeedback(c.env.DB, {
        id: ev.id.toLowerCase(),
        projectId: project.id,
        kind: ev.kind,
        message: ev.message,
        pageUrl: ev.page_url ?? null,
        viewport: ev.viewport ?? null,
        ua: ev.ua ?? null,
        tz: ev.tz ?? null,
        metadata,
        breadcrumbs: ev.breadcrumbs ? JSON.stringify(ev.breadcrumbs) : null,
        release: envd.release,
      });
      accepted++; // duplicate retry = idempotent success
    } else if (ev.type === 'error') {
      const fp = await fingerprint(ev.message, ev.stack);
      const gid = await groupIdFor(project.id, fp);
      await db.ingestError(c.env.DB, {
        id: ev.id.toLowerCase(),
        projectId: project.id,
        groupId: gid,
        fingerprint: fp,
        title: normalizeMessage(ev.message) || '(no message)',
        message: ev.message,
        stack: ev.stack ?? null,
        pageUrl: ev.page_url ?? null,
        ua: ev.ua ?? null,
        release: envd.release,
        breadcrumbs: ev.breadcrumbs ? JSON.stringify(ev.breadcrumbs) : null,
      });
      c.executionCtx.waitUntil(db.pruneErrorSamples(c.env.DB, gid));
      accepted++;
    } else if (ev.type === 'vital') {
      await db.upsertVital(c.env.DB, {
        projectId: project.id,
        day,
        path: normalizePath(ev.path),
        metric: ev.metric,
        value: ev.value,
        bucket: bucketVital(ev.metric, ev.value),
      });
      accepted++;
    } else {
      await db.bumpPageview(c.env.DB, project.id, day, normalizePath(ev.path));
      accepted++;
    }
  }

  return c.json({ accepted, dropped });
});

// The widget's "your submissions" view: capability-by-UUID — you can only
// ask about ids you already hold.
ingest.get('/submissions', async (c) => {
  const key = c.req.query('key') ?? '';
  const ids = (c.req.query('ids') ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => UUID_RE.test(s))
    .slice(0, 20);
  const project = await db.projectByKey(c.env.DB, key);
  if (!project) return c.json({ error: 'unknown project key' }, 403);
  return c.json({ items: await db.feedbackStatuses(c.env.DB, project.id, ids) });
});
