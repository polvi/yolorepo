import { Hono } from 'hono';
import { z } from 'zod';
import { requireUser, resolveUser } from './auth';
import type { AppContext } from './env';
import * as db from './db';
import { llmsTxt } from './llms';
import { equalSplit, normalizeToTabMicro, tabMicroPerUnit, type Currency } from './money';
import { computeNets, settle } from './settle';
import { usdPerCad, xmrRateTabMicro } from './rates';

const XMR_ADDRESS_RE = /^[48][1-9A-HJ-NP-Za-km-z]{94}([1-9A-HJ-NP-Za-km-z]{11})?$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const profileSchema = z.object({
  display_name: z.string().trim().min(1).max(40).optional(),
  xmr_address: z.string().regex(XMR_ADDRESS_RE, 'not a Monero address').optional(),
  pref_currency: z.enum(['TAB', 'USD', 'CAD']).optional(),
});

const groupSchema = z.object({ name: z.string().trim().min(1).max(80) });

const expenseSchema = z.object({
  id: z.string().regex(UUID_RE),
  description: z.string().trim().min(1).max(200),
  currency: z.enum(['USD', 'CAD', 'TAB']),
  amount_minor: z.number().int().positive().max(100_000_000),
  paid_by: z.string().min(1),
  participant_ids: z.array(z.string().min(1)).min(1).max(50),
});

const ghostSchema = z.object({ name: z.string().trim().min(1).max(40) });
const claimSchema = z.object({ ghost_id: z.string().min(1) });

// XMR payments carry the exact on-chain amount and the rate they were quoted
// at; cash payments carry neither. Cash may name a from_user so the recipient
// can record "they handed me $300" (the only way a ghost member can settle),
// and states its amount either as exact µTAB (settling a suggested transfer)
// or as fiat currency + amount_minor, converted server-side like an expense.
const paymentSchema = z.union([
  z.object({
    method: z.literal('xmr'),
    id: z.string().regex(UUID_RE),
    to_user: z.string().min(1),
    amount_tab_micro: z.number().int().positive(),
    xmr_amount_piconero: z.number().int().positive(),
    xmr_rate_tab_micro: z.number().int().positive(),
  }),
  z
    .object({
      method: z.literal('cash'),
      id: z.string().regex(UUID_RE),
      from_user: z.string().min(1).optional(),
      to_user: z.string().min(1),
      amount_tab_micro: z.number().int().positive().optional(),
      currency: z.enum(['USD', 'CAD', 'TAB']).optional(),
      amount_minor: z.number().int().positive().max(100_000_000).optional(),
    })
    .refine(
      (p) =>
        p.amount_tab_micro !== undefined
          ? p.currency === undefined && p.amount_minor === undefined
          : p.currency !== undefined && p.amount_minor !== undefined,
      { message: 'give amount_tab_micro or currency + amount_minor' }
    ),
]);

const app = new Hono<AppContext>();

app.get('/llms.txt', (c) => {
  const host = c.req.header('host') ?? new URL(c.req.url).host;
  return c.text(llmsTxt(host));
});

// Invite links: signed-in visitors join immediately; signed-out visitors get
// the SPA, which shows the same two-button auth landing as the homepage and
// completes the join client-side after the in-page passkey ceremony.
app.get('/join/:token', async (c) => {
  const userId = await resolveUser(c.req.raw, c.env);
  if (!userId) {
    const assetUrl = new URL(c.req.url);
    assetUrl.pathname = '/';
    return c.env.ASSETS.fetch(new Request(assetUrl.toString(), { headers: c.req.raw.headers }));
  }
  const group = await db.groupByToken(c.env.DB, c.req.param('token'));
  if (!group) return c.text('This invite link is not valid.', 404);
  await db.upsertUser(c.env.DB, userId);
  await db.addMember(c.env.DB, group.id, userId);
  return c.redirect(`/#/g/${group.id}`);
});

const api = new Hono<AppContext>();
api.use('*', requireUser);

const meJson = (userId: string, user: Awaited<ReturnType<typeof db.getUser>>) => ({
  user_id: userId,
  display_name: user?.display_name,
  xmr_address: user?.xmr_address,
  pref_currency: user?.pref_currency ?? 'TAB',
});

api.get('/me', async (c) => {
  const userId = c.get('userId');
  await db.upsertUser(c.env.DB, userId);
  return c.json(meJson(userId, await db.getUser(c.env.DB, userId)));
});

api.put('/me', async (c) => {
  const parsed = profileSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'invalid' }, 400);
  const userId = c.get('userId');
  await db.upsertUser(c.env.DB, userId);
  await db.updateUser(c.env.DB, userId, parsed.data);
  return c.json(meJson(userId, await db.getUser(c.env.DB, userId)));
});

