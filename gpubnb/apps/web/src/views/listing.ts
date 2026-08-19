import { api, type Check, type Listing } from '../lib/api';
import { ago, badge, copyText, esc, fmtInt, fmtUptime, fmtUsd, fmtXmr, shortHex } from '../lib/format';
import { connect, receiptPayload, restore, verifyListingInBrowser, type Client } from '../lib/gp';
import { buildMoneroUri, shortAddress } from '../lib/moneroUri';
import { qrSvg } from '../lib/qr';
import { forgetSession, loadSession, saveSession } from '../lib/sessions';

import type { Receipt } from '@gpubnb/protocol';

function checksHtml(checks: Check[]): string {
  if (!checks.length) return '<li class="skip"><span class="mark">·</span><span>no checks</span></li>';
  return checks
    .map(
      (c) => `<li class="${c.ok ? 'ok' : 'bad'}">
        <span class="mark">${c.ok ? '✓' : '✗'}</span>
        <span>${esc(c.id)}</span>
        <span class="detail">${esc(c.detail ?? '')}</span>
      </li>`
    )
    .join('');
}

function verdictBox(status: string, when: string): string {
  const text =
    status === 'verified'
      ? 'VERIFIED — hardware attestation checks out'
      : status === 'simulated'
        ? 'SIMULATED — dev-root signed, no hardware protection'
        : 'FAILED — do not send anything you care about';
  return `<div class="verdict ${esc(status)}">${text}<span class="muted">${esc(when)}</span></div>`;
}

