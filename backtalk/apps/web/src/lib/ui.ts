import { ApiError } from './api';

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function fmtDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function fmtAgo(ts: number): string {
  const s = Math.max(1, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function showError(err: unknown): void {
  const box = document.getElementById('error-box');
  const message =
    err instanceof ApiError ? err.message : 'Something went wrong, please try again.';
  if (box) {
    box.textContent = message;
    box.classList.remove('hidden');
    box.scrollIntoView({ block: 'nearest' });
  } else {
    alert(message);
  }
}

export function topnav(active: string): string {
  const link = (href: string, label: string) =>
    `<a class="navlink ${active === href ? 'active' : ''}" href="${href}">${label}</a>`;
  return `
    <nav class="topnav">
      <a class="wordmark" href="#/">backtalk<span class="dot">.</span></a>
      ${link('#/', 'Projects')}
      ${link('#/settings', 'Settings')}
    </nav>`;
}

/** Per-project section tabs. */
export function projectnav(projectId: string, active: string): string {
  const link = (seg: string, label: string) =>
    `<a class="chip ${active === seg ? 'on' : ''}" href="#/p/${projectId}${seg}">${label}</a>`;
  return `<div class="chips">
    ${link('', 'Overview')}
    ${link('/feedback', 'Feedback')}
    ${link('/errors', 'Errors')}
    ${link('/stats', 'Stats')}
  </div>`;
}

/** Render a breadcrumbs JSON column as a collapsible trail. */
export function crumbsHtml(breadcrumbs: string | null): string {
  if (!breadcrumbs) return '';
  try {
    const list = JSON.parse(breadcrumbs) as { t: number; type: string; data: string }[];
    if (!list.length) return '';
    const rows = list
      .map(
        (c) => `<div class="crumb"><span class="t">${new Date(c.t)
          .toLocaleTimeString()
          .padEnd(8)}</span><span>${esc(c.type)}</span><span>${esc(c.data)}</span></div>`
      )
      .join('');
    return `<details class="crumbs"><summary>Breadcrumbs (${list.length})</summary>${rows}</details>`;
  } catch {
    return '';
  }
}
