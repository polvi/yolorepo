import { api, ApiError, type HostListing, type TokenRow } from '../lib/api';
import { friendlyAuthError, passkeyCreateAccount, passkeySignIn } from '../lib/authg';
import { ago, badge, esc, fmtXmr } from '../lib/format';

function installGuide(origin: string): string {
  const toml = `# /etc/gpubnbd/config.toml — lives INSIDE the CVM
[listing]
slug       = "gpu-1"                 <span class="c"># stable id under your account</span>
gpu_model  = "NVIDIA RTX PRO 6000 Blackwell Server Edition"
region     = "us-west"
model_id   = "Qwen/Qwen3-8B"
weights    = "/models/qwen3-8b"      <span class="c"># digest must be in the signed catalog</span>

[price]                              <span class="c"># piconero per 1,000,000 tokens</span>
in_per_m   = 1_000_000_000           <span class="c"># 0.001 XMR</span>
out_per_m  = 4_000_000_000

[upstream]
url        = "http://127.0.0.1:8000" <span class="c"># vLLM / llama-server, OpenAI-compatible</span>

[xmr]
network    = "mainnet"               <span class="c"># "stagenet" while developing</span>
address    = "4…"                    <span class="c"># your primary address</span>
view_key   = "…"                     <span class="c"># PRIVATE view key (watch-only)</span>
node_url   = "https://node.example:18089"
confirmations = 10

[marketplace]
url        = "${origin}"
token      = "gb_…"                  <span class="c"># minted above; paste once</span>`;
  return `
    <p class="small">The runner registers the listing, POSTs its attestation doc, and heartbeats every 5 minutes
    (answering the marketplace's re-attest challenge every 6 h). Renters pay your wallet's per-session
    subaddresses directly; the runner credits sessions from a view-only wallet. Your spend key never leaves
    your pocket.</p>
    <pre class="code">${toml}</pre>
    <pre class="code"><span class="c"># inside the CVM</span>
gpubnbd --config /etc/gpubnbd/config.toml

<span class="c"># no CC hardware yet? run the whole flow under the public dev key</span>
<span class="c"># (listing shows as SIMULATED, hidden by default, never "verified"):</span>
gpubnbd --config config.toml --simulate   <span class="c"># xmr.network = "stagenet", or xmr.mode = "free"</span></pre>
    <p class="small muted">Hardware checklist: AMD EPYC Genoa/Turin with SEV-SNP + IOMMU on in BIOS, GPU bound to vfio,
    <code>nvidia_gpu_tools.py --set-cc-mode=on</code>, QEMU <code>sev-snp-guest</code> direct boot of the published CVM
    image (measurement must match the golden set for its runner version). Full guide and image build in the repository
    README.</p>`;
}

export async function renderHost(el: HTMLElement): Promise<void> {
  document.title = 'gpubnb — host dashboard';
  let me: { user_id: string } | null = null;
  try {
    me = await api.hostMe();
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 401)) throw err;
  }
  if (!me) {
    renderAuth(el);
    return;
  }
  await renderDashboard(el);
}

function renderAuth(el: HTMLElement): void {
  el.innerHTML = `
    <div class="card auth-card">
      <div class="eyebrow">host dashboard</div>
      <h2>Sign in with a passkey</h2>
      <p class="small muted">Hosts need an account only to mint runner tokens and see their listings. Renters never sign in.</p>
      <div class="row" style="justify-content:center">
        <button class="btn" id="cta-signin">Sign in</button>
        <button class="btn secondary" id="cta-register">Create account</button>
      </div>
      <p id="auth-error" class="small hidden" style="color:var(--bad); margin-top:12px"></p>
      <p class="small muted" style="margin-top:16px">Auth by <a href="https://authgravity.org" rel="noopener">AuthG</a>.</p>
    </div>`;
  const authError = document.getElementById('auth-error')!;
  const wire = (id: string, ceremony: () => Promise<void>) => {
    const btn = document.getElementById(id) as HTMLButtonElement;
    btn.addEventListener('click', async () => {
      authError.classList.add('hidden');
      btn.disabled = true;
      try {
        await ceremony();
        await renderDashboard(el);
      } catch (err) {
        const message = friendlyAuthError(err);
        if (message) {
          authError.textContent = message;
          authError.classList.remove('hidden');
        }
      } finally {
        btn.disabled = false;
      }
    });
  };
  wire('cta-signin', passkeySignIn);
  wire('cta-register', passkeyCreateAccount);
}

