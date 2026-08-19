import { copyText } from './lib/format';
import { renderAbout } from './views/about';
import { renderHost } from './views/host';
import { renderLanding } from './views/landing';
import { renderListing } from './views/listing';
import { renderListings } from './views/listings';

const app = document.getElementById('app')!;

// One-shot shell; routes render into <main>. Each view receives the main
// element and returns a cleanup (for timers / streams) that runs on the next
// navigation.
app.innerHTML = `
  <header class="topbar">
    <div class="wrap">
      <a class="wordmark" href="#/"><span class="chip" aria-hidden="true"></span>gpubnb</a>
      <nav class="nav" id="nav">
        <a href="#/listings" data-nav="listings">Listings</a>
        <a href="#/host" data-nav="host">Host</a>
        <a href="#/about" data-nav="about">About</a>
      </nav>
    </div>
  </header>
  <main class="wrap" id="main"></main>
  <footer>
    <div class="wrap">
      <span>gpubnb · attested inference, paid in Monero, verified in your browser</span>
      <span class="grow"></span>
      <a href="/llms.txt">llms.txt</a>
      <a href="https://authgravity.org" rel="noopener">Auth by AuthG</a>
      <a href="https://infinitelogic.org" rel="noopener">an Infinite Logic PBC experiment</a>
    </div>
  </footer>`;

const main = document.getElementById('main')!;

// Tap-to-copy anywhere: addresses, tokens, hashes. Confirms in place.
app.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('[data-copy]') as HTMLElement | null;
  if (!btn) return;
  e.preventDefault();
  const original = btn.textContent;
  btn.textContent = copyText(btn.dataset.copy!) ? 'copied ✓' : 'press and hold to copy';
  setTimeout(() => {
    btn.textContent = original;
  }, 1400);
});

export type Cleanup = () => void;
export type View = (el: HTMLElement, params: Record<string, string>) => Promise<Cleanup | void> | Cleanup | void;

let cleanup: Cleanup | void;

const routes: { re: RegExp; view: View; nav: string | null; keys: string[] }[] = [
  { re: /^\/?$/, view: renderLanding, nav: null, keys: [] },
  { re: /^\/listings\/?$/, view: renderListings, nav: 'listings', keys: [] },
  { re: /^\/l\/([\w-]+)\/?$/, view: renderListing, nav: 'listings', keys: ['id'] },
  { re: /^\/host\/?$/, view: renderHost, nav: 'host', keys: [] },
  { re: /^\/about\/?$/, view: renderAbout, nav: 'about', keys: [] },
];

async function route(): Promise<void> {
  const hash = location.hash.replace(/^#/, '') || '/';
  if (cleanup) {
    try {
      cleanup();
    } catch {}
    cleanup = undefined;
  }
  for (const r of routes) {
    const m = hash.match(r.re);
    if (!m) continue;
    const params: Record<string, string> = {};
    r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1] ?? '')));
    document.querySelectorAll('#nav a').forEach((a) => {
      a.classList.toggle('active', (a as HTMLElement).dataset.nav === r.nav);
    });
    window.scrollTo({ top: 0 });
    try {
      cleanup = await r.view(main, params);
    } catch (err) {
      main.innerHTML = `<div class="error">${(err as Error)?.message ?? 'Something went wrong.'}</div>`;
    }
    return;
  }
  location.hash = '#/';
}

window.addEventListener('hashchange', () => void route());
void route();
