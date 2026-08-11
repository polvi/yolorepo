import { api } from '../lib/api';
import { crumbsHtml, esc, fmtAgo, fmtDate, projectnav, showError, topnav } from '../lib/ui';

export async function renderErrorGroup(
  app: HTMLElement,
  projectId: string,
  groupId: string
): Promise<void> {
  const { group, samples } = await api.errorGroup(groupId);
  document.title = `backtalk — ${group.title.slice(0, 60)}`;

  const action =
    group.status === 'open' || group.status === 'regressed'
      ? `<button class="btn small" id="resolve">Mark resolved</button>`
      : `<button class="btn ghost small" id="reopen">Reopen</button>`;

  const sampleRows = samples
    .map(
      (s) => `
      <div class="card">
        <div class="muted" style="font-size:12.5px; margin-bottom:6px;">
          ${fmtDate(s.created_at)} &middot; ${fmtAgo(s.created_at)}
          ${s.release ? ` &middot; ${esc(s.release)}` : ''}
          ${s.page_url ? `<br />${esc(s.page_url)}` : ''}
          ${s.ua ? `<br />${esc(s.ua)}` : ''}
        </div>
        ${s.stack ? `<pre class="stack">${esc(s.stack)}</pre>` : `<p class="muted">No stack captured.</p>`}
        ${crumbsHtml(s.breadcrumbs)}
      </div>`
    )
    .join('');

  app.innerHTML = `
    ${topnav('#/')}
    <h1 class="mono" style="font-size:16px; overflow-wrap:anywhere;">${esc(group.title)}</h1>
    ${projectnav(projectId, '/errors')}
    <div id="error-box" class="error hidden"></div>
    <div class="card">
      <div class="row" style="flex-wrap:wrap;">
        <span class="badge ${group.status}">${group.status}</span>
        <span class="muted">${group.event_count} occurrence${group.event_count === 1 ? '' : 's'}</span>
        <span class="muted">first ${fmtDate(group.first_seen)}</span>
        <span class="muted">last ${fmtAgo(group.last_seen)}</span>
        ${group.first_release ? `<span class="muted">releases ${esc(group.first_release)}${group.last_release && group.last_release !== group.first_release ? ` &rarr; ${esc(group.last_release)}` : ''}</span>` : ''}
        <span class="grow"></span>
        ${action}
      </div>
      ${group.status === 'regressed' ? `<p class="muted" style="margin-top:8px;">This was resolved${group.resolved_in_release ? ` in ${esc(group.resolved_in_release)}` : ''} and came back.</p>` : ''}
      ${group.resolution_note ? `<p class="muted" style="margin-top:8px;">Note: ${esc(group.resolution_note)}</p>` : ''}
    </div>
    <h2>Samples <span class="muted">(newest ${samples.length})</span></h2>
    ${sampleRows || '<p class="muted">No sample events retained.</p>'}`;

  document.getElementById('resolve')?.addEventListener('click', async () => {
    const note = prompt('Optional note (kept on the group):') ?? undefined;
    try {
      await api.patchError(groupId, 'resolved', note || undefined);
      await renderErrorGroup(app, projectId, groupId);
    } catch (err) {
      showError(err);
    }
  });

  document.getElementById('reopen')?.addEventListener('click', async () => {
    try {
      await api.patchError(groupId, 'open');
      await renderErrorGroup(app, projectId, groupId);
    } catch (err) {
      showError(err);
    }
  });
}
