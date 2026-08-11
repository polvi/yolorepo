// The hidden sheet. Everything renders inside a closed shadow root on a
// max-z-index fixed host, so host-page CSS can't touch it and vice versa.
// Bottom sheet on phones, centered card from 640px up; light/dark via
// prefers-color-scheme.

import { crumbs } from './breadcrumbs';
import { currentMetadata, submitNow, type WidgetConfig } from './capture';
import { outboxIds, rememberSubmission, storedSubmissions, type StoredSub } from './store';

let host: HTMLElement | null = null;
let shadow: ShadowRoot | null = null;
let cfg: WidgetConfig;

const CSS = `
* { box-sizing: border-box; margin: 0; }
.scrim { position: fixed; inset: 0; background: rgba(0,0,0,.45); }
.sheet {
  --bg: #ffffff; --text: #16181d; --muted: #6b7280; --line: #e5e7eb;
  --field: #f3f4f6; --accent: #f2622e; --accent-text: #ffffff; --ok: #16a34a;
  position: fixed; left: 0; right: 0; bottom: 0;
  background: var(--bg); color: var(--text);
  border-radius: 16px 16px 0 0; padding: 18px 16px calc(18px + env(safe-area-inset-bottom));
  max-height: 85vh; overflow-y: auto;
  font: 15px/1.45 system-ui, -apple-system, sans-serif;
  box-shadow: 0 -8px 40px rgba(0,0,0,.35);
}
@media (prefers-color-scheme: dark) {
  .sheet {
    --bg: #1b1e25; --text: #e8eaee; --muted: #9aa1ac; --line: #2c313b;
    --field: #262b34; --accent: #f2622e;
  }
}
@media (min-width: 640px) {
  .sheet { left: 50%; right: auto; bottom: 50%; transform: translate(-50%, 50%);
           width: 400px; border-radius: 16px; }
}
.head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
.head strong { font-size: 16px; }
.x { border: 0; background: none; color: var(--muted); font-size: 22px; cursor: pointer; padding: 2px 6px; }
.seg { display: flex; gap: 4px; background: var(--field); border-radius: 10px; padding: 4px; margin-bottom: 12px; }
.seg button { flex: 1; border: 0; background: none; color: var(--muted); padding: 8px 0;
              border-radius: 7px; font: inherit; font-weight: 600; cursor: pointer; }
.seg button.on { background: var(--accent); color: var(--accent-text); }
textarea { width: 100%; min-height: 100px; resize: vertical; border: 1px solid var(--line);
           border-radius: 10px; background: var(--field); color: var(--text);
           font: inherit; padding: 10px 12px; margin-bottom: 8px; }
textarea:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
.ctx { color: var(--muted); font-size: 12.5px; margin-bottom: 12px; }
.send { width: 100%; border: 0; border-radius: 10px; background: var(--accent);
        color: var(--accent-text); font: inherit; font-weight: 700; padding: 12px; cursor: pointer; }
.send:disabled { opacity: .6; }
.err { color: #dc2626; font-size: 13px; margin-top: 8px; }
.link { border: 0; background: none; color: var(--muted); font: inherit; font-size: 13px;
        cursor: pointer; text-decoration: underline; margin-top: 12px; display: block;
        margin-left: auto; margin-right: auto; }
.big { text-align: center; padding: 18px 0 6px; font-size: 17px; font-weight: 700; }
.big .ok { color: var(--ok); }
.sub { border-bottom: 1px solid var(--line); padding: 10px 0; }
.sub:last-child { border-bottom: 0; }
.sub .msg { margin-bottom: 3px; }
.sub .meta { color: var(--muted); font-size: 12.5px; }
.chip { display: inline-block; border-radius: 20px; padding: 1px 9px; font-size: 12px;
        font-weight: 600; background: var(--field); color: var(--muted); }
.chip.done { background: rgba(22,163,74,.15); color: var(--ok); }
.chip.planned { background: rgba(242,98,46,.15); color: var(--accent); }
.note { background: var(--field); border-radius: 8px; padding: 7px 10px; font-size: 13px;
        margin-top: 5px; }
.hidden { display: none; }
`;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// The shadow root is closed, so keydown events escaping the sheet retarget
// to the bare host div and look like they came from a non-editable element.
// Trigger code must check this before treating a keystroke as a hotkey.
export function isSheetOpen(): boolean {
  return host !== null;
}

export function openSheet(config: WidgetConfig): void {
  try {
    cfg = config;
    if (!host) {
      host = document.createElement('div');
      host.style.cssText = 'all:initial; position:fixed; z-index:2147483647;';
      shadow = host.attachShadow({ mode: 'closed' });
      document.documentElement.appendChild(host);
    }
    renderForm();
  } catch {
    // never break the host page
  }
}

function closeSheet(): void {
  host?.remove();
  host = null;
  shadow = null;
}

function shell(inner: string): void {
  if (!shadow) return;
  shadow.innerHTML = `<style>${CSS}</style><div class="scrim"></div><div class="sheet" role="dialog">${inner}</div>`;
  shadow.querySelector('.scrim')?.addEventListener('click', closeSheet);
  shadow.querySelector('.x')?.addEventListener('click', closeSheet);
  shadow.querySelector('.sheet')?.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Escape') closeSheet();
  });
}

