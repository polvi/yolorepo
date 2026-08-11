import { api } from '../lib/api';
import { esc, showError, topnav } from '../lib/ui';

export async function renderProjects(app: HTMLElement): Promise<void> {
  document.title = 'backtalk — projects';
  const { projects } = await api.projects();

  const rows = projects
    .map(
      (p) => `
      <a class="card row" style="display:flex; color:inherit;" href="#/p/${p.id}">
        <div class="grow">
          <strong>${esc(p.name)}</strong>
          <div class="muted mono">${esc(p.public_key)}</div>
        </div>
        ${p.new_feedback ? `<span class="badge new">${p.new_feedback} new feedback</span>` : ''}
        ${p.open_errors ? `<span class="badge regressed">${p.open_errors} open errors</span>` : ''}
      </a>`
    )
    .join('');

  app.innerHTML = `
    ${topnav('#/')}
    <h1>Projects</h1>
    <div id="error-box" class="error hidden"></div>
    ${rows || '<p class="muted">No projects yet — create one and drop the snippet on your site.</p>'}
    <form id="create-form" class="row" style="margin-top:16px;">
      <input type="text" id="project-name" class="grow" placeholder="Project name (e.g. my-site)" maxlength="80" />
      <button class="btn" type="submit">Create</button>
    </form>`;

  document.getElementById('create-form')!.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = (document.getElementById('project-name') as HTMLInputElement).value.trim();
    if (!name) return;
    try {
      const { id } = await api.createProject(name);
      location.hash = `#/p/${id}`;
    } catch (err) {
      showError(err);
    }
  });
}
