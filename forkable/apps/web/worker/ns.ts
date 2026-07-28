import { Hono } from 'hono';
import { HDR_OWNER, HDR_USER, forkRefFor } from '@forkable/shared';
import type { AppContext } from './env';
import { resolveUser } from './auth';
import { REPO_BASE, getSite, repoStub } from './sites';
import { tpxClient } from './tpx';

// Routes under /__forkable__/ on every site origin. Mounted before any auth:
// git upload-pack and the widget must work anonymously.
export const ns = new Hono<AppContext>();

// Built client assets (vite: dist/{widget.js,sw.js,panel/,chunks/,assets/}).
// The /__forkable__ prefix is stripped before hitting the assets binding.
async function asset(c: { env: { ASSETS: Fetcher }; req: { raw: Request } }, path: string, extra?: Record<string, string>) {
  const res = await c.env.ASSETS.fetch(new Request(`https://assets.local${path}`, { headers: c.req.raw.headers }));
  if (!extra) return res;
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(extra)) out.headers.set(k, v);
  return out;
}

ns.get('/widget.js', (c) => asset(c, '/widget.js'));
// Service-Worker-Allowed lets a script under /__forkable__/ control scope '/'.
ns.get('/sw.js', (c) => asset(c, '/sw.js', { 'Service-Worker-Allowed': '/' }));
ns.get('/panel/', (c) => asset(c, '/panel/index.html'));
ns.get('/panel.js', (c) => asset(c, '/panel.js'));
ns.get('/callback.js', (c) => asset(c, '/callback.js'));

// TPX: client registration cache + the OAuth callback page (popup).
ns.get('/tpx/client', (c) => tpxClient(c.req.raw, c.env.DB));
ns.get('/tpx/callback', (c) => asset(c, '/callback/index.html'));
ns.get('/chunks/*', (c) => asset(c, new URL(c.req.url).pathname.replace('/__forkable__', '')));
ns.get('/assets/*', (c) => asset(c, new URL(c.req.url).pathname.replace('/__forkable__', '')));

ns.get('/api/me', async (c) => {
  const userId = await resolveUser(c.req.raw, c.env);
  if (!userId) return c.json({ user_id: null }, 401);
  return c.json({ user_id: userId });
});

ns.get('/api/site', async (c) => {
  const site = await getSite(c.env, c.get('siteName'));
  if (!site) return c.json({ error: 'no such site' }, 404);
  const userId = await resolveUser(c.req.raw, c.env);
  let hasFork = false;
  if (userId) {
    const res = await repoStub(c.env, site.repo_id).fetch(`${REPO_BASE}/internal/refs`);
    if (res.ok) {
      const { refs } = (await res.json()) as { refs: Record<string, string> };
      hasFork = forkRefFor(userId) in refs;
    }
  }
  return c.json({ name: site.name, owner: userId === site.owner_user_id, has_fork: hasFork });
});

// Git smart-HTTP proxy to the site's RepoDO. Trusted identity headers are
// built fresh here — inbound values never reach the DO.
ns.all('/git/*', async (c) => {
  const site = await getSite(c.env, c.get('siteName'));
  if (!site) return c.json({ error: 'no such site' }, 404);

  const url = new URL(c.req.url);
  const subpath = url.pathname.split('/git/')[1] ?? '';
  if (!['info/refs', 'git-upload-pack', 'git-receive-pack'].includes(subpath)) {
    return c.json({ error: 'not found' }, 404);
  }

  const userId = await resolveUser(c.req.raw, c.env);
  if (subpath === 'git-receive-pack' && !userId) {
    return c.json({ error: 'sign in to save changes' }, 401);
  }

  const headers = new Headers();
  const ct = c.req.header('content-type');
  if (ct) headers.set('Content-Type', ct);
  if (userId) {
    headers.set(HDR_USER, userId);
    headers.set(HDR_OWNER, userId === site.owner_user_id ? '1' : '0');
  }

  return repoStub(c.env, site.repo_id).fetch(`${REPO_BASE}/${subpath}${url.search}`, {
    method: c.req.method,
    headers,
    body: c.req.raw.body,
  });
});
