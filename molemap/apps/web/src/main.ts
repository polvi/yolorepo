import { api, type Me } from './lib/api';
import { loginUrl } from './lib/origins';
import { showError, topnav } from './lib/ui';

const app = document.getElementById('app')!;
let me: Me | null = null;

// The active page's teardown (viewer render loop, etc.).
let cleanup: (() => void) | null = null;

// ---------------------------------------------------------------- routing

async function route(): Promise<void> {
  cleanup?.();
  cleanup = null;

  const hash = location.hash.replace(/^#/, '') || '/';
  if (!me) {
    renderLanding();
    return;
  }

  const moleDetail = hash.match(/^\/moles\/([\w-]+)$/);
  if (hash === '/viewer') {
    const { renderViewer } = await import('./pages/viewer');
    cleanup = await renderViewer(app);
  } else if (hash === '/visits') {
    const { renderVisits } = await import('./pages/visits');
    await renderVisits(app);
  } else if (moleDetail) {
    const { renderMoleDetail } = await import('./pages/moles');
    await renderMoleDetail(app, moleDetail[1]!);
  } else if (hash === '/moles') {
    const { renderMoles } = await import('./pages/moles');
    await renderMoles(app);
  } else if (hash === '/settings') {
    const { renderSettings } = await import('./pages/settings');
    await renderSettings(app);
  } else {
    renderLanding();
  }
}

// ---------------------------------------------------------------- landing

function renderLanding(): void {
  document.title = 'molemap — your skin, mapped over time';
  const cta = me
    ? `<a class="btn" href="#/viewer">Open your map</a>
       <a class="btn secondary" href="#/visits">Visits</a>`
    : `<a class="btn" href="${loginUrl()}">Sign in with a passkey</a>
       <a class="btn secondary" href="${loginUrl()}">Create account</a>`;
  app.innerHTML = `
    ${me ? topnav('#/') : ''}
    <div class="landing">
      <div class="wordmark">molemap<span class="dot">.</span></div>
      <p class="tagline">
        Google Earth for the body. A 3D map of your skin you can scrub
        through time — every mole a pin, every visit a snapshot.
      </p>
      <div class="cta">${cta}</div>
      <div class="pitch">
        <div class="card">
          <h2>Capture at home</h2>
          <p class="muted">
            The molemap CLI turns a short photo session — orbits at two or
            three heights, ~80% overlap, diffuse light — into a 3D
            reconstruction, entirely on your own machine.
          </p>
        </div>
        <div class="card">
          <h2>Only the map leaves</h2>
          <p class="muted">
            Raw photos never leave your computer. The CLI uploads only the
            derived 3D artifacts, stored privately per account.
          </p>
        </div>
        <div class="card">
          <h2>Pins through time</h2>
          <p class="muted">
            Each mole gets a pin, placed by you or proposed by detection,
            and a passport of crops, sizes, and notes across visits.
          </p>
        </div>
        <div class="card">
          <h2>Change, measured</h2>
          <p class="muted">
            A time slider and per-mole change scores make "is this
            different?" a question with a record behind it.
          </p>
        </div>
      </div>
      <p class="disclaimer">
        molemap measures change; it does not diagnose. Bring anything that
        changes to a dermatologist.
      </p>
    </div>`;
}

// ---------------------------------------------------------------- boot

window.addEventListener('hashchange', () => {
  route().catch(showError);
});

(async () => {
  try {
    me = await api.me();
  } catch {
    me = null;
  }
  await route().catch(showError);
})();
