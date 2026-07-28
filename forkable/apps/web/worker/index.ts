import { Hono } from 'hono';
import { CreateSiteRequest } from '@forkable/shared';
import type { AppContext, Env } from './env';
import { authEndpoint, baseDomain, requestHost, requestHostname, siteNameFromHostname } from './env';
import { requireUser, resolveUser } from './auth';
import { createSite, deleteSite, ensureSeed, getSite, listSites } from './sites';
import { serveSiteFile } from './serve';
import { ns } from './ns';
import { dashboardPage, landingPage } from './dashboard';
import { llmsTxt } from './llms';

// Phase 0 stub; Phase 1 swaps this export for the real git-backed DO in
// worker/git/repo-do.ts.
export { RepoDO } from './repo-do';

// --- Apex: forkable.<base> — landing, dashboard, sites API -----------------

const apex = new Hono<AppContext>();

apex.get('/', async (c) => {
  const userId = await resolveUser(c.req.raw, c.env);
  const proto = new URL(c.req.url).protocol;
  const host = requestHost(c.req.raw);
  if (!userId) {
    const loginUrl = `${authEndpoint(c.env)}/login?return_to=${encodeURIComponent(`${proto}//${host}/`)}`;
    const seed = await ensureSeed(c.env);
    const seedUrl = `${proto}//${seed.name}.${host}/`;
    return c.html(landingPage(loginUrl, seedUrl));
  }
  const sites = await listSites(c.env, userId);
  return c.html(dashboardPage(sites, `Signed in. Sites live at <name>.${host}.`));
});

apex.get('/llms.txt', (c) => {
  const proto = new URL(c.req.url).protocol;
  return c.text(llmsTxt(`${proto}//${requestHost(c.req.raw)}`, baseDomain(c.env)));
});

apex.get('/api/me', async (c) => {
  const userId = await resolveUser(c.req.raw, c.env);
  if (!userId) return c.json({ user_id: null }, 401);
  return c.json({ user_id: userId });
});

apex.use('/api/sites', requireUser);
apex.use('/api/sites/*', requireUser);

apex.post('/api/sites', async (c) => {
  const parsed = CreateSiteRequest.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid request' }, 400);
  const result = await createSite(c.env, c.get('userId'), parsed.data.name);
  if (result.error) return c.json({ error: result.error }, (result.status ?? 500) as never);
  return c.json({ name: result.site!.name }, 201);
});

apex.get('/api/sites', async (c) => {
  const sites = await listSites(c.env, c.get('userId'));
  return c.json({ sites: sites.map((s) => ({ name: s.name, created_at: s.created_at })) });
});

apex.delete('/api/sites/:name', async (c) => {
  const site = await getSite(c.env, c.req.param('name'));
  if (!site) return c.json({ error: 'no such site' }, 404);
  if (site.owner_user_id !== c.get('userId')) return c.json({ error: 'not yours' }, 403);
  await deleteSite(c.env, site);
  return c.json({ ok: true });
});

// --- Site origins: <site>.forkable.<base> ----------------------------------

const site = new Hono<AppContext>();

site.use('*', async (c, next) => {
  const name = siteNameFromHostname(requestHostname(c.req.raw), c.env);
  if (name === null) return c.json({ error: 'bad host' }, 404);
  c.set('siteName', name);
  await next();
});

site.route('/__forkable__', ns);

site.on(['GET', 'HEAD'], '*', (c) => serveSiteFile(c.req.raw, c.env, c.get('siteName')));

site.all('*', (c) => c.json({ error: 'method not allowed' }, 405));

// --- Host dispatch ----------------------------------------------------------

const app = new Hono<AppContext>();

app.all('*', (c) => {
  const name = siteNameFromHostname(requestHostname(c.req.raw), c.env);
  const target = name === null ? apex : site;
  return target.fetch(c.req.raw, c.env, c.executionCtx);
});

export default app;
