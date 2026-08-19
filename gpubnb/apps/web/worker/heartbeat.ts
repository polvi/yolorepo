import type { Context } from 'hono';
import type { AppContext } from './env';
import * as db from './db';
import { challengeDecision, heartbeatSchema, randomChallengeHex } from './trust';

// POST /api/listings/:id/heartbeat (gb_). Records liveness + aggregate stats
// and decides whether the runner owes a fresh attestation: a challenge in
// the response means "re-attest with this within 10 minutes or go stale".
export async function heartbeatHandler(c: Context<AppContext>) {
  const listing = await db.getListingForHost(c.env.DB, c.req.param('id') ?? '', c.get('userId'));
  if (!listing) return c.json({ error: 'not found' }, 404);
  const parsed = heartbeatSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'invalid' }, 400);

  const now = Date.now();
  const decision = challengeDecision(listing, now, randomChallengeHex);
  await db.recordHeartbeat(
    c.env.DB,
    listing.id,
    parsed.data,
    decision.issue && decision.challenge ? { value: decision.challenge, issuedAt: now } : null
  );
  return c.json({ ok: true, ...(decision.challenge ? { challenge: decision.challenge } : {}) });
}
