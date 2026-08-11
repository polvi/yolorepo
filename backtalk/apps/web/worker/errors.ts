import { Hono } from 'hono';
import { z } from 'zod';
import type { AppContext } from './env';
import * as db from './db';
import { canTransitionError, type ErrorStatus } from './lifecycle';

// Humans and agents may resolve or reopen; 'regressed' is reserved for the
// ingest path (a reoccurrence proves the bug is back).
const patchSchema = z.object({
  status: z.enum(['resolved', 'open']),
  note: z.string().trim().min(1).max(2000).optional(),
});

export const errors = new Hono<AppContext>();

errors.get('/:gid', async (c) => {
  const found = await db.getErrorGroupOwned(c.env.DB, c.get('userId'), c.req.param('gid'));
  return found ? c.json(found) : c.json({ error: 'not found' }, 404);
});

errors.patch('/:gid', async (c) => {
  const parsed = patchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid' }, 400);
  const { status, note } = parsed.data;

  const found = await db.getErrorGroupOwned(c.env.DB, c.get('userId'), c.req.param('gid'));
  if (!found) return c.json({ error: 'not found' }, 404);
  if (!canTransitionError(found.group.status, status as ErrorStatus)) {
    return c.json({ error: `cannot go ${found.group.status} -> ${status}` }, 400);
  }

  const ok = await db.setErrorStatus(c.env.DB, found.group.id, found.group.status, status, note ?? null);
  return ok ? c.json({ ok: true }) : c.json({ error: 'status changed concurrently, reload' }, 409);
});
