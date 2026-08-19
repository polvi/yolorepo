import { Hono } from 'hono';
import { z } from 'zod';
import type { AppContext } from './env';
import * as db from './db';
import { generateApiToken, requireCookieUser, sha256Hex } from './auth';

const mintSchema = z.object({ name: z.string().trim().max(80).optional() });

export const tokens = new Hono<AppContext>();

// Cookie-only on every route: a stolen gb_ token must not mint tokens.
tokens.use('*', requireCookieUser);

tokens.get('/', async (c) => {
  return c.json({ tokens: await db.listTokens(c.env.DB, c.get('userId')) });
});

tokens.post('/', async (c) => {
  const parsed = mintSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: 'invalid' }, 400);
  const userId = c.get('userId');
  await db.upsertUser(c.env.DB, userId);
  // Plaintext appears in this response only; we store just the hash.
  const token = generateApiToken();
  const tokenHash = await sha256Hex(token);
  const name = parsed.data.name ?? '';
  await db.insertToken(c.env.DB, { tokenHash, userId, name });
  return c.json({ token, token_hash: tokenHash, name }, 201);
});

tokens.delete('/:hash', async (c) => {
  const ok = await db.deleteToken(c.env.DB, c.get('userId'), c.req.param('hash'));
  return ok ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404);
});
