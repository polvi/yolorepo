import { Hono } from 'hono';
import { requireUserOrToken } from './auth';
import type { AppContext } from './env';
import { hostApi, hostListings } from './listings';
import { llmsTxt } from './llms';
import { publicApi } from './public';
import { tokens } from './tokens';

const app = new Hono<AppContext>();

app.get('/llms.txt', (c) => {
  const host = c.req.header('host') ?? new URL(c.req.url).host;
  return c.text(llmsTxt(host));
});

const api = new Hono<AppContext>();

// Public reads first: no auth of any kind, CORS open so @gpubnb/client can
// read the directory from anywhere (browser or bun).
api.use('*', async (c, next) => {
  c.header('access-control-allow-origin', '*');
  if (c.req.method === 'OPTIONS') {
    c.header('access-control-allow-methods', 'GET, POST, PUT, DELETE, OPTIONS');
    c.header('access-control-allow-headers', 'authorization, content-type');
    c.header('access-control-max-age', '86400');
    return c.body(null, 204);
  }
  await next();
});
api.route('/', publicApi);

// Mounted before the bearer-capable middleware: tokens.ts carries its own
// cookie-only guard, so gb_ tokens can never manage tokens.
api.route('/tokens', tokens);

const host = new Hono<AppContext>();
host.use('*', requireUserOrToken);
host.route('/listings', hostListings);
host.route('/host', hostApi);
api.route('/', host);

app.route('/api', api);

// Anything else falls through to the static assets (SPA).
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
