import { kvGet, kvSet, MODE_KEY } from '../lib/state';
import { loginUrl } from '../lib/origins';

// The edit affordance injected into every served page. Opens the editor
// panel in an iframe; while a draft exists the page is served from the
// visitor's fork by the service worker.

const NS = '/__forkable__';

async function me(): Promise<string | null> {
  try {
    const res = await fetch(`${NS}/api/me`, { credentials: 'include' });
    if (!res.ok) return null;
    return ((await res.json()) as { user_id: string }).user_id;
  } catch {
    return null;
  }
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  css: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.style.cssText = css;
  if (text) node.textContent = text;
  return node;
}

async function main(): Promise<void> {
  if ((window as { __forkable?: boolean }).__forkable) return;
  (window as { __forkable?: boolean }).__forkable = true;

  const mode = (await kvGet<string>(MODE_KEY)) ?? 'live';

  const button = el(
    'button',
    'position:fixed;right:16px;bottom:16px;z-index:2147483646;' +
      'font:14px system-ui,sans-serif;padding:8px 14px;border-radius:999px;' +
      'border:1px solid rgba(0,0,0,.15);background:#fff;color:#1c1b1a;' +
      'cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.15)',
    mode === 'fork' ? '✎ your draft' : '✎ edit'
  );

  let frame: HTMLIFrameElement | null = null;

  function closePanel(): void {
    frame?.remove();
    frame = null;
    button.style.display = '';
  }

  async function openPanel(): Promise<void> {
    const userId = await me();
    if (!userId) {
      location.href = loginUrl();
      return;
    }
    frame = el(
      'iframe',
      'position:fixed;right:0;top:0;bottom:0;width:min(420px,100vw);' +
        'height:100%;z-index:2147483647;border:0;border-left:1px solid rgba(0,0,0,.1);' +
        'box-shadow:-4px 0 24px rgba(0,0,0,.15);background:#faf8f5'
    );
    frame.src = `${NS}/panel/`;
    document.body.appendChild(frame);
    button.style.display = 'none';
  }

  button.addEventListener('click', openPanel);
  document.body.appendChild(button);

  window.addEventListener('message', async (event) => {
    if (event.origin !== location.origin) return;
    const msg = event.data as { forkable?: string };
    if (msg?.forkable === 'close') closePanel();
    if (msg?.forkable === 'reload') location.reload();
    if (msg?.forkable === 'view-original') {
      await kvSet(MODE_KEY, 'live');
      location.reload();
    }
  });
}

void main();
