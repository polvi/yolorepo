import { Hono } from 'hono';
import type { AppContext } from './env';
import { requireUserOrToken } from './auth';
import * as db from './db';
import { llmsTxt } from './llms';
import { artifacts } from './artifacts';
import { moles } from './moles';
import { tokens } from './tokens';
import { visits } from './visits';

const app = new Hono<AppContext>();

app.get('/llms.txt', (c) => {
  const host = c.req.header('host') ?? new URL(c.req.url).host;
  return c.text(llmsTxt(host));
});

const api = new Hono<AppContext>();

// Mounted before the bearer-capable middleware: tokens.ts carries its own
// cookie-only guard, so mm_ tokens can never manage tokens.
api.route('/tokens', tokens);

api.use('*', requireUserOrToken);

api.get('/me', async (c) => {
  const userId = c.get('userId');
  await db.upsertUser(c.env.DB, userId);
  return c.json({ user_id: userId });
});

api.route('/visits', visits);
api.route('/moles', moles);
api.route('/artifacts', artifacts);

app.route('/api', api);

// Anything else (deep links refreshed on the SPA, etc.) falls through to the
// static assets.
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
