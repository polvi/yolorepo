import { api } from '../lib/api';
import { esc, projectnav, showError, topnav } from '../lib/ui';

export async function renderProject(app: HTMLElement, id: string): Promise<void> {
  const { project, counts } = await api.project(id);
  document.title = `backtalk — ${project.name}`;

  const snippet = `<script src="${location.origin}/w.js" data-key="${project.public_key}" data-release="v1" defer><\/script>`;

  const count = (m: Record<string, number>, keys: string[]) =>
    keys.reduce((n, k) => n + (m[k] ?? 0), 0);

  app.innerHTML = `
    ${topnav('#/')}
    <h1>${esc(project.name)}</h1>
    ${projectnav(id, '')}
    <div id="error-box" class="error hidden"></div>

    <div class="statgrid">
      <a class="stat" href="#/p/${id}/feedback" style="color:inherit;">
        <div class="n">${count(counts.feedback, ['new'])}</div>
        <div class="muted">new feedback</div>
      </a>
      <a class="stat" href="#/p/${id}/errors" style="color:inherit;">
        <div class="n">${count(counts.errors, ['open', 'regressed'])}</div>
        <div class="muted">open error groups</div>
      </a>
      <a class="stat" href="#/p/${id}/feedback" style="color:inherit;">
        <div class="n">${count(counts.feedback, ['done'])}</div>
        <div class="muted">shipped</div>
      </a>
    </div>

    <h2>Embed</h2>
    <p class="muted">One tag, before <span class="mono">&lt;/body&gt;</span> or with
      <span class="mono">defer</span> anywhere. The widget stays invisible until
      someone presses <kbd>&#8984;</kbd><kbd>&#8679;</kbd><kbd>/</kbd> or holds two fingers down.</p>
    <div class="snippet" id="snippet">${esc(snippet)}</div>
    <button class="btn ghost small" id="copy-snippet" style="margin-top:8px;">Copy snippet</button>

    <h2>Allowed origins</h2>
    <p class="muted">Comma-separated exact origins that may send events
      (e.g. <span class="mono">https://example.com</span>). Empty allows any origin.</p>
    <form id="origins-form" class="row">
      <input type="text" id="origins" class="grow mono" value="${esc(project.allowed_origins)}"
        placeholder="https://example.com, https://www.example.com" />
      <button class="btn small" type="submit">Save</button>
    </form>

    <h2>Connect your coding agent</h2>
    <p class="muted">Mint a token in <a href="#/settings">Settings</a>, then:</p>
    <div class="snippet">claude mcp add --transport http backtalk ${location.origin}/mcp --header "Authorization: Bearer bt_..."</div>

    <h2>Danger</h2>
    <button class="btn danger small" id="delete-project">Delete project and all its data</button>`;

  document.getElementById('copy-snippet')!.addEventListener('click', async () => {
    await navigator.clipboard.writeText(snippet);
    document.getElementById('copy-snippet')!.textContent = 'Copied';
  });

  document.getElementById('origins-form')!.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api.patchProject(id, {
        allowed_origins: (document.getElementById('origins') as HTMLInputElement).value.trim(),
      });
      await renderProject(app, id);
    } catch (err) {
      showError(err);
    }
  });

  document.getElementById('delete-project')!.addEventListener('click', async () => {
    if (!confirm(`Delete "${project.name}" and every piece of feedback and error data? This cannot be undone.`)) return;
    try {
      await api.deleteProject(id);
      location.hash = '#/';
    } catch (err) {
      showError(err);
    }
  });
}