function renderForm(): void {
  const subs = storedSubmissions(cfg.key);
  shell(`
    <div class="head"><strong>Feedback</strong><button class="x" aria-label="Close">&times;</button></div>
    <div class="seg">
      <button data-k="bug">Bug</button>
      <button data-k="idea">Idea</button>
      <button data-k="feedback" class="on">Feedback</button>
    </div>
    <textarea placeholder="What's on your mind?" maxlength="5000"></textarea>
    <div class="ctx">Sends your note plus the page URL and browser info. Nothing else.</div>
    <button class="send">Send</button>
    <div class="err hidden">Couldn&#39;t send &mdash; please try again.</div>
    ${subs.length ? `<button class="link subs">Your submissions (${subs.length})</button>` : ''}
  `);
  if (!shadow) return;

  let kind = 'feedback';
  for (const b of shadow.querySelectorAll<HTMLButtonElement>('.seg button')) {
    b.addEventListener('click', () => {
      shadow!.querySelector('.seg .on')?.classList.remove('on');
      b.classList.add('on');
      kind = b.dataset.k!;
    });
  }

  const textarea = shadow.querySelector('textarea')!;
  textarea.focus();
  shadow.querySelector('.subs')?.addEventListener('click', () => void renderList());

  const send = shadow.querySelector<HTMLButtonElement>('.send')!;
  send.addEventListener('click', async () => {
    const message = textarea.value.trim();
    if (!message) {
      textarea.focus();
      return;
    }
    send.disabled = true;
    send.textContent = 'Sending…';
    const id = crypto.randomUUID();
    const outcome = await submitNow({
      type: 'feedback',
      id,
      kind,
      message,
      page_url: location.href.slice(0, 1000),
      viewport: `${innerWidth}x${innerHeight}`,
      ua: navigator.userAgent.slice(0, 500),
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      ...(currentMetadata() ? { metadata: currentMetadata() } : {}),
      breadcrumbs: crumbs(),
    });
    if (outcome === 'rejected') {
      send.disabled = false;
      send.textContent = 'Send';
      shadow!.querySelector('.err')?.classList.remove('hidden');
      return;
    }
    rememberSubmission(cfg.key, { id, t: Date.now(), kind, msg: message.slice(0, 120) });
    renderSent(outcome === 'queued');
  });
}

function renderSent(queued: boolean): void {
  const headline = queued
    ? `<div class="big"><span class="ok">&#10003;</span> Saved &mdash; you&#39;re offline</div>
       <div class="ctx" style="text-align:center">It will send itself the moment you&#39;re back online.</div>`
    : `<div class="big"><span class="ok">&#10003;</span> Sent &mdash; thank you</div>
       <div class="ctx" style="text-align:center">Check back here later: you&#39;ll see when it ships.</div>`;
  shell(`
    <div class="head"><strong>Feedback</strong><button class="x" aria-label="Close">&times;</button></div>
    ${headline}
    <button class="link subs">Your submissions</button>
  `);
  shadow?.querySelector('.subs')?.addEventListener('click', () => void renderList());
}

const CHIP: Record<string, string> = {
  new: 'received',
  seen: 'seen',
  planned: 'planned',
  done: 'shipped &#10003;',
  declined: 'declined',
};

async function renderList(): Promise<void> {
  const subs = storedSubmissions(cfg.key);
  let statuses = new Map<string, { status: string; resolution_note: string | null }>();
  try {
    const res = await fetch(
      `${cfg.apiOrigin}/api/submissions?key=${encodeURIComponent(cfg.key)}&ids=${subs
        .slice(0, 20)
        .map((s) => s.id)
        .join(',')}`
    );
    if (res.ok) {
      const { items } = (await res.json()) as {
        items: { id: string; status: string; resolution_note: string | null }[];
      };
      statuses = new Map(items.map((i) => [i.id, i]));
    }
  } catch {
    // offline: show local list without statuses
  }

  const queued = outboxIds(cfg.key);
  const row = (s: StoredSub) => {
    const st = statuses.get(s.id);
    const chip = st ? (CHIP[st.status] ?? st.status) : queued.has(s.id) ? 'queued offline' : 'sent';
    return `
      <div class="sub">
        <div class="msg">${esc(s.msg)}</div>
        <div class="meta">${esc(s.kind)} &middot; ${new Date(s.t).toLocaleDateString()}
          &nbsp;<span class="chip ${st?.status ?? ''}">${chip}</span></div>
        ${st?.resolution_note ? `<div class="note">${esc(st.resolution_note)}</div>` : ''}
      </div>`;
  };

  shell(`
    <div class="head"><strong>Your submissions</strong><button class="x" aria-label="Close">&times;</button></div>
    ${subs.length ? subs.map(row).join('') : '<div class="ctx">Nothing yet.</div>'}
    <button class="link back">Write another</button>
  `);
  shadow?.querySelector('.back')?.addEventListener('click', renderForm);
}
