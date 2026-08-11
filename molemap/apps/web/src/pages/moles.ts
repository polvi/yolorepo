import { api, artifactUrl, type Mole } from '../lib/api';
import { esc, fmtDate, fmtScore, showError, topnav } from '../lib/ui';

function moleName(m: Mole): string {
  return m.label || `mole-${m.id.slice(0, 4)}`;
}

export async function renderMoles(app: HTMLElement): Promise<void> {
  document.title = 'molemap — moles';
  const { moles } = await api.moles();
  const active = moles.filter((m) => m.status !== 'dismissed' && m.retired_at === null);
  const rest = moles.filter((m) => m.status === 'dismissed' || m.retired_at !== null);

  const item = (m: Mole) => `
    <a class="card row" style="text-decoration:none; color:inherit;" href="#/moles/${m.id}">
      ${
        m.latest?.crop_sha256
          ? `<img src="${artifactUrl(m.latest.crop_sha256)}" alt="" width="44" height="44"
              style="border-radius:8px; object-fit:cover; background:#000;" />`
          : `<span class="chip ${m.status}">●</span>`
      }
      <div class="grow">
        <strong>${esc(moleName(m))}</strong>
        <div class="muted">${m.observation_count} observation${m.observation_count === 1 ? '' : 's'}
          · ${m.source}${m.retired_at ? ' · retired' : ''}</div>
      </div>
      <span class="chip ${m.retired_at ? 'retired' : m.status}">${m.retired_at ? 'retired' : m.status}</span>
      <span class="muted mono">${fmtScore(m.change_score)}</span>
    </a>`;

  app.innerHTML = `
    ${topnav('#/moles')}
    <div class="page">
      <h1>Moles</h1>
      <p class="muted">Change scores compare the two most recent detections of the same spot.
        molemap measures change; it does not diagnose.</p>
      <div id="error-box" class="error hidden"></div>
      ${active.map(item).join('') || '<p class="muted">No moles tracked yet. Place pins in the viewer, or upload a visit with detections.</p>'}
      ${rest.length ? `<h2 style="margin-top:20px;">Dismissed &amp; retired</h2>${rest.map(item).join('')}` : ''}
    </div>`;
}

export async function renderMoleDetail(app: HTMLElement, id: string): Promise<void> {
  const { mole, observations } = await api.mole(id);
  document.title = `molemap — ${moleName(mole)}`;

  const passport = observations
    .map(
      (o) => `
      <div class="obs">
        ${o.crop_sha256 ? `<img src="${artifactUrl(o.crop_sha256)}" alt="Crop from ${fmtDate(o.captured_at)}" />` : ''}
        <div style="margin-top:8px;"><strong>${fmtDate(o.captured_at)}</strong></div>
        <div class="muted">${o.diameter_mm ? `${o.diameter_mm} mm` : 'no size'} · ${fmtScore(o.change_score)}</div>
        ${o.note ? `<div class="muted" style="margin-top:4px;">${esc(o.note)}</div>` : ''}
      </div>`
    )
    .join('');

  app.innerHTML = `
    ${topnav('#/moles')}
    <div class="page">
      <div class="row" style="margin-bottom:12px;">
        <a class="btn secondary small" href="#/moles">‹ Moles</a>
        <h1 class="grow" style="margin:0;">${esc(moleName(mole))}</h1>
        <span class="chip ${mole.retired_at ? 'retired' : mole.status}">${mole.retired_at ? 'retired' : mole.status}</span>
      </div>
      <div id="error-box" class="error hidden"></div>
      <div class="card">
        <label class="field">
          <span>Label</span>
          <input type="text" id="m-label" maxlength="80" value="${esc(mole.label)}" />
        </label>
        <div class="row">
          <button class="btn small" id="m-save">Save</button>
          ${
            mole.status === 'proposed'
              ? `<button class="btn small secondary" id="m-confirm">Confirm</button>
                 <button class="btn danger small" id="m-dismiss">Dismiss</button>`
              : ''
          }
          ${
            mole.retired_at === null
              ? `<button class="btn secondary small" id="m-retire">Retire</button>`
              : `<button class="btn secondary small" id="m-unretire">Unretire</button>`
          }
        </div>
        <p class="muted" style="margin:10px 0 0;">
          Position <span class="mono">(${mole.canonical_x.toFixed(3)}, ${mole.canonical_y.toFixed(3)}, ${mole.canonical_z.toFixed(3)})</span>
          · ${mole.source === 'detected' ? 'proposed by detection' : 'placed manually'}
        </p>
      </div>
      <h2>Passport</h2>
      ${passport ? `<div class="passport">${passport}</div>` : '<p class="muted">No observations yet.</p>'}
    </div>`;

  const patch = async (fields: Parameters<typeof api.patchMole>[1]) => {
    try {
      await api.patchMole(id, fields);
      await renderMoleDetail(app, id);
    } catch (err) {
      showError(err);
    }
  };
  document.getElementById('m-save')!.addEventListener('click', () =>
    patch({ label: (document.getElementById('m-label') as HTMLInputElement).value.trim() })
  );
  document.getElementById('m-confirm')?.addEventListener('click', () => patch({ status: 'confirmed' }));
  document.getElementById('m-dismiss')?.addEventListener('click', () => patch({ status: 'dismissed' }));
  document.getElementById('m-retire')?.addEventListener('click', () => patch({ retired: true }));
  document.getElementById('m-unretire')?.addEventListener('click', () => patch({ retired: false }));
}
