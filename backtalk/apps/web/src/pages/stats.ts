import { api, type VitalsRow } from '../lib/api';
import { esc, projectnav, topnav } from '../lib/ui';

const DAYS = 14;

function dayRange(days: number): string[] {
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    out.push(new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10));
  }
  return out;
}

/** Simple inline-SVG bar chart: one bar per day. */
function barChart(days: string[], values: number[]): string {
  const w = 700;
  const h = 90;
  const max = Math.max(...values, 1);
  const bw = w / days.length;
  const bars = values
    .map((v, i) => {
      const bh = Math.round((v / max) * (h - 18));
      return `<rect x="${(i * bw + 2).toFixed(1)}" y="${h - bh - 14}" width="${(bw - 4).toFixed(1)}" height="${bh}" rx="2" fill="var(--accent)" opacity="${v ? 1 : 0.15}"><title>${days[i]}: ${v}</title></rect>`;
    })
    .join('');
  const labels = [0, days.length - 1]
    .map(
      (i) =>
        `<text x="${(i * bw + bw / 2).toFixed(1)}" y="${h - 2}" font-size="10" fill="var(--muted)" text-anchor="middle">${days[i]!.slice(5)}</text>`
    )
    .join('');
  return `<svg class="bars" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${bars}${labels}</svg>`;
}

const UNITS: Record<string, (v: number) => string> = {
  LCP: (v) => `${(v / 1000).toFixed(2)}s`,
  INP: (v) => `${Math.round(v)}ms`,
  CLS: (v) => v.toFixed(3),
};

function vitalCard(metric: 'LCP' | 'INP' | 'CLS', rows: VitalsRow[]): string {
  const mine = rows.filter((r) => r.metric === metric);
  const count = mine.reduce((n, r) => n + r.count, 0);
  if (!count) {
    return `<div class="stat"><div class="n muted">—</div><div class="muted">${metric} (no samples)</div></div>`;
  }
  const avg = mine.reduce((n, r) => n + r.sum_value, 0) / count;
  const good = mine.reduce((n, r) => n + r.good, 0);
  const needs = mine.reduce((n, r) => n + r.needs, 0);
  const poor = mine.reduce((n, r) => n + r.poor, 0);
  const pct = (n: number) => `${((n / count) * 100).toFixed(1)}%`;
  return `
    <div class="stat">
      <div class="n">${UNITS[metric]!(avg)}</div>
      <div class="muted">${metric} avg &middot; ${count} samples</div>
      <div class="vitalbar">
        <span class="g" style="width:${pct(good)}" title="good ${pct(good)}"></span>
        <span class="n" style="width:${pct(needs)}" title="needs improvement ${pct(needs)}"></span>
        <span class="p" style="width:${pct(poor)}" title="poor ${pct(poor)}"></span>
      </div>
    </div>`;
}

export async function renderStats(app: HTMLElement, projectId: string): Promise<void> {
  document.title = 'backtalk — stats';
  const { vitals, pageviews } = await api.stats(projectId, DAYS);

  const days = dayRange(DAYS);
  const byDay = new Map<string, number>();
  const byPath = new Map<string, number>();
  for (const row of pageviews) {
    byDay.set(row.day, (byDay.get(row.day) ?? 0) + row.count);
    byPath.set(row.path, (byPath.get(row.path) ?? 0) + row.count);
  }
  const total = [...byDay.values()].reduce((a, b) => a + b, 0);

  const topPaths = [...byPath.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(
      ([path, n]) => `
      <div class="row" style="padding:5px 0; border-bottom:1px solid var(--border);">
        <span class="grow mono" style="overflow-wrap:anywhere;">${esc(path)}</span>
        <span class="muted">${n}</span>
      </div>`
    )
    .join('');

  app.innerHTML = `
    ${topnav('#/')}
    <h1>Stats <span class="muted" style="font-size:14px;">last ${DAYS} days</span></h1>
    ${projectnav(projectId, '/stats')}
    <div id="error-box" class="error hidden"></div>

    <h2>Pageviews <span class="muted">(${total})</span></h2>
    <div class="card">${barChart(days, days.map((d) => byDay.get(d) ?? 0))}</div>

    <h2>Web Vitals</h2>
    <div class="statgrid">
      ${vitalCard('LCP', vitals as VitalsRow[])}
      ${vitalCard('INP', vitals as VitalsRow[])}
      ${vitalCard('CLS', vitals as VitalsRow[])}
    </div>

    <h2>Top pages</h2>
    <div class="card">${topPaths || '<p class="muted" style="margin:0;">No pageviews yet.</p>'}</div>`;
}