export async function renderListing(el: HTMLElement, params: Record<string, string>): Promise<() => void> {
  const id = params.id!;
  el.innerHTML = '<div class="muted small">Loading…</div>';
  let listing: Listing;
  try {
    listing = await api.listing(id);
  } catch {
    el.innerHTML = '<div class="error">Listing not found.</div>';
    return () => {};
  }
  document.title = `gpubnb — ${listing.gpu_model} · ${listing.model_id}`;
  let usdPerXmrMicro: number | null = null;
  void api
    .xmrRate()
    .then((r) => {
      usdPerXmrMicro = r.usd_per_xmr_micro;
      paintPrices();
    })
    .catch(() => {});

  const l = listing;
  const stats = l.stats;
  el.innerHTML = `
    ${l.simulated ? '<div class="sim-banner">SIMULATED — no hardware protection. This endpoint proves the plumbing under a public dev key. Never send anything private to it.</div>' : ''}
    <div class="listing-head">
      <div class="grow">
        <div class="eyebrow">${esc(l.region || 'region n/a')} · ${esc(l.cpu_tee.toUpperCase())} · runner ${esc(l.runner_version ?? '?')}</div>
        <h1>${esc(l.gpu_model)}</h1>
        <div class="mono" style="color:var(--ink-2)">${esc(l.model_id)} · ${fmtInt(l.ctx_len)} ctx · <a href="${esc(l.endpoint_url)}" rel="noopener nofollow">${esc(l.endpoint_url)}</a></div>
      </div>
      <div>${badge(l.trust_status)}</div>
    </div>

    <div class="card">
      <div class="kv">
        <dt>price in</dt><dd><span class="mono" id="p-in">${fmtXmr(l.price_in_piconero)}</span> <span class="muted small" id="p-in-usd"></span> <span class="muted small">/ 1M tokens</span></dd>
        <dt>price out</dt><dd><span class="mono" id="p-out">${fmtXmr(l.price_out_piconero)}</span> <span class="muted small" id="p-out-usd"></span> <span class="muted small">/ 1M tokens</span></dd>
        <dt>model digest</dt><dd class="mono" title="${esc(l.model_digest ?? '')}">${shortHex(l.model_digest, 12)}</dd>
        <dt>hpke_pub</dt><dd class="mono" title="${esc(l.hpke_pub ?? '')}">${esc(l.hpke_pub ?? '—')}</dd>
        <dt>sign_pub</dt><dd class="mono" title="${esc(l.sign_pub ?? '')}">${esc(l.sign_pub ?? '—')}</dd>
        <dt>heartbeat</dt><dd>${ago(l.last_heartbeat)}${stats ? ` · ${stats.sessions_open} sessions open · ${fmtInt(stats.tokens_in_total)} in / ${fmtInt(stats.tokens_out_total)} out · up ${fmtUptime(stats.uptime_s)}` : ''}</dd>
        <dt>marketplace verdict</dt><dd>${l.verdict ? `${esc(l.verdict.status)} · ${l.verdict.checks.filter((c) => c.ok).length}/${l.verdict.checks.length} checks · ${ago(l.verified_at)}` : 'none yet'}</dd>
        <dt>disputes</dt><dd>${l.disputes ?? 0} filed</dd>
      </div>
    </div>

    <div class="panels" style="margin-top:16px">
      <section class="card" id="verify-panel">
        <div class="section-head" style="margin-top:0"><span class="num">01</span><h2>Verify in your browser</h2></div>
        <p class="small muted">Fetches a fresh attestation doc from the runner with a challenge this page just generated,
        then re-runs every check locally with the AMD ARK / NVIDIA NRAS roots and the offline golden-signing key
        pinned in <code>@gpubnb/client</code>. Nothing here depends on trusting gpubnb.</p>
        <div class="row">
          <button class="btn" id="verify-btn">Verify now</button>
          <button class="btn secondary small" id="verify-mp-btn">Show marketplace verdict</button>
        </div>
        <div id="verify-out" style="margin-top:12px"></div>
      </section>

      <section class="card" id="chat-panel">
        <div class="section-head" style="margin-top:0"><span class="num">02</span><h2>Pay and chat</h2></div>
        <div id="chat-out"><p class="small muted">Connecting opens an HPKE session sealed to the attested <code>hpke_pub</code>; the runner answers with
        a per-session Monero subaddress. Pay any amount, wait for confirmations, then chat. Receipts arrive signed
        inside the encrypted stream.</p>
        <button class="btn" id="connect-btn">Connect</button></div>
      </section>
    </div>

    <section class="section">
      <div class="section-head"><span class="num">03</span><h2>Something went wrong with a paid session?</h2></div>
      <p class="small muted">File the runner-signed session offer and your transaction proof. The marketplace cannot refund
      (it never held the money), but disputes are counted on the listing for everyone to see.</p>
      <form id="dispute-form" class="card">
        <label class="field"><span>session offer (signed blob JSON)</span><textarea id="d-offer" placeholder='{"payload":"…","sig":"…"}'></textarea></label>
        <label class="field"><span>tx proof (tx key / OutProof)</span><textarea id="d-proof"></textarea></label>
        <label class="field"><span>note (optional)</span><input type="text" id="d-note" maxlength="500" /></label>
        <div class="row"><button class="btn secondary" type="submit">File dispute</button><span id="d-msg" class="small muted"></span></div>
      </form>
    </section>`;

  function paintPrices(): void {
    const a = document.getElementById('p-in-usd');
    const b = document.getElementById('p-out-usd');
    if (a) a.textContent = fmtUsd(l.price_in_piconero, usdPerXmrMicro);
    if (b) b.textContent = fmtUsd(l.price_out_piconero, usdPerXmrMicro);
  }
  paintPrices();

  // ---- verify panel
  const vOut = el.querySelector<HTMLElement>('#verify-out')!;
  el.querySelector('#verify-mp-btn')!.addEventListener('click', () => {
    if (!l.verdict) {
      vOut.innerHTML = '<div class="notice">The marketplace has no verdict for this listing yet.</div>';
      return;
    }
    vOut.innerHTML = `${verdictBox(l.verdict.status, `marketplace · ${ago(l.verified_at)}`)}<ul class="checks">${checksHtml(l.verdict.checks)}</ul>`;
  });
  const vBtn = el.querySelector<HTMLButtonElement>('#verify-btn')!;
  vBtn.addEventListener('click', async () => {
    vBtn.disabled = true;
    vOut.innerHTML = '<div class="muted small mono">fetching attestation with a fresh challenge…</div>';
    try {
      const v = await verifyListingInBrowser(l);
      vOut.innerHTML = `${verdictBox(v.status, 'this browser · just now')}<ul class="checks">${checksHtml(v.checks)}</ul>`;
    } catch (err) {
      vOut.innerHTML = `<div class="error">Could not verify: ${esc((err as Error).message)}. The runner may be offline or blocking cross-origin reads.</div>`;
    } finally {
      vBtn.disabled = false;
    }
  });

  // ---- chat panel
  const cOut = el.querySelector<HTMLElement>('#chat-out')!;
  let client: Client | null = null;
  let statusTimer: ReturnType<typeof setInterval> | undefined;
  let history: { role: 'user' | 'assistant'; content: string }[] = [];
  let busy = false;

  const connectBtn = el.querySelector<HTMLButtonElement>('#connect-btn')!;
  connectBtn.addEventListener('click', () => void doConnect());

  async function doConnect(): Promise<void> {
    connectBtn.disabled = true;
    cOut.innerHTML = '<div class="muted small mono">verifying endpoint and opening a sealed session…</div>';
    try {
      const { client: c, verdict } = await connect(l);
      client = c;
      const stored = loadSession(l.endpoint_url);
      let resumed = false;
      if (stored) {
        try {
          restore(client, stored.data);
          await client.status();
          resumed = true;
        } catch {
          forgetSession(l.endpoint_url);
        }
      }
      if (!resumed) await client.openSession();
      saveSession(l.endpoint_url, l.id, client.exportSession());
      paintChat(resumed, verdict.status);
      await refreshStatus();
      statusTimer = setInterval(() => void refreshStatus(), 20_000);
    } catch (err) {
      cOut.innerHTML = `<div class="error">${esc((err as Error).message)}</div><button class="btn" id="connect-btn2">Try again</button>`;
      el.querySelector('#connect-btn2')?.addEventListener('click', () => void doConnect());
    }
  }

  function sessionInfo(): { subaddress: string; session_id: string } {
    const s = client!.exportSession();
    return { subaddress: s.subaddress, session_id: s.session_id };
  }

  function paintChat(resumed: boolean, verdictStatus: string): void {
    const { subaddress, session_id } = sessionInfo();
    const uri = buildMoneroUri(subaddress);
    cOut.innerHTML = `
      <div class="pay">
        <div class="qr">${subaddress ? qrSvg(uri) : ''}</div>
        <div>
          <div class="eyebrow">pay this session ${resumed ? '· resumed' : ''} · endpoint ${esc(verdictStatus)} just now</div>
          <div class="addr" data-copy="${esc(subaddress)}" title="tap to copy">${esc(subaddress || '(no subaddress)')}</div>
          <div class="row" style="margin-top:8px">
            <a class="btn xmr small" href="${esc(uri)}">Open in Cake Wallet</a>
            <button class="btn secondary small" id="copy-uri">Copy monero: link</button>
            <button class="btn secondary small" id="refresh-status">Refresh</button>
          </div>
          <p class="small muted" style="margin-top:8px">Credit lands after the runner's confirmation threshold (default 10 blocks, ~20 min).
          Keep top-ups small: the host controls availability, not the enclave.</p>
          <div class="balance" id="balance"><span class="muted">fetching status…</span></div>
          <div class="small muted mono">session ${esc(shortAddress(session_id || '—'))} · stored in this browser only ·
            <a href="#" id="forget">forget session</a></div>
        </div>
      </div>
      <div class="chatlog" id="chatlog"><div class="muted small">Say something. Tokens stream back sealed; the receipt under each answer is signed by the runner.</div></div>
      <form class="chatform" id="chatform">
        <textarea id="chat-in" class="grow" placeholder="Ask the attested model…" rows="2"></textarea>
        <button class="btn" type="submit" id="send">Send</button>
      </form>`;
    el.querySelector('#copy-uri')!.addEventListener('click', () => void copyText(uri));
    el.querySelector('#refresh-status')!.addEventListener('click', () => void refreshStatus());
    el.querySelector('#forget')!.addEventListener('click', (e) => {
      e.preventDefault();
      if (!confirm('Forget this session? Any unspent balance on it becomes unreachable from this browser.')) return;
      forgetSession(l.endpoint_url);
      client = null;
      clearInterval(statusTimer);
      cOut.innerHTML = '<button class="btn" id="connect-btn3">Connect</button>';
      el.querySelector('#connect-btn3')?.addEventListener('click', () => void doConnect());
    });
    const form = el.querySelector<HTMLFormElement>('#chatform')!;
    const input = el.querySelector<HTMLTextAreaElement>('#chat-in')!;
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      void send(input.value);
      input.value = '';
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        form.requestSubmit();
      }
    });
  }

  async function refreshStatus(): Promise<void> {
    if (!client) return;
    const box = document.getElementById('balance');
    if (!box) return;
    try {
      const s = (await client.status()) as {
        balance_piconero: number;
        credited_piconero: number;
        pending_piconero: number;
        cumulative_debit_piconero: number;
      };
      box.innerHTML = `
        <span><b>balance</b>${fmtXmr(s.balance_piconero, 8)}</span>
        <span><b>credited</b>${fmtXmr(s.credited_piconero, 8)}</span>
        <span><b>pending</b>${fmtXmr(s.pending_piconero, 8)}</span>
        <span><b>spent</b>${fmtXmr(s.cumulative_debit_piconero, 8)}</span>
        ${usdPerXmrMicro ? `<span><b>≈ usd</b>${fmtUsd(s.balance_piconero, usdPerXmrMicro)}</span>` : ''}`;
    } catch (err) {
      box.innerHTML = `<span style="color:var(--bad)">status failed: ${esc((err as Error).message)}</span>`;
    }
  }

  function receiptLine(r: Receipt | null): string {
    if (!r) return '';
    return `<span class="receipt">receipt #${r.seq} · ${r.tokens_in} in / ${r.tokens_out} out · debit ${fmtXmr(r.debit_piconero, 8)} · balance ${fmtXmr(r.balance_piconero, 8)}</span>`;
  }

  async function send(text: string): Promise<void> {
    const content = text.trim();
    if (!content || !client || busy) return;
    busy = true;
    const log = document.getElementById('chatlog')!;
    if (log.querySelector('.muted')) log.innerHTML = '';
    history.push({ role: 'user', content });
    log.insertAdjacentHTML('beforeend', `<div class="msg user">${esc(content)}</div>`);
    const bubble = document.createElement('div');
    bubble.className = 'msg assistant cursor';
    log.appendChild(bubble);
    log.scrollTop = log.scrollHeight;
    let answer = '';
    let receipt: Receipt | null = null;
    try {
      for await (const ev of client.chatStream({ model: l.model_id, messages: history, stream: true })) {
        if (ev.t === 'chunk') {
          const data = ev.data as { choices?: { delta?: { content?: string } }[] };
          const delta = data.choices?.[0]?.delta?.content ?? '';
          if (delta) {
            answer += delta;
            bubble.textContent = answer;
            log.scrollTop = log.scrollHeight;
          }
        } else if (ev.t === 'response') {
          const data = ev.data as { choices?: { message?: { content?: string } }[] };
          answer = data.choices?.[0]?.message?.content ?? answer;
          bubble.textContent = answer;
        } else if (ev.t === 'receipt') {
          receipt = receiptPayload(ev.receipt);
        } else if (ev.t === 'error') {
          throw new Error(`${ev.code}: ${ev.message}`);
        }
      }
      history.push({ role: 'assistant', content: answer });
      bubble.classList.remove('cursor');
      bubble.innerHTML = `${esc(answer)}${receiptLine(receipt)}`;
    } catch (err) {
      bubble.classList.remove('cursor');
      bubble.className = 'msg err';
      bubble.textContent = (err as Error).message;
      history.pop();
    } finally {
      busy = false;
      log.scrollTop = log.scrollHeight;
      void refreshStatus();
      if (client) saveSession(l.endpoint_url, l.id, client.exportSession());
    }
  }

  // ---- disputes
  el.querySelector<HTMLFormElement>('#dispute-form')!.addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = document.getElementById('d-msg')!;
    try {
      const offer = JSON.parse((document.getElementById('d-offer') as HTMLTextAreaElement).value) as {
        payload: string;
        sig: string;
        kid?: string;
      };
      const tx_proof = (document.getElementById('d-proof') as HTMLTextAreaElement).value.trim();
      const note = (document.getElementById('d-note') as HTMLInputElement).value.trim();
      const { id: did } = await api.dispute({ listing_id: l.id, offer, tx_proof, note });
      msg.textContent = `filed (${did}).`;
    } catch (err) {
      msg.textContent = `not filed: ${(err as Error).message}`;
    }
  });

  return () => {
    clearInterval(statusTimer);
  };
}
