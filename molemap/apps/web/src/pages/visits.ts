import { api } from '../lib/api';
import { esc, fmtDate, showError, topnav } from '../lib/ui';

export async function renderVisits(app: HTMLElement): Promise<void> {
  document.title = 'molemap — visits';
  const { visits } = await api.visits();

  const cards = visits
    .map(
      (v) => `
      <div class="card">
        <div class="row">
          <div class="grow">
            <strong>${fmtDate(v.captured_at)}</strong>
            <div class="muted">${v.artifact_count} artifact${v.artifact_count === 1 ? '' : 's'}
              · <span class="mono">${esc(v.id.slice(0, 8))}</span></div>
          </div>
          <span class="chip ${v.status}">${v.status}</span>
          ${v.status === 'ready' ? `<a class="btn secondary small" href="#/viewer">View</a>` : ''}
        </div>
        <details style="margin-top:10px;">
          <summary class="muted" style="cursor:pointer;">Alignment (visit → canonical, column-major 4×4)</summary>
          <textarea data-alignment="${v.id}" spellcheck="false">${esc(v.alignment)}</textarea>
          <button class="btn small secondary" style="margin-top:8px;" data-save="${v.id}">Save alignment</button>
        </details>
      </div>`
    )
    .join('');

  app.innerHTML = `
    ${topnav('#/visits')}
    <div class="page">
      <h1>Visits</h1>
      <div id="error-box" class="error hidden"></div>
      ${cards || `<p class="muted">No visits yet. The molemap CLI creates one per capture session.</p>`}
    </div>`;

  for (const btn of app.querySelectorAll<HTMLButtonElement>('[data-save]')) {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.save!;
      const textarea = app.querySelector<HTMLTextAreaElement>(`[data-alignment="${id}"]`)!;
      let alignment: number[];
      try {
        alignment = JSON.parse(textarea.value);
        if (!Array.isArray(alignment) || alignment.length !== 16) throw new Error();
      } catch {
        showError(new Error('Alignment must be a JSON array of 16 numbers.'));
        return;
      }
      btn.disabled = true;
      try {
        await api.setAlignment(id, alignment);
        btn.textContent = 'Saved';
        setTimeout(() => {
          btn.textContent = 'Save alignment';
          btn.disabled = false;
        }, 1200);
      } catch (err) {
        btn.disabled = false;
        showError(err);
      }
    });
  }
}
