import { api, ApiError, type GroupDetail, type Me, type Member } from './lib/api';
import { friendlyAuthError, passkeyCreateAccount, passkeySignIn } from './lib/authg';
import { buildMoneroUri, piconeroToXmr, tabMicroToPiconero } from './lib/moneroUri';
import { qrSvg } from './lib/qr';

const app = document.getElementById('app')!;
let me: Me | null = null;

// Invite deep link: /join/<token> serves this SPA when signed out; the token
// rides along until the in-page auth completes, then the join happens via API.
let joinToken: string | null = null;
{
  const m = location.pathname.match(/^\/join\/([\w-]+)$/);
  if (m) joinToken = m[1]!;
}

async function completeJoin(): Promise<void> {
  if (!joinToken) return;
  const token = joinToken;
  joinToken = null;
  history.replaceState(null, '', '/');
  try {
    const { group_id } = await api.join(token);
    location.hash = `#/g/${group_id}`;
  } catch (err) {
    showError(err);
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function fmtTab(tabMicro: number): string {
  const sign = tabMicro < 0 ? '-' : '';
  const abs = Math.abs(tabMicro);
  const whole = Math.floor(abs / 100_000);
  const cents = Math.round((abs % 100_000) / 1000);
  return `${sign}${whole}.${String(cents).padStart(2, '0')}`;
}

function fmtUsd(tabMicro: number): string {
  return (Math.abs(tabMicro) / 10_000).toLocaleString(undefined, {
    style: 'currency',
    currency: 'USD',
  });
}

// XMR leads everywhere a balance or transfer is shown; TAB and USD ride
// along muted as the neutral comparison. Display only — payments record the
// exact piconero integer separately.
function fmtXmr(tabMicro: number, rateTabMicroPerXmr: number): string {
  const xmr = Math.abs(tabMicro) / rateTabMicroPerXmr;
  if (xmr > 0 && xmr < 0.00001) return '<0.00001 XMR';
  const s = xmr
    .toFixed(xmr >= 1 ? 4 : 5)
    .replace(/(\.\d\d[\d]*?)0+$/, '$1');
  return `${s} XMR`;
}

// The muted companion to every XMR amount is ONE conversion currency,
// tappable to cycle TAB → USD → CAD. The choice persists on the user row.
// TAB shows as whole TABs, its point as a coarse neutral unit.
let usdPerCadRate: number | null = null;

function rememberCadRate(rate: { usd_per_cad?: number } | null): void {
  if (rate?.usd_per_cad) usdPerCadRate = rate.usd_per_cad;
}

const PREF_CYCLE = ['TAB', 'USD', 'CAD'] as const;

function fmtConversion(tabMicro: number): string {
  const abs = Math.abs(tabMicro);
  const pref = me?.pref_currency ?? 'TAB';
  if (pref === 'USD') return fmtUsd(tabMicro);
  if (pref === 'CAD' && usdPerCadRate) {
    return (abs / 10_000 / usdPerCadRate).toLocaleString(undefined, {
      style: 'currency',
      currency: 'CAD',
    });
  }
  if (pref === 'CAD') return fmtUsd(tabMicro); // CAD rate unavailable
  const whole = Math.round(abs / 100_000);
  return whole === 0 && abs > 0 ? '<1 TAB' : `${whole} TAB`;
}

// data-conv marks a chip; one delegated listener (set up at boot) cycles the
// preference, re-renders optimistically, and persists in the background.
function convChip(tabMicro: number): string {
  return `<button class="conv" type="button" data-conv
    title="Switch conversion currency">${fmtConversion(tabMicro)}</button>`;
}

app.addEventListener('click', (e) => {
  const chip = (e.target as HTMLElement).closest('[data-conv]');
  if (!chip || !me) return;
  e.preventDefault();
  e.stopPropagation();
  const next = PREF_CYCLE[(PREF_CYCLE.indexOf(me.pref_currency) + 1) % PREF_CYCLE.length]!;
  me.pref_currency = next;
  void api.updateMe({ pref_currency: next }).catch(() => {});
  void route().catch(showError);
});

function memberName(members: Member[], id: string): string {
  const m = members.find((x) => x.id === id);
  if (!m) return 'someone';
  if (me && id === me.user_id) return 'you';
  return m.display_name || `friend-${id.slice(0, 4)}`;
}

function fmtWhen(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// Amount string ("12.34") → integer minor units, or null when malformed.
function parseAmountMinor(raw: string): number | null {
  const m = raw.trim().match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!m) return null;
  const minor = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || '0');
  return minor > 0 ? minor : null;
}

function showError(err: unknown): void {
  const box = document.getElementById('error-box');
  const message =
    err instanceof ApiError ? err.message : 'Something went wrong, please try again.';
  if (box) {
    box.textContent = message;
    box.classList.remove('hidden');
    box.scrollIntoView({ block: 'nearest' });
  } else {
    alert(message);
  }
}

// ---------------------------------------------------------------- routing

async function route(): Promise<void> {
  const hash = location.hash.replace(/^#/, '');
  if (me === null) {
    await renderHome();
    return;
  }

  const groupAdd = hash.match(/^\/g\/([\w-]+)\/add$/);
  const groupEdit = hash.match(/^\/g\/([\w-]+)\/edit\/([\w-]+)$/);
  const group = hash.match(/^\/g\/([\w-]+)$/);
  if (groupAdd) await renderExpenseForm(groupAdd[1]!);
  else if (groupEdit) await renderExpenseForm(groupEdit[1]!, groupEdit[2]!);
  else if (group) await renderGroup(group[1]!);
  else if (hash === '/profile') renderProfile();
  else await renderGroups();
}

// ---------------------------------------------------------------- screens

async function renderHome(): Promise<void> {
  document.title = 'tabby — split the trip, settle in Monero';
  const tagline = joinToken
    ? "You're invited to split a trip on tabby. Sign in or create an account with a passkey to join."
    : 'Split trip expenses with friends. Everyone gets one simple Monero payment to make, straight into Cake Wallet.';
  app.innerHTML = `
    <div class="home">
      <canvas id="home-canvas" aria-hidden="true"></canvas>
      <div class="overlay">
        <div class="wordmark">tabby<span class="paw">.</span></div>
        <p class="tagline">${tagline}</p>
        <div class="cta">
          <button class="btn" id="cta-register">Create account</button>
          <button class="btn secondary" id="cta-signin">Sign in</button>
        </div>
        <p id="auth-error" class="muted hidden" style="color:var(--neg); margin-top:12px;"></p>
      </div>
    </div>`;

  // Both buttons run the WebAuthn ceremony against AuthGravity right here;
  // there is no hosted auth screen in this flow.
  const authError = document.getElementById('auth-error')!;
  const wire = (id: string, ceremony: () => Promise<void>) => {
    const btn = document.getElementById(id) as HTMLButtonElement;
    btn.addEventListener('click', async () => {
      authError.classList.add('hidden');
      btn.disabled = true;
      try {
        await ceremony();
        me = await api.me();
        await completeJoin();
        await route();
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

  const canvas = document.getElementById('home-canvas') as HTMLCanvasElement;
  const { startHomeScene } = await import('./home');
  startHomeScene(canvas);
}

// Not having an address never blocks using tabby; it only means nobody can
// pay you yet, so surface a nudge wherever balances live.
function addressNudge(): string {
  if (me?.xmr_address) return '';
  return `
    <a class="card row" style="text-decoration:none; color:inherit; border-color:var(--accent);"
      href="#/profile">
      <div class="grow">
        <strong>Friends can't pay you yet</strong>
        <div class="muted">Add your Monero address so payments can reach you.</div>
      </div>
      <span style="color:var(--accent); font-size:1.2rem;">›</span>
    </a>`;
}

// Until a display name is set, friends see an anonymous placeholder, so ask
// for one inline; saving re-renders in place.
function nameNudge(): string {
  if (me?.display_name) return '';
  return `
    <form class="card" id="name-nudge">
      <strong style="display:block; margin-bottom:8px;">What should friends call you?</strong>
      <div class="row">
        <input type="text" id="name-nudge-input" class="grow" placeholder="e.g. Alex"
          maxlength="40" autocomplete="name" required />
        <button class="btn small" type="submit">Save</button>
      </div>
    </form>`;
}

function wireNameNudge(): void {
  const form = document.getElementById('name-nudge');
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = (document.getElementById('name-nudge-input') as HTMLInputElement).value.trim();
    if (!name) return;
    try {
      me = await api.updateMe({ display_name: name });
      await route();
    } catch (err) {
      showError(err);
    }
  });
}

async function renderGroups(): Promise<void> {
  document.title = 'tabby — your groups';
  const [{ groups }, rate] = await Promise.all([api.groups(), api.xmrRate().catch(() => null)]);
  rememberCadRate(rate);
  const inXmr = (net: number) =>
    rate ? fmtXmr(net, rate.xmr_rate_tab_micro) : `${fmtTab(Math.abs(net))} TAB`;
  const list = groups
    .map((g) => {
      const net = g.your_net_tab_micro;
      const netLine =
        net === 0
          ? '<span class="muted">settled up</span>'
          : net > 0
            ? `<span class="pos">you're owed ${inXmr(net)}</span>`
            : `<span class="neg">you owe ${inXmr(net)}</span>`;
      return `
        <a class="card row" style="text-decoration:none; color:inherit;" href="#/g/${g.id}">
          <div class="grow">
            <strong>${esc(g.name)}</strong>
            <div class="muted">${g.member_count} ${g.member_count === 1 ? 'member' : 'members'}</div>
          </div>
          <div class="amount">${netLine}</div>
        </a>`;
    })
    .join('');

  app.innerHTML = `
    <div class="topbar">
      <h1 class="grow" style="margin:0;">Your trips</h1>
      <a class="back" href="#/profile" aria-label="Profile">☰</a>
    </div>
    <div id="error-box" class="error hidden"></div>
    ${nameNudge()}
    ${addressNudge()}
    ${list || '<p class="muted">No trips yet. Start one and share the invite link.</p>'}
    <form id="new-group" class="row" style="margin-top:16px;">
      <input type="text" id="group-name" class="grow" placeholder="New trip name"
        maxlength="80" required />
      <button class="btn small" type="submit">Create</button>
    </form>`;

  wireNameNudge();
  document.getElementById('new-group')!.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = (document.getElementById('group-name') as HTMLInputElement).value.trim();
    if (!name) return;
    try {
      const { id } = await api.createGroup(name);
      location.hash = `#/g/${id}`;
    } catch (err) {
      showError(err);
    }
  });
}

async function renderGroup(groupId: string): Promise<void> {
  let detail: GroupDetail;
  try {
    detail = await api.group(groupId);
  } catch (err) {
    if (err instanceof ApiError && (err.status === 403 || err.status === 404)) {
      location.hash = '#/';
      return;
    }
    throw err;
  }
  document.title = `tabby — ${detail.group.name}`;
  const rate = await api.xmrRate().catch(() => null);
  rememberCadRate(rate);
  const myId = me!.user_id;
  const myNet = detail.nets.find((n) => n.user_id === myId)?.net_tab_micro ?? 0;

  const inXmr = (net: number) =>
    rate ? fmtXmr(net, rate.xmr_rate_tab_micro) : `${fmtTab(Math.abs(net))} TAB`;
  const headline =
    myNet === 0
      ? `<h2 class="muted" style="margin:0;">You're settled up 🐈</h2>`
      : myNet > 0
        ? `<h2 class="pos" style="margin:0;">You're owed ${inXmr(myNet)} <span class="muted">(</span>${convChip(myNet)}<span class="muted">)</span></h2>`
        : `<h2 class="neg" style="margin:0;">You owe ${inXmr(myNet)} <span class="muted">(</span>${convChip(myNet)}<span class="muted">)</span></h2>`;

  const transferCards = detail.transfers
    .map((t, i) => {
      const fromName = memberName(detail.members, t.from);
      const toName = memberName(detail.members, t.to);
      const line = `<div class="row">
          <div class="grow"><strong>${esc(fromName)}</strong> → <strong>${esc(toName)}</strong></div>
          <div style="text-align:right;">
            <div class="amount">${inXmr(t.amount_tab_micro)}</div>
            <div>${convChip(t.amount_tab_micro)}</div>
          </div>
        </div>`;
      if (t.from !== myId) return `<div class="card transfer">${line}</div>`;

      // Settling in cash needs no address and no rate, so the button rides
      // along on every outgoing transfer card.
      const cashBtn = `<button class="btn ghost" style="margin-top:10px;" data-cash="${i}"
          data-uuid-cash="${crypto.randomUUID()}">💵 I paid this in cash</button>`;
      const payee = detail.members.find((m) => m.id === t.to);
      if (!payee?.xmr_address) {
        return `<div class="card transfer">${line}
          <p class="muted" style="margin:10px 0 0;">${esc(toName)} hasn't added a Monero address yet.</p>
          ${cashBtn}
        </div>`;
      }
      if (!rate) {
        return `<div class="card transfer">${line}
          <p class="muted" style="margin:10px 0 0;">XMR rate unavailable right now — try again shortly.</p>
          ${cashBtn}
        </div>`;
      }
      const piconero = tabMicroToPiconero(t.amount_tab_micro, rate.xmr_rate_tab_micro);
      const uri = buildMoneroUri(
        payee.xmr_address,
        piconero,
        `tabby ${detail.group.name} ${fromName} to ${toName}`
      );
      return `<div class="card transfer">${line}
        <p class="muted" style="margin:10px 0 12px;">${piconeroToXmr(piconero)} XMR exact,
          at today's rate, to ${esc(toName)}</p>
        <a class="btn" href="${esc(uri)}">Pay</a>
        <div class="qr" aria-label="Scan with your Monero wallet">${qrSvg(uri)}</div>
        <button class="btn ghost" style="margin-top:10px;" data-pay="${i}"
          data-uuid="${crypto.randomUUID()}">I paid this</button>
        ${cashBtn}
      </div>`;
    })
    .join('');

  // Cash settles out-of-band: "they handed me $300" gets applied straight to
  // their balance. Any member can record any payer → recipient pair, so the
  // trip treasurer can log everyone's bills and ghosts fit on either side.
  const firstOther = detail.members.find((m) => m.id !== myId);
  let cashCurrency = 'USD';
  const memberOptions = (selectedId: string) =>
    detail.members
      .map(
        (m) => `<option value="${m.id}" ${m.id === selectedId ? 'selected' : ''}>
          ${esc(memberName(detail.members, m.id))}</option>`
      )
      .join('');
  const cashCard = firstOther
    ? `<details class="card">
        <summary>💵 Record a cash payment</summary>
        <form id="cash-form" style="margin-top:12px;">
          <label class="field">
            <span>Who paid cash?</span>
            <select id="cash-from">${memberOptions(firstOther.id)}</select>
          </label>
          <label class="field">
            <span>Who received it?</span>
            <select id="cash-to">${memberOptions(myId)}</select>
          </label>
          <label class="field">
            <span>Amount</span>
            <input type="text" id="cash-amount" placeholder="0.00"
              inputmode="decimal" autocomplete="off" required />
          </label>
          <div class="segmented" id="cash-currency" style="margin-bottom:12px;">
            ${['USD', 'CAD', 'TAB']
              .map(
                (cur) => `<button type="button" data-cur="${cur}"
                  class="${cur === cashCurrency ? 'active' : ''}">${cur}</button>`
              )
              .join('')}
          </div>
          <button class="btn" type="submit">Record payment</button>
        </form>
      </details>`
    : '';

  const expenseFeed = detail.expenses
    .map(
      (x) => `
      <div class="feed-item">
        <a class="grow" href="#/g/${groupId}/edit/${x.id}"
          style="text-decoration:none; color:inherit; min-height:44px; display:block;">
          <strong>${esc(x.description)}</strong>
          <div class="muted">${esc(memberName(detail.members, x.paid_by))} paid ·
            split ${x.participants.length} ways · ${fmtWhen(x.created_at)}</div>
        </a>
        <span class="amount">${(x.amount_minor / 100).toFixed(2)} ${esc(x.currency)}</span>
        <button class="del" data-del="${x.id}" aria-label="Delete expense">✕</button>
      </div>`
    )
    .join('');

  const paymentFeed = detail.payments
    .map((p) => {
      const amountCol =
        p.method === 'cash'
          ? p.amount_minor != null
            ? `💵 ${(p.amount_minor / 100).toFixed(2)} ${esc(p.currency ?? '')}`
            : '💵 cash'
          : `${piconeroToXmr(BigInt(p.xmr_amount_piconero))} XMR`;
      return `
      <div class="feed-item">
        <div class="grow">
          <strong>${esc(memberName(detail.members, p.from_user))} paid
            ${esc(memberName(detail.members, p.to_user))}</strong>
          <div class="muted">${convChip(p.amount_tab_micro)} · ${fmtWhen(p.created_at)}</div>
        </div>
        <span class="amount">${amountCol}</span>
      </div>`;
    })
    .join('');

  const ghosts = detail.members.filter((m) => m.is_ghost);
  const claimCard = ghosts.length
    ? `<div class="card">
        <span class="muted">Added by name, not signed in yet:</span>
        ${ghosts
          .map(
            (g) => `<div class="row" style="margin-top:8px;">
              <span class="grow">${esc(g.display_name ?? 'someone')}</span>
              <button class="btn small ghost" data-claim="${g.id}"
                data-claim-name="${esc(g.display_name ?? 'someone')}">This is me</button>
            </div>`
          )
          .join('')}
      </div>`
    : '';

  app.innerHTML = `
    <div class="topbar">
      <a class="back" href="#/" aria-label="Back">‹</a>
      <div class="grow">
        <h1 style="margin:0;">${esc(detail.group.name)}</h1>
      </div>
      <button class="back" id="invite-btn" aria-label="Invite friends" style="border:none;">＋👥</button>
    </div>
    <div id="error-box" class="error hidden"></div>
    <div class="card">${headline}</div>
    ${nameNudge()}
    ${addressNudge()}
    ${claimCard}
    ${
      detail.transfers.length === 0 && !cashCard
        ? ''
        : detail.group.settling
          ? `<h2>Settle up</h2>${transferCards}${cashCard}
             <p style="text-align:center; margin:4px 0 16px;">
               <button class="conv" id="settle-toggle">More expenses coming? Reopen the tab</button>
             </p>`
          : `<div class="card" style="text-align:center;">
               <p class="muted" style="margin:0 0 12px;">Settle-up is hidden until everyone
                 agrees the expenses are all in.</p>
               <button class="btn" id="settle-toggle">Everyone's in, settle up</button>
             </div>`
    }
    <h2>Expenses</h2>
    <div class="card">${expenseFeed || '<p class="muted" style="margin:0;">Nothing yet — add the first expense.</p>'}</div>
    ${paymentFeed ? `<h2>Payments</h2><div class="card">${paymentFeed}</div>` : ''}
    <a class="btn fab" href="#/g/${groupId}/add">＋ Add expense</a>`;

  wireNameNudge();
  document.getElementById('settle-toggle')?.addEventListener('click', async () => {
    try {
      await api.setSettling(groupId, !detail.group.settling);
      await renderGroup(groupId);
    } catch (err) {
      showError(err);
    }
  });
  document.getElementById('invite-btn')!.addEventListener('click', async () => {
    const url = `${location.origin}/join/${detail.group.invite_token}`;
    if (navigator.share) {
      await navigator.share({ title: `Join ${detail.group.name} on tabby`, url }).catch(() => {});
    } else {
      await navigator.clipboard.writeText(url);
      alert('Invite link copied.');
    }
  });

  for (const btn of app.querySelectorAll<HTMLButtonElement>('[data-pay]')) {
    btn.addEventListener('click', async () => {
      const t = detail.transfers[Number(btn.dataset.pay)]!;
      if (!confirm(`Record that you paid ${memberName(detail.members, t.to)} ${inXmr(t.amount_tab_micro)}?`)) return;
      btn.disabled = true;
      try {
        await api.addPayment(groupId, {
          id: btn.dataset.uuid!,
          to_user: t.to,
          amount_tab_micro: t.amount_tab_micro,
          xmr_amount_piconero: Number(tabMicroToPiconero(t.amount_tab_micro, rate!.xmr_rate_tab_micro)),
          xmr_rate_tab_micro: rate!.xmr_rate_tab_micro,
        });
        await renderGroup(groupId);
      } catch (err) {
        btn.disabled = false;
        showError(err);
      }
    });
  }

  for (const btn of app.querySelectorAll<HTMLButtonElement>('[data-cash]')) {
    btn.addEventListener('click', async () => {
      const t = detail.transfers[Number(btn.dataset.cash)]!;
      if (
        !confirm(
          `Record that you paid ${memberName(detail.members, t.to)} ${fmtConversion(t.amount_tab_micro)} in cash?`
        )
      )
        return;
      btn.disabled = true;
      try {
        await api.addPayment(groupId, {
          method: 'cash',
          id: btn.dataset.uuidCash!,
          to_user: t.to,
          amount_tab_micro: t.amount_tab_micro,
        });
        await renderGroup(groupId);
      } catch (err) {
        btn.disabled = false;
        showError(err);
      }
    });
  }

  document.getElementById('cash-currency')?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('button[data-cur]');
    if (!btn) return;
    cashCurrency = btn.getAttribute('data-cur')!;
    for (const b of document.querySelectorAll('#cash-currency button')) {
      b.classList.toggle('active', b === btn);
    }
  });

  document.getElementById('cash-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const from = (document.getElementById('cash-from') as unknown as HTMLSelectElement).value;
    const to = (document.getElementById('cash-to') as unknown as HTMLSelectElement).value;
    if (from === to) {
      showError(new ApiError(400, 'Pick two different people.'));
      return;
    }
    const amountMinor = parseAmountMinor(
      (document.getElementById('cash-amount') as HTMLInputElement).value
    );
    if (amountMinor === null) {
      showError(new ApiError(400, 'Enter an amount like 300 or 12.50.'));
      return;
    }
    try {
      await api.addPayment(groupId, {
        method: 'cash',
        id: crypto.randomUUID(),
        from_user: from,
        to_user: to,
        currency: cashCurrency,
        amount_minor: amountMinor,
      });
      await renderGroup(groupId);
    } catch (err) {
      showError(err);
    }
  });

  for (const btn of app.querySelectorAll<HTMLButtonElement>('[data-claim]')) {
    btn.addEventListener('click', async () => {
      const name = btn.dataset.claimName!;
      if (!confirm(`Claim ${name}'s expenses as yours? This folds their balance into your account.`))
        return;
      btn.disabled = true;
      try {
        await api.claimGhost(groupId, btn.dataset.claim!);
        await renderGroup(groupId);
      } catch (err) {
        btn.disabled = false;
        showError(err);
      }
    });
  }

  for (const btn of app.querySelectorAll<HTMLButtonElement>('[data-del]')) {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this expense? Balances will recalculate.')) return;
      try {
        await api.deleteExpense(groupId, btn.dataset.del!);
        await renderGroup(groupId);
      } catch (err) {
        showError(err);
      }
    });
  }
}

