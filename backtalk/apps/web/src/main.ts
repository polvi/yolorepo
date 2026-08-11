import { api, type Me } from './lib/api';
import { friendlyAuthError, passkeyCreateAccount, passkeySignIn } from './lib/authg';
import { showError } from './lib/ui';

const app = document.getElementById('app')!;
let me: Me | null = null;

// ---------------------------------------------------------------- routing

async function route(): Promise<void> {
  const hash = location.hash.replace(/^#/, '') || '/';
  if (!me) {
    renderLanding();
    return;
  }

  const feedback = hash.match(/^\/p\/([\w-]+)\/feedback$/);
  const errorGroup = hash.match(/^\/p\/([\w-]+)\/errors\/([\w-]+)$/);
  const errors = hash.match(/^\/p\/([\w-]+)\/errors$/);
  const stats = hash.match(/^\/p\/([\w-]+)\/stats$/);
  const project = hash.match(/^\/p\/([\w-]+)$/);

  if (hash === '/settings') {
    const { renderSettings } = await import('./pages/settings');
    await renderSettings(app);
  } else if (feedback) {
    const { renderFeedback } = await import('./pages/feedback');
    await renderFeedback(app, feedback[1]!);
  } else if (errorGroup) {
    const { renderErrorGroup } = await import('./pages/errorGroup');
    await renderErrorGroup(app, errorGroup[1]!, errorGroup[2]!);
  } else if (errors) {
    const { renderErrors } = await import('./pages/errors');
    await renderErrors(app, errors[1]!);
  } else if (stats) {
    const { renderStats } = await import('./pages/stats');
    await renderStats(app, stats[1]!);
  } else if (project) {
    const { renderProject } = await import('./pages/project');
    await renderProject(app, project[1]!);
  } else {
    const { renderProjects } = await import('./pages/projects');
    await renderProjects(app);
  }
}

// ---------------------------------------------------------------- landing

function renderLanding(): void {
  document.title = 'backtalk — feedback your agent can act on';
  app.innerHTML = `
    <div class="landing">
      <div class="wordmark">backtalk<span class="dot">.</span></div>
      <p class="tagline">
        A hidden feedback widget and error tracker for your site — read by
        your coding agent, which offers to fix what people report. When it
        ships, the person who asked sees it.
      </p>
      <div class="cta">
        <button class="btn" id="cta-register">Create account</button>
        <button class="btn secondary" id="cta-signin">Sign in with a passkey</button>
      </div>
      <div id="error-box" class="error hidden"></div>
      <p class="kbd-hint">On a site running backtalk, press <kbd>?</kbd> — or
        hold two fingers down — and the feedback sheet appears.</p>
      <div class="pitch">
        <div class="card">
          <h2>Hidden until summoned</h2>
          <p class="muted">
            One script tag. No floating button, no banner. Visitors who want
            to talk open a small sheet with a shortcut or a two-finger press;
            everyone else never sees it.
          </p>
        </div>
        <div class="card">
          <h2>Errors report themselves</h2>
          <p class="muted">
            Uncaught exceptions are captured, fingerprinted, and grouped, with
            a breadcrumb trail of what happened just before. Resolved errors
            that come back get flagged as regressions.
          </p>
        </div>
        <div class="card">
          <h2>Your agent does the reading</h2>
          <p class="muted">
            Claude Code (or any MCP client) connects with one command and
            pulls feedback, stack traces, and Web Vitals — then offers to
            implement the fixes right in your codebase.
          </p>
        </div>
        <div class="card">
          <h2>The loop closes</h2>
          <p class="muted">
            When the agent marks an item done, the note it writes shows up in
            the widget for the person who reported it: &ldquo;shipped ✓&rdquo;.
            Feedback that visibly lands begets more feedback.
          </p>
        </div>
      </div>
      <p class="muted" style="margin-top:26px; font-size:13px;">
        Passkey accounts via <a href="https://authgravity.org">AuthGravity</a>.
        An <a href="https://infinitelogic.org">Infinite Logic PBC</a> playground project.
      </p>
    </div>`;

  const boot = async (fn: () => Promise<void>) => {
    try {
      await fn();
      me = await api.me();
      await route();
    } catch (err) {
      const message = friendlyAuthError(err);
      if (message) {
        const box = document.getElementById('error-box')!;
        box.textContent = message;
        box.classList.remove('hidden');
      }
    }
  };
  document.getElementById('cta-register')!.addEventListener('click', () => boot(passkeyCreateAccount));
  document.getElementById('cta-signin')!.addEventListener('click', () => boot(passkeySignIn));
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
