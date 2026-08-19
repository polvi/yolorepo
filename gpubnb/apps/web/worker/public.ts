// Unauthenticated reads + the dispute drop box. Renters never sign in, so
// everything here is shaped for anonymous clients and for @gpubnb/client.
import { Hono } from 'hono';
import type { AppContext } from './env';
import * as db from './db';
import { goldenBlob, modelsBlob } from './golden';
import { usdPerXmrMicro } from './rates';
import { publicListing } from './serialize';
import { DISPUTES_PER_LISTING_PER_DAY, disputeSchema, type TrustStatus } from './trust';

export const publicApi = new Hono<AppContext>();

const STATUSES: TrustStatus[] = ['verified', 'simulated', 'stale', 'failed', 'offline'];

publicApi.get('/listings', async (c) => {
  const q = c.req.query();
  const includeSimulated = q.simulated === '1' || q.simulated === 'true';
  const status = STATUSES.includes(q.status as TrustStatus) ? (q.status as TrustStatus) : null;
  const rows = await db.listPublicListings(c.env.DB, {
    includeSimulated,
    ...(q.gpu ? { gpu: q.gpu.slice(0, 80) } : {}),
    ...(q.model ? { model: q.model.slice(0, 120) } : {}),
  });
  const ids = rows.map((r) => r.id);
  const [stats, disputes] = await Promise.all([
    db.latestHeartbeats(c.env.DB, ids),
    db.countDisputes(c.env.DB, ids),
  ]);
  const now = Date.now();
  let listings = rows.map((r) =>
    publicListing(r, stats.get(r.id) ?? null, now, { disputes: disputes.get(r.id) ?? 0 })
  );
  if (status) listings = listings.filter((l) => l.trust_status === status);
  c.header('cache-control', 'public, max-age=30');
  return c.json({ listings });
});

publicApi.get('/listings/:id', async (c) => {
  const row = await db.getListing(c.env.DB, c.req.param('id'));
  if (!row) return c.json({ error: 'not found' }, 404);
  const [stats, disputes] = await Promise.all([
    db.latestHeartbeat(c.env.DB, row.id),
    db.countDisputes(c.env.DB, [row.id]),
  ]);
  c.header('cache-control', 'public, max-age=15');
  return c.json(publicListing(row, stats, Date.now(), { disputes: disputes.get(row.id) ?? 0 }));
});

publicApi.get('/listings/:id/attestations', async (c) => {
  const row = await db.getListing(c.env.DB, c.req.param('id'));
  if (!row) return c.json({ error: 'not found' }, 404);
  const history = await db.listAttestations(c.env.DB, row.id);
  return c.json({
    attestations: history.map((a) => ({
      id: a.id,
      received_at: a.received_at,
      status: a.status,
      checks: JSON.parse(a.checks) as unknown,
    })),
  });
});

const blobHeaders = {
  'content-type': 'application/json',
  'cache-control': 'public, max-age=3600',
};

publicApi.get('/golden', (c) => c.body(JSON.stringify(goldenBlob), 200, blobHeaders));
publicApi.get('/models', (c) => c.body(JSON.stringify(modelsBlob), 200, blobHeaders));

publicApi.get('/rate/xmr', async (c) => {
  try {
    return c.json({ usd_per_xmr_micro: await usdPerXmrMicro(c.env.DB) });
  } catch {
    return c.json({ error: 'rate unavailable' }, 503);
  }
});

// Reputation drop box: a renter who paid against a runner-signed offer and
// got nothing can file the offer + tx proof. Stored as-is; nothing is
// adjudicated automatically. Size caps and a per-listing daily cap are the
// only anti-junk measures.
publicApi.post('/disputes', async (c) => {
  const len = Number(c.req.header('content-length') ?? 0);
  if (len > 16_384) return c.json({ error: 'too large' }, 413);
  const parsed = disputeSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return c.json({ error: `${issue?.path.join('.') ?? ''}: ${issue?.message ?? 'invalid'}`.trim() }, 400);
  }
  const listing = await db.getListing(c.env.DB, parsed.data.listing_id);
  if (!listing) return c.json({ error: 'unknown listing' }, 404);
  const recent = await db.countRecentDisputes(c.env.DB, listing.id, Date.now() - 24 * 3600 * 1000);
  if (recent >= DISPUTES_PER_LISTING_PER_DAY) return c.json({ error: 'too many disputes today' }, 429);
  const id = await db.insertDispute(c.env.DB, {
    listing_id: listing.id,
    offer: JSON.stringify(parsed.data.offer),
    tx_proof: parsed.data.tx_proof,
    note: parsed.data.note,
  });
  return c.json({ id }, 201);
});
