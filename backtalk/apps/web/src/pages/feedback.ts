import { api, type FeedbackStatus } from '../lib/api';
import { crumbsHtml, esc, fmtAgo, projectnav, showError, topnav } from '../lib/ui';

// Mirror of the worker's lifecycle table (worker/lifecycle.ts) so the UI
// offers only legal moves; the server still validates.
const NEXT: Record<FeedbackStatus, FeedbackStatus[]> = {
  new: ['seen', 'planned', 'done', 'declined'],
  seen: ['planned', 'done', 'declined'],
  planned: ['done', 'declined'],
  done: ['planned'],
  declined: ['planned'],
};
const NOTE_NEEDED = new Set(['done', 'declined']);
const FILTERS = ['all', 'new', 'seen', 'planned', 'done', 'declined'];

export async function renderFeedback(
  app: HTMLElement,
  projectId: string,
  filter = 'new'
): Promise<void> {
  document.title = 'backtalk — feedback';
  const { items } = await api.feedback(projectId, filter === 'all' ? undefined : filter);

  const chips = FILTERS.map(
    (f) => `<button class="chip ${f === filter ? 'on' : ''}" data-filter="${f}">${f}</button>`
  ).join('');

  const rows = items
    .map((item) => {
      const actions = NEXT[item.status]
        .map(
          (to) =>
            `<button class="btn ghost small" data-move="${to}" data-id="${item.id}">${to}</button>`
        )
        .join(' ');
      return `
      <div class="card">
        <div class="row" style="margin-bottom:6px;">
          <span class="badge ${item.kind}">${item.kind}</span>
          <span class="badge ${item.status}">${item.status}</span>
          <span class="muted grow" style="text-align:right; font-size:12.5px;">${fmtAgo(item.created_at)}</span>
        </div>
        <p style="white-space:pre-wrap; margin:6px 0;">${esc(item.message)}</p>
        <div class="muted" style="font-size:12.5px; overflow-wrap:anywhere;">
          ${item.page_url ? esc(item.page_url) : ''}
          ${item.viewport ? ` &middot; ${esc(item.viewport)}` : ''}
          ${item.release ? ` &middot; ${esc(item.release)}` : ''}
        </div>
        ${item.resolution_note ? `<div class="muted" style="margin-top:6px;">Note to submitter: &ldquo;${esc(item.resolution_note)}&rdquo;</div>` : ''}
        ${crumbsHtml(item.breadcrumbs)}
        <div class="row" style="margin-top:10px; flex-wrap:wrap;">${actions}</div>
      </div>`;
    })
    .join('');

  app.innerHTML = `
    ${topnav('#/')}
    <h1>Feedback</h1>
    ${projectnav(projectId, '/feedback')}
    <div class="chips">${chips}</div>
    <div id="error-box" class="error hidden"></div>
    ${rows || `<p class="muted">No ${filter === 'all' ? '' : `${filter} `}feedback.</p>`}`;

  for (const chip of app.querySelectorAll<HTMLButtonElement>('[data-filter]')) {
    chip.addEventListener('click', () => renderFeedback(app, projectId, chip.dataset.filter!));
  }

  for (const btn of app.querySelectorAll<HTMLButtonElement>('[data-move]')) {
    btn.addEventListener('click', async () => {
      const to = btn.dataset.move as FeedbackStatus;
      let note: string | undefined;
      if (NOTE_NEEDED.has(to)) {
        const answer = prompt(
          to === 'done'
            ? 'Note to the submitter (they will see this next to "shipped"):'
            : 'Why declined? (the submitter will see this):'
        );
        if (answer === null) return;
        note = answer.trim() || undefined;
      }
      try {
        await api.patchFeedback(btn.dataset.id!, to, note);
        await renderFeedback(app, projectId, filter);
      } catch (err) {
        showError(err);
      }
    });
  }
}
