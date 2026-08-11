import { api } from '../lib/api';
import { esc, fmtDate, showError, topnav } from '../lib/ui';

export async function renderSettings(app: HTMLElement): Promise<void> {
  document.title = 'molemap — settings';
  const { tokens } = await api.tokens();

  const rows = tokens
    .map(
      (t) => `
      <div class="row" style="padding:8px 0; border-bottom:1px solid var(--border);">
        <div class="grow">
          <strong>${esc(t.name || 'unnamed token')}</strong>
          <div class="muted">created ${fmtDate(t.created_at)} ·
            ${t.last_used_at ? `last used ${fmtDate(t.last_used_at)}` : 'never used'}
            · <span class="mono">${esc(t.token_hash.slice(0, 12))}…</span></div>
        </div>
        <button class="btn danger small" data-revoke="${esc(t.token_hash)}">Revoke</button>
      </div>`
    )
    .join('');

  app.innerHTML = `
    ${topnav('#/settings')}
    <div class="page">
      <h1>Settings</h1>
      <div id="error-box" class="error hidden"></div>
      <h2>API tokens</h2>
      <p class="muted">
        The molemap CLI authenticates with <span class="mono">Authorization: Bearer mm_…</span>.
        The plaintext is shown once at mint time; only its hash is stored.
      </p>
      <div id="minted"></div>
      <div class="card">
        ${rows || '<p class="muted" style="margin:0;">No tokens yet.</p>'}
      </div>
      <form id="mint-form" class="row">
        <input type="text" id="token-name" class="grow" placeholder="Token name (e.g. laptop)"
          maxlength="80" />
        <button class="btn small" type="submit">Mint token</button>
      </form>
    </div>`;

  document.getElementById('mint-form')!.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = (document.getElementById('token-name') as HTMLInputElement).value.trim();
    try {
      const { token } = await api.mintToken(name);
      document.getElementById('minted')!.innerHTML = `
        <div class="token-plain" style="margin-bottom:12px;">
          <div class="muted" style="margin-bottom:6px;">Copy it now — it will not be shown again.</div>
          <span class="mono" id="token-value">${esc(token)}</span>
          <button class="btn ghost small" style="margin-top:8px;" id="token-copy">Copy</button>
        </div>`;
      document.getElementById('token-copy')!.addEventListener('click', async () => {
        await navigator.clipboard.writeText(token);
        document.getElementById('token-copy')!.textContent = 'Copied';
      });
    } catch (err) {
      showError(err);
    }
  });

  for (const btn of app.querySelectorAll<HTMLButtonElement>('[data-revoke]')) {
    btn.addEventListener('click', async () => {
      if (!confirm('Revoke this token? The CLI using it will stop working.')) return;
      try {
        await api.revokeToken(btn.dataset.revoke!);
        await renderSettings(app);
      } catch (err) {
        showError(err);
      }
    });
  }
}
