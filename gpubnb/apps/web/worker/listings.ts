// Host-authenticated listing routes (cookie session or gb_ token). Mounted
// under /api after requireUserOrToken; the public reads live in public.ts.
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppContext } from './env';
import * as db from './db';
import { judgeAttestation } from './attest';
import { heartbeatHandler } from './heartbeat';
import { publicListing } from './serialize';
import { listingUpsertSchema, signedBlobSchema, slugSchema } from './trust';

export const hostListings = new Hono<AppContext>();
// Dashboard-only reads under /api/host so they never collide with the public
// GET /api/listings/:id.
export const hostApi = new Hono<AppContext>();

const hostProfileSchema = z.object({
  display_name: z.string().trim().max(60).optional(),
  contact: z.string().trim().max(200).optional(),
});

hostApi.get('/me', async (c) => {
  const userId = c.get('userId');
  await db.upsertHost(c.env.DB, userId);
  const host = await db.getHost(c.env.DB, userId);
  return c.json({ user_id: userId, display_name: host?.display_name ?? '', contact: host?.contact ?? '' });
});

hostApi.put('/me', async (c) => {
  const parsed = hostProfileSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'invalid' }, 400);
  await db.updateHost(c.env.DB, c.get('userId'), parsed.data);
  return c.json({ ok: true });
});

// The host's own listings with full (non-public) state: pending challenge
// age, verdict, heartbeat. Still no secrets; the host can see what renters see
// plus why.
hostApi.get('/listings', async (c) => {
  const rows = await db.listListingsForHost(c.env.DB, c.get('userId'));
  const stats = await db.latestHeartbeats(
    c.env.DB,
    rows.map((r) => r.id)
  );
  const now = Date.now();
  return c.json({
    listings: rows.map((r) => ({
      ...publicListing(r, stats.get(r.id) ?? null, now),
      challenge_pending: r.challenge !== null,
      challenge_issued_at: r.challenge_issued_at,
      stored_status: r.trust_status,
    })),
  });
});

// PUT /api/listings/:slug — upsert by (host, slug). Returns { id }.
hostListings.put('/:slug', async (c) => {
  const slug = slugSchema.safeParse(c.req.param('slug'));
  if (!slug.success) return c.json({ error: slug.error.issues[0]?.message ?? 'bad slug' }, 400);
  const parsed = listingUpsertSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return c.json({ error: `${issue?.path.join('.') ?? ''}: ${issue?.message ?? 'invalid'}`.trim() }, 400);
  }
  const userId = c.get('userId');
  await db.upsertHost(c.env.DB, userId);
  const { id, created } = await db.upsertListing(c.env.DB, userId, slug.data, parsed.data);
  return c.json({ id }, created ? 201 : 200);
});

hostListings.delete('/:id', async (c) => {
  const ok = await db.deleteListing(c.env.DB, c.req.param('id'), c.get('userId'));
  return ok ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404);
});

// POST /api/listings/:id/attest — body is the signed attestation doc.
hostListings.post('/:id/attest', async (c) => {
  const listing = await db.getListingForHost(c.env.DB, c.req.param('id'), c.get('userId'));
  if (!listing) return c.json({ error: 'not found' }, 404);
  const parsed = signedBlobSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'body must be a signed blob {payload, sig, kid?}' }, 400);

  let result;
  try {
    result = await judgeAttestation(listing, parsed.data, Date.now());
  } catch (err) {
    console.error('attest: verifier threw', err);
    return c.json({ error: 'verifier error' }, 502);
  }
  await db.recordAttestation(c.env.DB, listing.id, result);
  return c.json({ status: result.status, trust_status: result.trust, checks: result.checks });
});

hostListings.post('/:id/heartbeat', heartbeatHandler);
