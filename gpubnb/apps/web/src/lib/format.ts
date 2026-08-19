import { piconeroToXmr } from './moneroUri';

export function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// Price per 1M tokens: listings store piconero per 1,000,000 tokens.
export function fmtXmr(piconero: number | bigint, maxDp = 6): string {
  const p = typeof piconero === 'bigint' ? piconero : BigInt(Math.round(piconero));
  const s = piconeroToXmr(p);
  const [w, f = ''] = s.split('.');
  if (!f) return `${w} XMR`;
  const trimmed = f.slice(0, maxDp).replace(/0+$/, '');
  if (!trimmed && w === '0') return `<${'0.' + '0'.repeat(maxDp - 1) + '1'} XMR`;
  return `${w}${trimmed ? `.${trimmed}` : ''} XMR`;
}

// piconero → USD at micro-USD-per-XMR. Display only.
export function fmtUsd(piconero: number, usdPerXmrMicro: number | null): string {
  if (!usdPerXmrMicro) return '';
  const usd = (piconero / 1e12) * (usdPerXmrMicro / 1e6);
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return usd.toLocaleString(undefined, { style: 'currency', currency: 'USD' });
}

export function ago(ts: number | null | undefined): string {
  if (!ts) return 'never';
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function fmtUptime(s: number): string {
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86400).toFixed(1)}d`;
}

export function fmtInt(n: number): string {
  return n.toLocaleString();
}

export function shortHex(h: string | null | undefined, n = 8): string {
  if (!h) return '—';
  return h.length > n * 2 ? `${h.slice(0, n)}…${h.slice(-n)}` : h;
}

// execCommand is synchronous, permission-free, and the path iOS Safari
// actually honours. navigator.clipboard rides along fire-and-forget.
export function copyText(value: string): boolean {
  const scratch = document.createElement('textarea');
  scratch.value = value;
  scratch.setAttribute('readonly', '');
  scratch.style.cssText = 'position:fixed; top:0; left:0; opacity:0;';
  document.body.appendChild(scratch);
  scratch.select();
  scratch.setSelectionRange(0, value.length);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  scratch.remove();
  void navigator.clipboard?.writeText(value).catch(() => {});
  return ok;
}

export const STATUS_LABEL: Record<string, string> = {
  verified: 'verified',
  simulated: 'simulated',
  stale: 'stale',
  failed: 'failed',
  offline: 'offline',
};

export function badge(status: string, extraClass = ''): string {
  return `<span class="badge badge-${esc(status)} ${extraClass}">${esc(STATUS_LABEL[status] ?? status)}</span>`;
}
