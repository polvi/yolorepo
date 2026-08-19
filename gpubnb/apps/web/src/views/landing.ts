import { api } from '../lib/api';

// Four inline SVGs, one per trust step. Hand-drawn-simple line art so it
// reads in both themes (strokes use currentColor-ish CSS vars).
const STEP_SVG = {
  cvm: `<svg viewBox="0 0 160 72" aria-hidden="true">
    <rect x="8" y="10" width="144" height="52" rx="6" class="dia"/>
    <rect x="18" y="20" width="60" height="32" rx="3" class="dia-soft"/>
    <text x="48" y="40" text-anchor="middle" font-family="var(--mono)" font-size="9" class="dia-fill">CPU · SEV-SNP</text>
    <rect x="86" y="20" width="56" height="32" rx="3" class="dia-soft"/>
    <text x="114" y="36" text-anchor="middle" font-family="var(--mono)" font-size="9" class="dia-fill">GPU · CC</text>
    <text x="114" y="46" text-anchor="middle" font-family="var(--mono)" font-size="7" class="dia-fill" opacity=".6">on</text>
    <path d="M78 36h8" class="dia"/>
    <rect x="4" y="6" width="152" height="60" rx="8" class="dia" stroke-dasharray="3 3" opacity=".5"/>
  </svg>`,
  attest: `<svg viewBox="0 0 160 72" aria-hidden="true">
    <rect x="10" y="10" width="70" height="44" rx="4" class="dia"/>
    <path d="M18 21h40M18 29h54M18 37h30M18 45h46" class="dia" opacity=".5"/>
    <path d="M90 36h22" class="dia"/>
    <path d="M108 30l6 6-6 6" class="dia"/>
    <circle cx="134" cy="36" r="14" class="dia"/>
    <path d="M127 36l5 5 9-10" class="dia-ok"/>
    <text x="45" y="65" text-anchor="middle" font-family="var(--mono)" font-size="7" class="dia-fill" opacity=".6">report + EAT, signed</text>
  </svg>`,
  verify: `<svg viewBox="0 0 160 72" aria-hidden="true">
    <rect x="14" y="8" width="132" height="50" rx="5" class="dia"/>
    <path d="M14 18h132" class="dia" opacity=".5"/>
    <circle cx="22" cy="13" r="1.6" class="dia-fill"/><circle cx="28" cy="13" r="1.6" class="dia-fill"/><circle cx="34" cy="13" r="1.6" class="dia-fill"/>
    <text x="24" y="31" font-family="var(--mono)" font-size="7.5" class="dia-fill">snp.chain   <tspan fill="var(--ok)">✓ ARK pinned</tspan></text>
    <text x="24" y="41" font-family="var(--mono)" font-size="7.5" class="dia-fill">snp.measure <tspan fill="var(--ok)">✓ golden</tspan></text>
    <text x="24" y="51" font-family="var(--mono)" font-size="7.5" class="dia-fill">gpu.claims  <tspan fill="var(--ok)">✓ secboot</tspan></text>
    <path d="M60 58v6h40v-6" class="dia" opacity=".5"/>
  </svg>`,
  pay: `<svg viewBox="0 0 160 72" aria-hidden="true">
    <circle cx="40" cy="36" r="18" class="dia-xmr"/>
    <path d="M30 44V28l10 10 10-10v16" stroke="#fff" stroke-width="2.6" fill="none" stroke-linejoin="round" stroke-linecap="round"/>
    <path d="M66 36h40" class="dia" stroke-dasharray="3 3"/>
    <path d="M102 30l6 6-6 6" class="dia"/>
    <rect x="116" y="20" width="34" height="32" rx="4" class="dia"/>
    <text x="133" y="39" text-anchor="middle" font-family="var(--mono)" font-size="8" class="dia-fill">host</text>
    <text x="80" y="66" text-anchor="middle" font-family="var(--mono)" font-size="7" class="dia-fill" opacity=".6">per token · no custody</text>
  </svg>`,
};

