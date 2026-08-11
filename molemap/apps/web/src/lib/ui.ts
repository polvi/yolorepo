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

export function fmtScore(score: number | null): string {
  return score === null ? '—' : `Δ ${score.toFixed(3)}`;
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
      <a class="wordmark" href="#/">molemap<span class="dot">.</span></a>
      ${link('#/viewer', 'Viewer')}
      ${link('#/visits', 'Visits')}
      ${link('#/moles', 'Moles')}
      ${link('#/settings', 'Settings')}
    </nav>`;
}
