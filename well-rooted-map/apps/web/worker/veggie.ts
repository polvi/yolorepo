import { Hono } from 'hono';
import type { AppContext } from './env';
import {
  CLAIM_RADIUS_M,
  COOLDOWN_MS,
  GROUPS,
  OPTION_BY_LABEL,
  haversineMeters,
  resolveClaim,
  type VeggieRow,
} from './veggie-logic';

// Veggie-tagging game API. Claims come from Apple Watch Shortcuts (see
// well-rooted-map/VEGGIE-GAME.md), so /claim always answers 200 with a
// plain-text message the Shortcut can show — non-2xx makes Shortcuts throw
// an ugly error dialog instead.

export const veggie = new Hono<AppContext>();

veggie.get('/menu', (c) => c.json({ groups: GROUPS.map((g) => g.label) }));

veggie.post('/menu', async (c) => {
  const body = await c.req.json().catch(() => ({}) as { group?: unknown });
  const group = GROUPS.find((g) => g.label === String(body.group ?? '').trim());
  const options = (group ? group.options : GROUPS.flatMap((g) => g.options)).map((o) => o.label);
  return c.json({ options });
});

veggie.post('/claim', async (c) => {
  const text = (msg: string) => c.text(msg, 200);
  const body = (await c.req.json().catch(() => null)) as {
    player?: unknown;
    label?: unknown;
    lat?: unknown;
    lon?: unknown;
  } | null;
  if (!body) return text('🤖 Bad request (not JSON)');

  const player = String(body.player ?? '').trim().slice(0, 24);
  const label = String(body.label ?? '').trim();
  const lat = Number(body.lat);
  const lon = Number(body.lon);
  if (!player) return text('🤖 Missing player name — edit the Text box at the top of the Shortcut');
  const opt = OPTION_BY_LABEL.get(label);
  if (!opt) return text(`🤖 Unknown veggie "${label}"`);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return text('🛰 No GPS fix — try again outside');

  const now = Date.now();
  const db = c.env.DB;

  const last = await db
    .prepare('SELECT created FROM claims WHERE player = ? ORDER BY created DESC LIMIT 1')
    .bind(player)
    .first<{ created: number }>();
  if (last && now - last.created < COOLDOWN_MS) {
    const wait = Math.ceil((COOLDOWN_MS - (now - last.created)) / 1000);
    return text(`⏱ Whoa, speedy! Catch your breath — try again in ${wait}s`);
  }

  const { results: candidates } = await db
    .prepare('SELECT * FROM veggies WHERE category = ?')
    .bind(opt.category)
    .all<VeggieRow>();
  let nearest: VeggieRow | null = null;
  let nearestDist = Infinity;
  for (const v of candidates ?? []) {
    const d = haversineMeters(lat, lon, v.lat, v.lon);
    if (d <= CLAIM_RADIUS_M && d < nearestDist) {
      nearest = v;
      nearestDist = d;
    }
  }

  const res = resolveClaim(opt, player, nearest);

  if (res.action === 'discover') {
    const id = crypto.randomUUID();
    await db.batch([
      db
        .prepare(
          'INSERT INTO veggies (id, category, label, spec, lat, lon, first_player, last_player, confirmations, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)'
        )
        .bind(id, opt.category, opt.label, opt.spec, lat, lon, player, player, now, now),
      db
        .prepare(
          'INSERT INTO claims (id, player, veggie_id, action, label, points, created) VALUES (?, ?, ?, ?, ?, ?, ?)'
        )
        .bind(crypto.randomUUID(), player, id, res.action, opt.label, res.points, now),
    ]);
  } else if (res.action === 'refine' && nearest) {
    await db.batch([
      db
        .prepare(
          'UPDATE veggies SET label = ?, spec = ?, last_player = ?, confirmations = confirmations + 1, updated = ? WHERE id = ?'
        )
        .bind(opt.label, opt.spec, player, now, nearest.id),
      db
        .prepare(
          'INSERT INTO claims (id, player, veggie_id, action, label, points, created) VALUES (?, ?, ?, ?, ?, ?, ?)'
        )
        .bind(crypto.randomUUID(), player, nearest.id, res.action, opt.label, res.points, now),
    ]);
  } else if (res.action === 'confirm' && nearest) {
    await db.batch([
      db
        .prepare(
          'UPDATE veggies SET last_player = ?, confirmations = confirmations + 1, updated = ? WHERE id = ?'
        )
        .bind(player, now, nearest.id),
      db
        .prepare(
          'INSERT INTO claims (id, player, veggie_id, action, label, points, created) VALUES (?, ?, ?, ?, ?, ?, ?)'
        )
        .bind(crypto.randomUUID(), player, nearest.id, res.action, opt.label, res.points, now),
    ]);
  }

  const total = await db
    .prepare('SELECT COALESCE(SUM(points), 0) AS total FROM claims WHERE player = ?')
    .bind(player)
    .first<{ total: number }>();

  const suffix = res.action === 'rejected' ? '' : ` +${res.points}`;
  return text(`${res.message}${suffix}\n⭐ ${player}: ${total?.total ?? 0} points`);
});

veggie.get('/leaderboard.json', async (c) => {
  const db = c.env.DB;
  const { results: players } = await db
    .prepare(
      `SELECT player, SUM(points) AS points,
        SUM(action = 'discover') AS finds,
        SUM(action = 'confirm') AS confirms,
        SUM(action = 'refine') AS refines
       FROM claims GROUP BY player ORDER BY points DESC`
    )
    .all();
  const { results: recent } = await db
    .prepare(
      'SELECT player, action, label, points, created FROM claims ORDER BY created DESC LIMIT 12'
    )
    .all();
  const count = await db.prepare('SELECT COUNT(*) AS n FROM veggies').first<{ n: number }>();
  return c.json(
    { players: players ?? [], recent: recent ?? [], veggies: count?.n ?? 0 },
    200,
    { 'Cache-Control': 'no-store' }
  );
});

veggie.get('/points.geojson', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM veggies').all<VeggieRow>();
  return c.json(
    {
      type: 'FeatureCollection',
      features: (results ?? []).map((v) => ({
        type: 'Feature',
        properties: {
          name: v.label,
          category: v.category,
          finder: v.first_player,
          confirmations: v.confirmations,
        },
        geometry: { type: 'Point', coordinates: [v.lon, v.lat] },
      })),
    },
    200,
    { 'Cache-Control': 'no-store' }
  );
});