export async function renderLanding(el: HTMLElement): Promise<void> {
  document.title = 'gpubnb — confidential GPUs, attested, paid in Monero';
  el.innerHTML = `
    <section class="hero">
      <div>
        <div class="eyebrow">Airbnb for confidential GPUs</div>
        <h1>Rent an inference endpoint you can verify, not one you have to trust.</h1>
        <p class="lede">Hosts run an open-source runner inside an AMD SEV-SNP confidential VM with an NVIDIA
        confidential-computing GPU. The hardware signs a report of exactly what is running. You check that
        report in your own browser, send prompts sealed to a key that exists only inside the enclave, and pay
        the host directly in Monero per token. No account, no middleman, no plaintext anywhere else.</p>
        <div class="ctas">
          <a class="btn" href="#/listings">Browse endpoints</a>
          <a class="btn secondary" href="#/host">Host a GPU</a>
        </div>
      </div>
      <div class="hero-term" id="hero-term"><span class="dim">$</span> gpubnb verify https://gpu.example.net
<span class="ok">✓</span> doc.sig          ed25519 ok
<span class="ok">✓</span> snp.chain        VCEK → ASK → ARK (Turin, pinned)
<span class="ok">✓</span> snp.measurement  golden runner 0.1.0
<span class="ok">✓</span> snp.report_data  binds hpke_pub ‖ challenge
<span class="ok">✓</span> gpu.claims       secboot · dbgstat=disabled
<span class="ok">✓</span> gpu.nonce        fresh
<span class="dim">verified · RTX PRO 6000 Blackwell SE · Qwen3-8B</span></div>
    </section>

    <section class="section">
      <div class="section-head"><span class="num">01–04</span><h2>How trust works</h2></div>
      <div class="steps">
        <div class="step">
          <div class="n">01 · HARDWARE</div>${STEP_SVG.cvm}
          <h3>CVM + GPU CC</h3>
          <p>The runner boots inside an SEV-SNP confidential VM with the GPU in confidential-computing mode.
          The host cannot read guest RAM or VRAM; the OS image is measured at launch.</p>
        </div>
        <div class="step">
          <div class="n">02 · ATTESTATION</div>${STEP_SVG.attest}
          <h3>Hardware signs what is running</h3>
          <p>AMD signs the VM measurement and NVIDIA signs the GPU state, both over a nonce that binds the
          runner's fresh keys, version, and model digest. The runner publishes this signed doc.</p>
        </div>
        <div class="step">
          <div class="n">03 · VERIFY</div>${STEP_SVG.verify}
          <h3>Verify in your browser</h3>
          <p>Your client re-checks everything with pinned AMD and NVIDIA roots and an offline-signed golden
          set. This site also verifies, but you never have to believe it.</p>
        </div>
        <div class="step">
          <div class="n">04 · PAY</div>${STEP_SVG.pay}
          <h3>Pay the host in XMR</h3>
          <p>Open a sealed session, top up a per-session Monero subaddress, chat with end-to-end encryption,
          and get a signed receipt inside every response. The marketplace never touches money.</p>
        </div>
      </div>
    </section>

    <section class="section twocol">
      <div class="card">
        <div class="eyebrow">For renters</div>
        <h2>No account. No API key. No plaintext.</h2>
        <p>Pick an endpoint, hit <em>Verify</em>, pay a little Monero, start chatting. Everything after the
        verification happens between your browser and the enclave. The OpenAI-compatible API means the
        <code>@gpubnb/client</code> SDK drops into existing tools.</p>
        <a class="btn secondary" href="#/listings">See what is listed</a>
      </div>
      <div class="card">
        <div class="eyebrow">For hosts</div>
        <h2>Put a confidential GPU to work.</h2>
        <p>RTX PRO 6000 Blackwell Server Edition first; H100, H200, B200, B300 follow. Run
        <code>gpubnbd</code> inside the CVM, register with a token, heartbeat. Renters pay your wallet
        directly; the runner credits sessions from a view-only wallet. No fee in v1.</p>
        <a class="btn secondary" href="#/host">Host dashboard</a>
      </div>
    </section>

    <section class="section">
      <div class="section-head"><span class="num">now</span><h2>Live directory</h2></div>
      <div id="landing-live" class="muted small">Loading…</div>
    </section>`;

  try {
    const { listings } = await api.listings();
    const live = document.getElementById('landing-live');
    if (!live) return;
    const verified = listings.filter((l) => l.trust_status === 'verified').length;
    const gpus = new Set(listings.map((l) => l.gpu_model)).size;
    const models = new Set(listings.map((l) => l.model_id)).size;
    live.innerHTML = listings.length
      ? `<span class="mono">${listings.length}</span> listed · <span class="mono">${verified}</span> verified right now ·
         <span class="mono">${gpus}</span> GPU types · <span class="mono">${models}</span> models ·
         <a href="#/listings">open the directory →</a>`
      : `Nothing real is listed yet. Simulated (dev) endpoints, if any, are behind the toggle on the
         <a href="#/listings">listings page</a>.`;
  } catch {
    const live = document.getElementById('landing-live');
    if (live) live.textContent = 'Directory unavailable right now.';
  }
}