api.get('/groups', async (c) => {
  const userId = c.get('userId');
  await db.upsertUser(c.env.DB, userId);
  return c.json({ groups: await db.listGroups(c.env.DB, userId) });
});

api.post('/groups', async (c) => {
  const parsed = groupSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid group name' }, 400);
  const userId = c.get('userId');
  await db.upsertUser(c.env.DB, userId);
  const id = crypto.randomUUID();
  const tokenBytes = crypto.getRandomValues(new Uint8Array(16));
  const inviteToken = btoa(String.fromCharCode(...tokenBytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
  await db.createGroup(c.env.DB, { id, name: parsed.data.name, inviteToken, createdBy: userId });
  return c.json({ id, invite_token: inviteToken }, 201);
});

api.get('/groups/:id', async (c) => {
  const data = await db.loadGroup(c.env.DB, c.req.param('id'));
  if (!data) return c.json({ error: 'not found' }, 404);
  const userId = c.get('userId');
  if (!data.members.some((m) => m.id === userId)) return c.json({ error: 'not a member' }, 403);

  const nets = computeNets(
    data.members.map((m) => m.id),
    {
      expenses: data.expenses.map((e) => ({ paidBy: e.paid_by, amountTabMicro: e.amount_tab_micro })),
      shares: data.shares.map((s) => ({ userId: s.user_id, shareTabMicro: s.share_tab_micro })),
      payments: data.payments.map((p) => ({
        fromUser: p.from_user,
        toUser: p.to_user,
        amountTabMicro: p.amount_tab_micro,
      })),
    }
  );
  // Dust below 100 µTAB (1¢ USD) is hidden from the suggestion list only; the
  // ledger keeps exact values.
  const transfers = settle(nets).filter((t) => t.amountTabMicro >= 100);

  return c.json({
    group: data.group,
    members: data.members,
    nets: [...nets.entries()].map(([user_id, net_tab_micro]) => ({ user_id, net_tab_micro })),
    transfers: transfers.map((t) => ({
      from: t.from,
      to: t.to,
      amount_tab_micro: t.amountTabMicro,
    })),
    expenses: data.expenses,
    payments: data.payments,
  });
});

// Ghost members: split with someone before they've ever signed in.
api.post('/groups/:id/members', async (c) => {
  const groupId = c.req.param('id');
  if (!(await db.isMember(c.env.DB, groupId, c.get('userId')))) {
    return c.json({ error: 'not a member' }, 403);
  }
  const parsed = ghostSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid name' }, 400);
  const id = await db.createGhostMember(c.env.DB, groupId, parsed.data.name);
  return c.json({ user_id: id }, 201);
});

api.post('/groups/:id/claim', async (c) => {
  const groupId = c.req.param('id');
  const userId = c.get('userId');
  if (!(await db.isMember(c.env.DB, groupId, userId))) return c.json({ error: 'not a member' }, 403);
  const parsed = claimSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid claim' }, 400);
  const ok = await db.claimGhost(c.env.DB, {
    groupId,
    ghostId: parsed.data.ghost_id,
    claimerId: userId,
  });
  return ok ? c.json({ ok: true }) : c.json({ error: 'already claimed or not found' }, 409);
});

api.post('/groups/:id/expenses', async (c) => {
  const groupId = c.req.param('id');
  const userId = c.get('userId');
  if (!(await db.isMember(c.env.DB, groupId, userId))) return c.json({ error: 'not a member' }, 403);
  const parsed = expenseSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'invalid' }, 400);
  const body = parsed.data;

  const involved = new Set([...body.participant_ids, body.paid_by]);
  for (const id of involved) {
    if (!(await db.isMember(c.env.DB, groupId, id))) {
      return c.json({ error: 'payer and participants must be group members' }, 400);
    }
  }

  const currency = body.currency as Currency;
  let perUnit: number;
  try {
    perUnit = tabMicroPerUnit(currency, currency === 'CAD' ? await usdPerCad(c.env.DB) : undefined);
  } catch {
    return c.json({ error: 'exchange rate unavailable, try again shortly' }, 503);
  }
  const amountTabMicro = normalizeToTabMicro(body.amount_minor, perUnit);
  const shares = equalSplit(amountTabMicro, body.participant_ids);

  await db.insertExpense(c.env.DB, {
    id: body.id,
    groupId,
    description: body.description,
    paidBy: body.paid_by,
    currency,
    amountMinor: body.amount_minor,
    tabMicroPerUnit: perUnit,
    amountTabMicro,
    createdBy: userId,
    shares,
  });
  return c.json({ ok: true }, 201);
});