async function renderDashboard(el: HTMLElement): Promise<void> {
  const [{ tokens }, { listings }] = await Promise.all([api.tokens(), api.hostListings()]);
  const origin = location.origin;
  el.innerHTML = `
    <div class="section-head"><span class="num">host</span><h2>Your listings</h2></div>
    <div id="error-box" class="error hidden"></div>
    <div class="table-wrap card" style="padding:0">${listingsTable(listings)}</div>

    <div class="section">
      <div class="section-head"><span class="num">tokens</span><h2>Runner tokens</h2></div>
      <p class="small muted">A <code>gb_</code> token lets a runner register, attest, and heartbeat listings under your account.
      It cannot mint or revoke tokens. Shown once; store it in the runner config.</p>
      <form class="row" id="mint-form">
        <input type="text" id="mint-name" placeholder="name (e.g. rack-2 gpu-1)" maxlength="80" style="max-width:320px" />
        <button class="btn" type="submit">Mint token</button>
      </form>
      <div id="minted"></div>
      <div class="table-wrap" style="margin-top:12px">${tokensTable(tokens)}</div>
    </div>

    <div class="section">
      <div class="section-head"><span class="num">install</span><h2>Install the runner</h2></div>
      ${installGuide(origin)}
    </div>`;

  const errorBox = document.getElementById('error-box')!;
  const showError = (err: unknown) => {
    errorBox.textContent = err instanceof ApiError ? err.message : 'Something went wrong.';
    errorBox.classList.remove('hidden');
  };

  document.getElementById('mint-form')!.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = (document.getElementById('mint-name') as HTMLInputElement).value.trim();
    try {
      const { token } = await api.mintToken(name);
      document.getElementById('minted')!.innerHTML = `
        <div class="tokenbox">
          <div class="eyebrow" style="margin-bottom:4px">copy now — it will not be shown again</div>
          <span data-copy="${esc(token)}" style="cursor:pointer" title="tap to copy">${esc(token)}</span>
        </div>`;
      const { tokens: fresh } = await api.tokens();
      el.querySelector('.section .table-wrap')!.innerHTML = tokensTable(fresh);
      wireRevoke();
    } catch (err) {
      showError(err);
    }
  });

  function wireRevoke(): void {
    el.querySelectorAll<HTMLElement>('[data-revoke]').forEach((b) => {
      b.addEventListener('click', async () => {
        if (!confirm('Revoke this token? Runners using it stop being able to heartbeat.')) return;
        try {
          await api.revokeToken(b.dataset.revoke!);
          const { tokens: fresh } = await api.tokens();
          el.querySelector('.section .table-wrap')!.innerHTML = tokensTable(fresh);
          wireRevoke();
        } catch (err) {
          showError(err);
        }
      });
    });
  }
  wireRevoke();

  el.querySelectorAll<HTMLElement>('[data-del]').forEach((b) => {
    b.addEventListener('click', async () => {
      if (!confirm('Delete this listing and its attestation history?')) return;
      try {
        await api.deleteListing(b.dataset.del!);
        await renderDashboard(el);
      } catch (err) {
        showError(err);
      }
    });
  });
}

function listingsTable(listings: HostListing[]): string {
  if (!listings.length) {
    return `<div class="notice" style="border:0">No listings yet. Mint a token below, put it in the runner config, and the
      runner registers itself on first start.</div>`;
  }
  return `<table>
    <thead><tr><th>slug</th><th>gpu / model</th><th>status</th><th>heartbeat</th><th>attested</th><th>checks</th><th>price in/out</th><th></th></tr></thead>
    <tbody>${listings
      .map((l) => {
        const checks = l.verdict?.checks ?? [];
        const okN = checks.filter((c) => c.ok).length;
        const failing = checks.filter((c) => !c.ok).map((c) => `${c.id}: ${c.detail ?? ''}`);
        return `<tr>
          <td><a href="#/l/${esc(l.id)}" class="mono">${esc(l.slug)}</a>${l.simulated ? '<br>' + badge('simulated') : ''}</td>
          <td>${esc(l.gpu_model)}<br><span class="mono small muted">${esc(l.model_id)}</span></td>
          <td>${badge(l.trust_status)}${
            l.challenge_pending ? `<br><span class="small muted mono">challenge pending ${ago(l.challenge_issued_at)}</span>` : ''
          }</td>
          <td class="mono">${ago(l.last_heartbeat)}</td>
          <td class="mono">${ago(l.verified_at)}</td>
          <td class="mono" title="${esc(failing.join('\n'))}">${checks.length ? `${okN}/${checks.length}` : '—'}${
            failing.length ? `<br><span class="small" style="color:var(--bad)">${esc(failing[0]!.slice(0, 60))}${failing.length > 1 ? ` +${failing.length - 1}` : ''}</span>` : ''
          }</td>
          <td class="mono small">${fmtXmr(l.price_in_piconero)}<br>${fmtXmr(l.price_out_piconero)}</td>
          <td><button class="btn danger small" data-del="${esc(l.id)}">delete</button></td>
        </tr>`;
      })
      .join('')}</tbody></table>`;
}

function tokensTable(tokens: TokenRow[]): string {
  if (!tokens.length) return '<p class="small muted">No tokens yet.</p>';
  return `<table>
    <thead><tr><th>name</th><th>hash</th><th>created</th><th>last used</th><th></th></tr></thead>
    <tbody>${tokens
      .map(
        (t) => `<tr>
          <td>${esc(t.name || '—')}</td>
          <td class="mono small">${esc(t.token_hash.slice(0, 12))}…</td>
          <td class="mono small">${ago(t.created_at)}</td>
          <td class="mono small">${ago(t.last_used_at)}</td>
          <td><button class="btn danger small" data-revoke="${esc(t.token_hash)}">revoke</button></td>
        </tr>`
      )
      .join('')}</tbody></table>`;
}