// One form for both adding and editing. Editing is open to every member
// (the whole point is fixing who a split is with, no matter who entered it).
async function renderExpenseForm(groupId: string, expenseId?: string): Promise<void> {
  const detail = await api.group(groupId);
  const existing = expenseId ? detail.expenses.find((x) => x.id === expenseId) : undefined;
  if (expenseId && !existing) {
    location.hash = `#/g/${groupId}`;
    return;
  }
  document.title = `tabby — ${existing ? 'edit' : 'add'} expense`;
  const myId = me!.user_id;
  let currency = existing?.currency ?? 'USD';
  const defaultPayer = existing?.paid_by ?? myId;
  const isSplitWith = (id: string) => (existing ? existing.participants.includes(id) : true);

  app.innerHTML = `
    <div class="topbar">
      <a class="back" href="#/g/${groupId}" aria-label="Back">‹</a>
      <h1 style="margin:0;">${existing ? 'Edit expense' : 'Add expense'}</h1>
    </div>
    <div id="error-box" class="error hidden"></div>
    <form id="expense-form">
      <label class="field">
        <span>What was it?</span>
        <input type="text" id="x-desc" placeholder="Tacos, gas, cabin…" maxlength="200" required
          value="${esc(existing?.description ?? '')}" />
      </label>
      <label class="field">
        <span>Amount</span>
        <input type="text" id="x-amount" placeholder="0.00" inputmode="decimal"
          autocomplete="off" required
          value="${existing ? (existing.amount_minor / 100).toFixed(2) : ''}" />
      </label>
      <div class="field">
        <span style="display:block; margin-bottom:6px;" class="muted">Currency</span>
        <div class="segmented" id="x-currency">
          ${['USD', 'CAD', 'TAB']
            .map(
              (cur) =>
                `<button type="button" data-cur="${cur}"
                  class="${cur === currency ? 'active' : ''}">${cur}</button>`
            )
            .join('')}
        </div>
        <p class="muted" id="cur-hint" style="margin:6px 0 0;"></p>
      </div>
      <label class="field">
        <span>Paid by</span>
        <select id="x-paidby">
          ${detail.members
            .map(
              (m) =>
                `<option value="${m.id}" ${m.id === defaultPayer ? 'selected' : ''}>${esc(memberName(detail.members, m.id))}</option>`
            )
            .join('')}
        </select>
      </label>
      <div class="field">
        <span style="display:block; margin-bottom:6px;" class="muted">Split between</span>
        <div class="chips" id="x-participants">
          ${detail.members
            .map(
              (m) => `<label><input type="checkbox" value="${m.id}" ${isSplitWith(m.id) ? 'checked' : ''} />
                ${esc(memberName(detail.members, m.id))}</label>`
            )
            .join('')}
        </div>
        <div class="row" style="margin-top:10px;">
          <input type="text" id="x-ghost-name" class="grow" placeholder="Add someone by name"
            maxlength="40" autocomplete="off" />
          <button class="btn small secondary" type="button" id="x-ghost-add">Add</button>
        </div>
        <p class="muted" style="margin:6px 0 0;">
          No account needed. They can claim their expenses when they join.
        </p>
      </div>
      <button class="btn" type="submit">${existing ? 'Save changes' : 'Add expense'}</button>
    </form>`;

  // Ghost members join the chips and the paid-by select in place, keeping
  // whatever is already typed into the form.
  document.getElementById('x-ghost-add')!.addEventListener('click', async () => {
    const input = document.getElementById('x-ghost-name') as HTMLInputElement;
    const name = input.value.trim();
    if (!name) return;
    try {
      const { user_id } = await api.addGhost(groupId, name);
      const chip = document.createElement('label');
      chip.innerHTML = `<input type="checkbox" value="${user_id}" checked /> ${esc(name)}`;
      document.getElementById('x-participants')!.appendChild(chip);
      const option = document.createElement('option');
      option.value = user_id;
      option.textContent = name;
      (document.getElementById('x-paidby') as unknown as HTMLSelectElement).appendChild(option);
      input.value = '';
    } catch (err) {
      showError(err);
    }
  });

  const hint = document.getElementById('cur-hint')!;
  const updateHint = () => {
    hint.textContent = currency === 'TAB' ? '1 TAB = 10 USD' : '';
  };
  document.getElementById('x-currency')!.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('button[data-cur]');
    if (!btn) return;
    currency = btn.getAttribute('data-cur')!;
    for (const b of document.querySelectorAll('#x-currency button')) {
      b.classList.toggle('active', b === btn);
    }
    updateHint();
  });
  updateHint();

  document.getElementById('expense-form')!.addEventListener('submit', async (e) => {
    e.preventDefault();
    const description = (document.getElementById('x-desc') as HTMLInputElement).value.trim();
    const amountMinor = parseAmountMinor(
      (document.getElementById('x-amount') as HTMLInputElement).value
    );
    if (amountMinor === null) {
      showError(new ApiError(400, 'Enter an amount like 12.50.'));
      return;
    }
    const participantIds = [
      ...document.querySelectorAll<HTMLInputElement>('#x-participants input:checked'),
    ].map((i) => i.value);
    if (participantIds.length === 0) {
      showError(new ApiError(400, 'Pick at least one person to split with.'));
      return;
    }
    const payload = {
      description,
      currency,
      amount_minor: amountMinor,
      paid_by: (document.getElementById('x-paidby') as unknown as HTMLSelectElement).value,
      participant_ids: participantIds,
    };
    try {
      if (existing) {
        await api.updateExpense(groupId, existing.id, payload);
      } else {
        await api.addExpense(groupId, { id: crypto.randomUUID(), ...payload });
      }
      location.hash = `#/g/${groupId}`;
      if (location.hash === `#/g/${groupId}`) await route();
    } catch (err) {
      showError(err);
    }
  });
}

