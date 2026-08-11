import { Hono } from 'hono';
import type { AppContext } from './env';
import { requireUserOrToken, resolveTokenUser } from './auth';
import * as db from './db';
import { ingest } from './ingest';
import { tokens } from './tokens';
import { projects } from './projects';
import { feedback } from './feedback';
import { errors } from './errors';
import { handleMcp, PROTOCOL_VERSION } from './mcp';
import { llmsTxt } from './llms';

const app = new Hono<AppContext>();

app.get('/llms.txt', (c) => {
  const host = c.req.header('host') ?? new URL(c.req.url).host;
  return c.text(llmsTxt(host));
});

// MCP: bt_ bearer only (DEV_USER_ID as the local-dev escape hatch, same as
// cookie auth). The 401 carries a human hint because the first thing an
// agent does with a failing server is read the error.
app.post('/mcp', async (c) => {
  const bearer = c.req.header('authorization')?.match(/^Bearer\s+(bt_\S+)$/i);
  const userId = bearer
    ? await resolveTokenUser(bearer[1]!, c.env.DB, (p) => c.executionCtx.waitUntil(p))
    : (c.env.DEV_USER_ID ?? null);
  if (!userId) {
    const host = c.req.header('host') ?? new URL(c.req.url).host;
    return c.json(
      {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32001,
          message: `authentication required — mint an API token at https://${host}/#/settings and send it as "Authorization: Bearer bt_..."`,
        },
      },
      401
    );
  }
  return handleMcp(c.env.DB, c.req.raw, userId);
});

app.get('/mcp', (c) =>
  c.json(
    {
      name: 'backtalk',
      protocol: PROTOCOL_VERSION,
      hint: 'POST JSON-RPC 2.0 here with Authorization: Bearer bt_... (see /llms.txt)',
    },
    405
  )
);

const api = new Hono<AppContext>();

// Public routes first (widget ingest + submitter status view, CORS *), then
// cookie-only token management, THEN the auth wall for everything else.
api.route('/', ingest);
api.route('/tokens', tokens);
api.use('*', requireUserOrToken);

api.get('/me', async (c) => {
  const userId = c.get('userId');
  await db.upsertUser(c.env.DB, userId);
  return c.json({ user_id: userId });
});

api.route('/projects', projects);
api.route('/feedback', feedback);
api.route('/errors', errors);

app.route('/api', api);

// Anything else falls through to the static assets (SPA + /w.js).
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
