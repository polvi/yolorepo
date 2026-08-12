import { Hono } from 'hono';
import type { AppContext } from './env';
import { llmsTxt } from './llms';
import { scenes } from './scenes';

const app = new Hono<AppContext>();

app.get('/llms.txt', (c) => {
  const host = c.req.header('host') ?? new URL(c.req.url).host;
  return c.text(llmsTxt(host));
});

app.route('/api/scenes', scenes);

// Anything else (deep links refreshed on the SPA, etc.) falls through to the
// static assets.
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
