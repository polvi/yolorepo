// Veggie Hunt tagging UI, built for weak farm-field connectivity:
// - Menus are bundled (imported straight from the worker's taxonomy), so
//   browsing them costs zero network.
// - A GPS watch keeps a fix warm continuously; tapping a veggie never waits
//   on the radio.
// - Claims carry a client id (cid) and go through a localStorage queue with
//   retry, so lost signal never loses a tag and a lost response never
//   double-scores (server dedupes on cid). Queued flushes are spaced 16s so
//   they clear the server's anti-mash cooldown.
import { GROUPS } from '../worker/veggie-logic';

const app = document.getElementById('app')!;
const qs = new URLSearchParams(location.search);
const html = (s: string) => {
  app.innerHTML = s;
};
const esc = (s: unknown) =>
  String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);

if (!localStorage.getItem('veggie-device')) {
  localStorage.setItem('veggie-device', crypto.randomUUID());
}
const device = localStorage.getItem('veggie-device')!;

// --- warm GPS -------------------------------------------------------------
type Fix = { lat: number; lon: number; at: number };
let lastFix: Fix | null = qs.has('lat')
  ? { lat: Number(qs.get('lat')), lon: Number(qs.get('lon')), at: Infinity }
  : null;
if (!qs.has('lat') && 'geolocation' in navigator) {
  navigator.geolocation.watchPosition(
    (p) => {
      lastFix = { lat: p.coords.latitude, lon: p.coords.longitude, at: Date.now() };
      updateStatus();
    },
    () => {},
    { enableHighAccuracy: true, maximumAge: 0 }
  );
}

const freshFix = async (): Promise<Fix> => {
  if (lastFix && Date.now() - lastFix.at < 20000) return lastFix;
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, at: Date.now() }),
      // A stale fix beats no fix on a farm walk.
      () => (lastFix ? resolve(lastFix) : reject(new Error('no GPS fix yet — step outside?'))),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 }
    );
  });
};

// --- claim queue ----------------------------------------------------------
type QueuedClaim = { cid: string; label: string; lat: number; lon: number };
const QKEY = 'veggie-queue';
const loadQueue = (): QueuedClaim[] => {
  try {
    return JSON.parse(localStorage.getItem(QKEY) ?? '[]') as QueuedClaim[];
  } catch {
    return [];
  }
};
const saveQueue = (q: QueuedClaim[]) => localStorage.setItem(QKEY, JSON.stringify(q));

const postClaim = async (claim: QueuedClaim, timeoutMs: number): Promise<string> => {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch('/api/veggie/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: ctl.signal,
      body: JSON.stringify({
        ...claim,
        device,
        player: localStorage.getItem('veggie-player') || undefined,
      }),
    });
    return await r.text();
  } finally {
    clearTimeout(t);
  }
};

let lastSend = 0;
let flushing = false;
async function flushQueue(): Promise<void> {
  const q = loadQueue();
  if (flushing || !q.length || Date.now() - lastSend < 16000) return;
  flushing = true;
  try {
    const msg = await postClaim(q[0]!, 6000);
    lastSend = Date.now();
    saveQueue(loadQueue().slice(1));
    toast(msg.split('\n')[0] ?? '✅ sent');
  } catch {
    // still offline; try again next tick
  } finally {
    flushing = false;
    updateStatus();
  }
}
setInterval(() => void flushQueue(), 4000);

// --- UI -------------------------------------------------------------------
function updateStatus(): void {
  const el = document.getElementById('status');
  if (!el) return;
  const n = loadQueue().length;
  const gps = lastFix ? '🛰 GPS ok' : '🛰 waiting for GPS…';
  el.textContent = n > 0 ? `${gps} · 📡 ${n} tag${n > 1 ? 's' : ''} waiting for signal` : gps;
}

function toast(msg: string): void {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 4000);
}

function askName(): void {
  const saved = localStorage.getItem('veggie-player') ?? '';
  html(`<input id="name" placeholder="Your name (optional)" value="${esc(saved)}" />
        <button class="btn" id="go">Start hunting 🏃</button>`);
  document.getElementById('go')!.addEventListener('click', () => {
    localStorage.setItem(
      'veggie-player',
      (document.getElementById('name') as HTMLInputElement).value.trim()
    );
    showGroups();
  });
}

function showGroups(): void {
  const who = localStorage.getItem('veggie-player') || 'anonymous';
  html(
    GROUPS.map((g, i) => `<button class="btn" data-i="${i}">${esc(g.label)}</button>`).join('') +
      `<p class="muted" id="status"></p>` +
      `<button class="btn back" id="who">I'm ${esc(who)} — change</button>`
  );
  app.querySelectorAll<HTMLButtonElement>('[data-i]').forEach((b) =>
    b.addEventListener('click', () => showOptions(GROUPS[Number(b.dataset.i)]!))
  );
  document.getElementById('who')!.addEventListener('click', askName);
  updateStatus();
}

function showOptions(group: (typeof GROUPS)[number]): void {
  if (group.options.length === 1) return void claim(group.options[0]!.label);
  html(
    group.options.map((o, i) => `<button class="btn" data-i="${i}">${esc(o.label)}</button>`).join('') +
      '<button class="btn back" id="back">← Back</button>'
  );
  app.querySelectorAll<HTMLButtonElement>('[data-i]').forEach((b) =>
    b.addEventListener('click', () => claim(group.options[Number(b.dataset.i)]!.label))
  );
  document.getElementById('back')!.addEventListener('click', showGroups);
}

async function claim(label: string): Promise<void> {
  html(`<div id="result">📡 Tagging ${esc(label)}…</div>`);
  let fix: Fix;
  try {
    fix = await freshFix();
  } catch (e) {
    html(`<div id="result">🛰 ${esc((e as Error).message)}</div><button class="btn" id="again">Try again</button>`);
    document.getElementById('again')!.addEventListener('click', showGroups);
    return;
  }
  const c: QueuedClaim = { cid: crypto.randomUUID(), label, lat: fix.lat, lon: fix.lon };
  const queueBusy = loadQueue().length > 0;
  let msg: string;
  if (queueBusy) {
    // Keep order: new tags join the line behind unsent ones.
    saveQueue([...loadQueue(), c]);
    msg = `📶 Saved! It'll send when the signal comes back.`;
  } else {
    try {
      msg = await postClaim(c, 5000);
      lastSend = Date.now();
    } catch {
      saveQueue([...loadQueue(), c]);
      msg = `📶 No signal — saved! It'll send by itself. Keep hunting!`;
    }
  }
  html(`<div id="result">${esc(msg)}</div><button class="btn" id="again">Tag another 🥕</button>`);
  document.getElementById('again')!.addEventListener('click', showGroups);
  updateStatus();
}

showGroups();
