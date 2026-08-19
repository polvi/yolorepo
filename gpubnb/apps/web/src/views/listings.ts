import { api, type Listing } from '../lib/api';
import { ago, badge, esc, fmtUsd, fmtXmr } from '../lib/format';

const SIM_KEY = 'gpubnb.showSimulated';

export function listingCard(l: Listing, usdPerXmrMicro: number | null): string {
  const price = (p: number, lbl: string) => `
    <div>
      <div class="lbl">${lbl} / 1M tok</div>
      <div class="amt">${fmtXmr(p)}</div>
      <div class="usd">${fmtUsd(p, usdPerXmrMicro) || '&nbsp;'}</div>
    </div>`;
  return `
    <a class="lcard ${l.simulated ? 'sim' : ''}" href="#/l/${esc(l.id)}">
      ${l.simulated ? '<div class="sim-strip">simulated — no hardware protection</div>' : ''}
      <div class="head">
        <div>
          <div class="gpu">${esc(l.gpu_model)}</div>
          <div class="model">${esc(l.model_id)} · ${esc(String(l.ctx_len))} ctx</div>
        </div>
        ${badge(l.trust_status)}
      </div>
      <div class="price">
        ${price(l.price_in_piconero, 'in')}
        ${price(l.price_out_piconero, 'out')}
      </div>
      <div class="foot">
        <span>${esc(l.region || 'region n/a')}</span>
        <span>${esc(l.cpu_tee.toUpperCase())}</span>
        <span>hb ${ago(l.last_heartbeat)}</span>
        ${l.stats ? `<span>${l.stats.sessions_open} open</span>` : ''}
        ${l.disputes ? `<span style="color:var(--bad)">${l.disputes} dispute${l.disputes === 1 ? '' : 's'}</span>` : ''}
      </div>
    </a>`;
}

export async function renderListings(el: HTMLElement): Promise<() => void> {
  document.title = 'gpubnb — listings';
  const showSim = localStorage.getItem(SIM_KEY) === '1';
  el.innerHTML = `
    <div class="section-head"><span class="num">directory</span><h2>Attested endpoints</h2></div>
    <div class="filters">
      <input type="search" id="f-gpu" placeholder="GPU (e.g. RTX PRO 6000)" autocomplete="off" />
      <input type="search" id="f-model" placeholder="model (e.g. Qwen3)" autocomplete="off" />
      <select id="f-status" style="width:auto">
        <option value="">any status</option>
        <option value="verified">verified</option>
        <option value="stale">stale</option>
        <option value="offline">offline</option>
        <option value="failed">failed</option>
        <option value="simulated">simulated</option>
      </select>
      <label class="toggle"><input type="checkbox" id="f-sim" ${showSim ? 'checked' : ''}/> show simulated</label>
    </div>
    <div id="list" class="grid"><div class="muted small">Loading…</div></div>`;

  const gpu = el.querySelector<HTMLInputElement>('#f-gpu')!;
  const model = el.querySelector<HTMLInputElement>('#f-model')!;
  const status = document.getElementById('f-status') as unknown as HTMLSelectElement;
  const sim = el.querySelector<HTMLInputElement>('#f-sim')!;
  const list = el.querySelector<HTMLElement>('#list')!;

  let usdPerXmrMicro: number | null = null;
  void api
    .xmrRate()
    .then((r) => {
      usdPerXmrMicro = r.usd_per_xmr_micro;
      void load();
    })
    .catch(() => {});

  let seq = 0;
  async function load(): Promise<void> {
    const my = ++seq;
    localStorage.setItem(SIM_KEY, sim.checked ? '1' : '0');
    const wantSim = sim.checked || status.value === 'simulated';
    try {
      const { listings } = await api.listings({
        simulated: wantSim,
        gpu: gpu.value.trim(),
        model: model.value.trim(),
        status: status.value,
      });
      if (my !== seq) return;
      if (!listings.length) {
        list.innerHTML = `<div class="notice">Nothing matches. ${
          wantSim ? '' : 'Simulated dev endpoints are hidden by default; flip the toggle to see them.'
        }</div>`;
        return;
      }
      list.innerHTML = listings.map((l) => listingCard(l, usdPerXmrMicro)).join('');
    } catch (err) {
      if (my === seq) list.innerHTML = `<div class="error">${esc((err as Error).message)}</div>`;
    }
  }

  let t: ReturnType<typeof setTimeout> | undefined;
  const debounced = () => {
    clearTimeout(t);
    t = setTimeout(() => void load(), 220);
  };
  gpu.addEventListener('input', debounced);
  model.addEventListener('input', debounced);
  status.addEventListener('change', () => void load());
  sim.addEventListener('change', () => void load());
  await load();
  const refresh = setInterval(() => void load(), 60_000);
  return () => {
    clearInterval(refresh);
    clearTimeout(t);
  };
}
