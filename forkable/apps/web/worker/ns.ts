import { Hono } from 'hono';
import { HDR_OWNER, HDR_USER, forkRefFor } from '@forkable/shared';
import type { AppContext } from './env';
import { resolveUser } from './auth';
import { REPO_BASE, getSite, repoStub } from './sites';

// Routes under /__forkable__/ on every site origin. Mounted before any auth:
// git upload-pack and the widget must work anonymously.
export const ns = new Hono<AppContext>();

// Phase 0 widget stub; replaced by a built asset in Phase 2.
const WIDGET_STUB = `(() => {
  if (window.__forkableWidget) return;
  window.__forkableWidget = true;
  const btn = document.createElement('button');
  btn.textContent = '✎ edit';
  btn.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;' +
    'font:14px system-ui,sans-serif;padding:8px 14px;border-radius:999px;' +
    'border:1px solid #0002;background:#fff;color:#1c1b1a;cursor:pointer;' +
    'box-shadow:0 2px 8px #0002';
  btn.addEventListener('click', () => {
    btn.textContent = 'editing is coming soon';
    setTimeout(() => (btn.textContent = '✎ edit'), 2000);
  });
  document.body.appendChild(btn);
})();
`;

ns.get('/widget.js', (c) =>
  c.body(WIDGET_STUB, 200, {
    'Content-Type': 'text/javascript; charset=utf-8',
    'Cache-Control': 'public, max-age=60',
  })
);

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