function renderProfile(): void {
  document.title = 'tabby — profile';
  app.innerHTML = `
    <div class="topbar">
      <a class="back" href="#/" aria-label="Back">‹</a>
      <h1 style="margin:0;">Profile</h1>
    </div>
    <div id="error-box" class="error hidden"></div>
    ${
      me!.xmr_address
        ? ''
        : `<div class="card">
            <strong>Copy your address from Cake Wallet</strong>
            <ol class="muted" style="margin:8px 0 0; padding-left:20px; line-height:1.7;">
              <li>Open <strong>Cake Wallet</strong> and pick your Monero wallet</li>
              <li>Tap <strong>Receive</strong></li>
              <li>Tap the address to copy it</li>
            </ol>
          </div>`
    }
    <form id="profile-form">
      <label class="field">
        <span>Display name (what friends see)</span>
        <input type="text" id="p-name" maxlength="40"
          value="${esc(me!.display_name ?? '')}" placeholder="e.g. Alex" />
      </label>
      <label class="field">
        <span>Monero address (from Cake Wallet → Receive)</span>
        <input type="text" id="p-address" autocomplete="off" autocapitalize="off"
          autocorrect="off" spellcheck="false"
          value="${esc(me!.xmr_address ?? '')}" placeholder="4…" />
      </label>
      <button class="btn" type="submit">Save</button>
    </form>`;
  document.getElementById('profile-form')!.addEventListener('submit', async (e) => {
    e.preventDefault();
    const display_name = (document.getElementById('p-name') as HTMLInputElement).value.trim();
    const xmr_address = (document.getElementById('p-address') as HTMLInputElement).value.trim();
    try {
      me = await api.updateMe({
        ...(display_name ? { display_name } : {}),
        ...(xmr_address ? { xmr_address } : {}),
      });
      location.hash = '#/';
    } catch (err) {
      showError(err);
    }
  });
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
  if (me) await completeJoin();
  await route().catch(showError);
})();
