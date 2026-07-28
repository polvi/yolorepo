/// <reference lib="webworker" />
import LightningFS from '@isomorphic-git/lightning-fs';
import { mimeFor } from '@forkable/shared';
import { kvGet, MODE_KEY } from '../lib/state';
import { DIR, FS_NAME } from '../lib/repo';

// Fork preview: while the visitor has a draft, every same-origin request
// outside /__forkable__/ is answered from their local checkout. Misses are
// real 404s — deletions in the draft must be visible.

declare const self: ServiceWorkerGlobalScope;

const fs = new LightningFS(FS_NAME);
const pfs = fs.promises;

self.addEventListener('install', () => void self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

async function readCheckout(pathname: string): Promise<Response> {
  let path = decodeURIComponent(pathname).replace(/^\/+/, '');
  if (path === '' || path.endsWith('/')) path += 'index.html';

  let content: Uint8Array | null = null;
  for (const candidate of [path, `${path}/index.html`]) {
    try {
      const stat = await pfs.stat(`${DIR}/${candidate}`);
      if (stat.isFile()) {
        content = (await pfs.readFile(`${DIR}/${candidate}`)) as Uint8Array;
        path = candidate;
        break;
      }
    } catch {
      // keep trying
    }
  }
  if (content === null) {
    return new Response(
      '<!doctype html><meta charset="utf-8"><title>Not in your draft</title>' +
        '<style>body{font-family:Georgia,serif;max-width:38rem;margin:20vh auto 0;padding:0 1.25rem}</style>' +
        '<h1>Not in your draft</h1><p>This page does not exist in your version of the site.</p>',
      { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }

  const headers = new Headers({ 'Content-Type': mimeFor(path), 'Cache-Control': 'no-store' });
  if (mimeFor(path).startsWith('text/html')) {
    // Re-inject the widget: the draft's HTML comes from the checkout, not the
    // worker, so the injection has to happen here.
    let html = new TextDecoder().decode(content);
    if (!html.includes('/__forkable__/widget.js')) {
      const tag = '<script type="module" src="/__forkable__/widget.js"></script>';
      html = html.includes('</body>') ? html.replace('</body>', `${tag}</body>`) : html + tag;
    }
    return new Response(html, { headers });
  }
  return new Response(content as BodyInit, { headers });
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' && event.request.method !== 'HEAD') return;
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/__forkable__')) return;

  event.respondWith(
    (async () => {
      const mode = (await kvGet<string>(MODE_KEY)) ?? 'live';
      if (mode !== 'fork') return fetch(event.request);
      return readCheckout(url.pathname);
    })()
  );
});