api.put('/groups/:id/expenses/:eid', async (c) => {
  const groupId = c.req.param('id');
  const userId = c.get('userId');
  if (!(await db.isMember(c.env.DB, groupId, userId))) return c.json({ error: 'not a member' }, 403);
  const parsed = expenseSchema
    .omit({ id: true })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'invalid' }, 400);
  const body = parsed.data;

  const involved = new Set([...body.participant_ids, body.paid_by]);
  for (const id of involved) {
    if (!(await db.isMember(c.env.DB, groupId, id))) {
      return c.json({ error: 'payer and participants must be group members' }, 400);
    }
  }

  const currency = body.currency as Currency;
  let perUnit: number;
  try {
    perUnit = tabMicroPerUnit(currency, currency === 'CAD' ? await usdPerCad(c.env.DB) : undefined);
  } catch {
    return c.json({ error: 'exchange rate unavailable, try again shortly' }, 503);
  }
  const amountTabMicro = normalizeToTabMicro(body.amount_minor, perUnit);

  const updated = await db.updateExpense(c.env.DB, {
    id: c.req.param('eid'),
    groupId,
    description: body.description,
    paidBy: body.paid_by,
    currency,
    amountMinor: body.amount_minor,
    tabMicroPerUnit: perUnit,
    amountTabMicro,
    shares: equalSplit(amountTabMicro, body.participant_ids),
  });
  return updated ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404);
});

api.delete('/groups/:id/expenses/:eid', async (c) => {
  const groupId = c.req.param('id');
  if (!(await db.isMember(c.env.DB, groupId, c.get('userId')))) {
    return c.json({ error: 'not a member' }, 403);
  }
  const deleted = await db.softDeleteExpense(c.env.DB, groupId, c.req.param('eid'));
  return deleted ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404);
});

api.post('/groups/:id/payments', async (c) => {
  const groupId = c.req.param('id');
  const userId = c.get('userId');
  if (!(await db.isMember(c.env.DB, groupId, userId))) return c.json({ error: 'not a member' }, 403);
  const raw = await c.req.json().catch(() => null);
  const parsed = paymentSchema.safeParse(
    raw && typeof raw === 'object' ? { method: 'xmr', ...raw } : raw
  );
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'invalid' }, 400);
  const body = parsed.data;

  // XMR payments are always recorded by the payer; cash may be recorded by
  // ANY group member for any pair (the treasurer collects everyone's bills,
  // ghosts can be named on either side).
  const fromUser = body.method === 'cash' ? (body.from_user ?? userId) : userId;
  if (fromUser === body.to_user) {
    return c.json({ error: 'payer and recipient must be different people' }, 400);
  }
  for (const id of [fromUser, body.to_user]) {
    if (id !== userId && !(await db.isMember(c.env.DB, groupId, id))) {
      return c.json({ error: 'payer and recipient must be group members' }, 400);
    }
  }

  let amountTabMicro: number;
  let fiat: { currency: Currency; amountMinor: number } | null = null;
  if (body.method === 'cash' && body.currency !== undefined && body.amount_minor !== undefined) {
    let perUnit: number;
    try {
      perUnit = tabMicroPerUnit(
        body.currency,
        body.currency === 'CAD' ? await usdPerCad(c.env.DB) : undefined
      );
    } catch {
      return c.json({ error: 'exchange rate unavailable, try again shortly' }, 503);
    }
    amountTabMicro = normalizeToTabMicro(body.amount_minor, perUnit);
    fiat = { currency: body.currency, amountMinor: body.amount_minor };
  } else {
    amountTabMicro = body.amount_tab_micro!;
  }

  await db.insertPayment(c.env.DB, {
    id: body.id,
    groupId,
    fromUser,
    toUser: body.to_user,
    amountTabMicro,
    method: body.method,
    currency: fiat?.currency ?? null,
    amountMinor: fiat?.amountMinor ?? null,
    xmrAmountPiconero: body.method === 'xmr' ? body.xmr_amount_piconero : 0,
    xmrRateTabMicro: body.method === 'xmr' ? body.xmr_rate_tab_micro : 0,
  });
  return c.json({ ok: true }, 201);
});

api.post('/join/:token', async (c) => {
  const group = await db.groupByToken(c.env.DB, c.req.param('token'));
  if (!group) return c.json({ error: 'invalid invite link' }, 404);
  const userId = c.get('userId');
  await db.upsertUser(c.env.DB, userId);
  await db.addMember(c.env.DB, group.id, userId);
  return c.json({ group_id: group.id });
});

api.get('/rate/xmr', async (c) => {
  try {
    const [rate, cad] = await Promise.all([
      xmrRateTabMicro(c.env.DB),
      usdPerCad(c.env.DB).catch(() => null),
    ]);
    return c.json({ xmr_rate_tab_micro: rate, ...(cad ? { usd_per_cad: cad } : {}) });
  } catch {
    return c.json({ error: 'rate unavailable' }, 503);
  }
});

app.route('/api', api);

// Anything else (deep links refreshed on the SPA, etc.) falls through to the
// static assets.
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
