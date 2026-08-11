import { Hono } from 'hono';
import { z } from 'zod';
import type { AppContext } from './env';
import * as db from './db';
import { canTransitionFeedback, noteRequired, type FeedbackStatus } from './lifecycle';

const patchSchema = z.object({
  status: z.enum(['seen', 'planned', 'done', 'declined']),
  note: z.string().trim().min(1).max(2000).optional(),
});

export const feedback = new Hono<AppContext>();

feedback.get('/:id', async (c) => {
  const item = await db.getFeedbackOwned(c.env.DB, c.get('userId'), c.req.param('id'));
  return item ? c.json({ item }) : c.json({ error: 'not found' }, 404);
});

feedback.patch('/:id', async (c) => {
  const parsed = patchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid' }, 400);
  const { status, note } = parsed.data;

  const item = await db.getFeedbackOwned(c.env.DB, c.get('userId'), c.req.param('id'));
  if (!item) return c.json({ error: 'not found' }, 404);
  if (!canTransitionFeedback(item.status, status as FeedbackStatus)) {
    return c.json({ error: `cannot go ${item.status} -> ${status}` }, 400);
  }
  if (noteRequired(status as FeedbackStatus) && !note && !item.resolution_note) {
    return c.json({ error: `a note is required for ${status} — the submitter will see it` }, 400);
  }

  const ok = await db.setFeedbackStatus(c.env.DB, item.id, item.status, status, note ?? null);
  return ok ? c.json({ ok: true }) : c.json({ error: 'status changed concurrently, reload' }, 409);
});
