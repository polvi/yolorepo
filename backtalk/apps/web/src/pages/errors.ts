import { api } from '../lib/api';
import { esc, fmtAgo, projectnav, topnav } from '../lib/ui';

const FILTERS = ['open', 'regressed', 'resolved', 'all'];

export async function renderErrors(
  app: HTMLElement,
  projectId: string,
  filter = 'all'
): Promise<void> {
  document.title = 'backtalk — errors';
  const { groups } = await api.errors(projectId, filter === 'all' ? undefined : filter);

  const chips = FILTERS.map(
    (f) => `<button class="chip ${f === filter ? 'on' : ''}" data-filter="${f}">${f}</button>`
  ).join('');

  const rows = groups
    .map(
      (g) => `
      <a class="card" style="display:block; color:inherit;" href="#/p/${projectId}/errors/${g.id}">
        <div class="row">
          <strong class="grow mono" style="font-size:13.5px; overflow-wrap:anywhere;">${esc(g.title)}</strong>
          <span class="badge ${g.status}">${g.status}</span>
        </div>
        <div class="muted" style="font-size:12.5px; margin-top:5px;">
          ${g.event_count}&times; &middot; last ${fmtAgo(g.last_seen)}
          ${g.first_release ? ` &middot; ${esc(g.first_release)}${g.last_release && g.last_release !== g.first_release ? ` &rarr; ${esc(g.last_release)}` : ''}` : ''}
        </div>
      </a>`
    )
    .join('');

  app.innerHTML = `
    ${topnav('#/')}
    <h1>Errors</h1>
    ${projectnav(projectId, '/errors')}
    <div class="chips">${chips}</div>
    <div id="error-box" class="error hidden"></div>
    ${rows || `<p class="muted">No ${filter === 'all' ? '' : `${filter} `}error groups. Quiet is good.</p>`}`;

  for (const chip of app.querySelectorAll<HTMLButtonElement>('[data-filter]')) {
    chip.addEventListener('click', () => renderErrors(app, projectId, chip.dataset.filter!));
  }
}
