import { NS_WIDGET, REF_MAIN, SEED_SITE_NAME, mimeFor } from '@forkable/shared';
import type { Env } from './env';
import { REPO_BASE, ensureSeed, getSite, repoStub } from './sites';

const SITE_404 = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Not found</title>
<style>body{font-family:Georgia,serif;max-width:38rem;margin:20vh auto 0;padding:0 1.25rem;line-height:1.6}</style>
<h1>Nothing here yet</h1>
<p>This page doesn't exist on this site.</p>
`;

export async function serveSiteFile(request: Request, env: Env, siteName: string): Promise<Response> {
  let site = await getSite(env, siteName);
  if (!site && siteName === SEED_SITE_NAME) site = await ensureSeed(env);
  if (!site) {
    return new Response(SITE_404, {
      status: 404,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  const url = new URL(request.url);
  const doUrl = `${REPO_BASE}/internal/file?ref=${encodeURIComponent(REF_MAIN)}&path=${encodeURIComponent(url.pathname)}`;
  const headers: Record<string, string> = {};
  const inm = request.headers.get('if-none-match');
  if (inm) headers['If-None-Match'] = inm;
  const res = await repoStub(env, site.repo_id).fetch(doUrl, { headers });

  if (res.status === 304) {
    return new Response(null, { status: 304, headers: cacheHeaders(res) });
  }
  if (!res.ok) {
    return new Response(SITE_404, {
      status: 404,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  const resolvedPath = res.headers.get('X-Resolved-Path') ?? url.pathname;
  const mime = mimeFor(resolvedPath);
  const out = new Response(res.body, {
    headers: { ...cacheHeaders(res), 'Content-Type': mime },
  });
  if (mime.startsWith('text/html')) return injectWidget(out);
  return out;
}

function cacheHeaders(res: Response): Record<string, string> {
  const h: Record<string, string> = {
    'Cache-Control': 'public, max-age=0, must-revalidate',
  };
  const etag = res.headers.get('ETag');
  if (etag) h['ETag'] = etag;
  return h;
}

function injectWidget(res: Response): Response {
  const tag = `<script src="${NS_WIDGET}" defer></script>`;
  let injected = false;
  return new HTMLRewriter()
    .on('head', {
      element(el) {
        if (!injected) {
          el.append(tag, { html: true });
          injected = true;
        }
      },
    })
    .onDocument({
      end(end) {
        if (!injected) end.append(tag, { html: true });
      },
    })
    .transform(res);
}
