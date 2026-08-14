import { Hono } from 'hono';
import type { AppContext } from './env';
import {
  CLAIM_RADIUS_M,
  COOLDOWN_MS,
  GROUPS,
  OPTION_BY_LABEL,
  displayName,
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
    device?: unknown;
    label?: unknown;
    lat?: unknown;
    lon?: unknown;
    cid?: unknown;
  } | null;
  if (!body) return text('🤖 Bad request (not JSON)');

  // Idempotency: offline-queued clients retry claims with a stable client
  // id, so a response lost to bad farm signal never double-scores.
  const cid = /^[0-9a-f-]{36}$/i.test(String(body.cid ?? '')) ? String(body.cid) : null;

  // Identity: a stable device key when provided (no name prompts needed),
  // else the typed name. Sending both records the device→name mapping.
  const name = String(body.player ?? '').trim().slice(0, 24);
  const device = String(body.device ?? '').trim().slice(0, 64);
  const player = device || name;
  const label = String(body.label ?? '').trim();
  const lat = Number(body.lat);
  const lon = Number(body.lon);
  if (!player) return text('🤖 Missing player/device — check the Shortcut fields');
  const opt = OPTION_BY_LABEL.get(label);
  if (!opt) return text(`🤖 Unknown veggie "${label}"`);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return text('🛰 No GPS fix — try again outside');

  const now = Date.now();
  const db = c.env.DB;

  if (cid) {
    const dup = await db
      .prepare('SELECT points FROM claims WHERE id = ?')
      .bind(cid)
      .first<{ points: number }>();
    if (dup) {
      const t = await db
        .prepare('SELECT COALESCE(SUM(points), 0) AS total FROM claims WHERE player = ?')
        .bind(player)
        .first<{ total: number }>();
      return text(`✅ Already counted (+${dup.points})\n⭐ ${displayName(player, name || null)}: ${t?.total ?? 0} points`);
    }
  }

  if (device && name) {
    await db
      .prepare('INSERT INTO players (id, name) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name')
      .bind(device, name)
      .run();
  }

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

  const finderName = nearest
    ? displayName(
        nearest.first_player,
        (
          await db
            .prepare('SELECT name FROM players WHERE id = ?')
            .bind(nearest.first_player)
            .first<{ name: string }>()
        )?.name
      )
    : undefined;
  const res = resolveClaim(opt, player, nearest, finderName);

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
          'INSERT OR IGNORE INTO claims (id, player, veggie_id, action, label, points, created) VALUES (?, ?, ?, ?, ?, ?, ?)'
        )
        .bind(cid ?? crypto.randomUUID(), player, id, res.action, opt.label, res.points, now),
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
          'INSERT OR IGNORE INTO claims (id, player, veggie_id, action, label, points, created) VALUES (?, ?, ?, ?, ?, ?, ?)'
        )
        .bind(cid ?? crypto.randomUUID(), player, nearest.id, res.action, opt.label, res.points, now),
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
          'INSERT OR IGNORE INTO claims (id, player, veggie_id, action, label, points, created) VALUES (?, ?, ?, ?, ?, ?, ?)'
        )
        .bind(cid ?? crypto.randomUUID(), player, nearest.id, res.action, opt.label, res.points, now),
    ]);
  }

  const total = await db
    .prepare('SELECT COALESCE(SUM(points), 0) AS total FROM claims WHERE player = ?')
    .bind(player)
    .first<{ total: number }>();

  const suffix = res.action === 'rejected' ? '' : ` +${res.points}`;
  const me = displayName(player, name || null);
  return text(`${res.message}${suffix}\n⭐ ${me}: ${total?.total ?? 0} points`);
});

// Map (or re-map) a device key to a display name, e.g. after a game where
// someone played unnamed.
veggie.post('/name', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { device?: unknown; name?: unknown } | null;
  const device = String(body?.device ?? '').trim().slice(0, 64);
  const name = String(body?.name ?? '').trim().slice(0, 24);
  if (!device || !name) return c.text('🤖 Need both device and name', 200);
  await c.env.DB
    .prepare('INSERT INTO players (id, name) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name')
    .bind(device, name)
    .run();
  return c.text(`✏️ You are now ${name}`, 200);
});

// Passphrase-gated full reset for game day. Constant-time comparison via
// SHA-256 + timingSafeEqual so the pass can't be brute-forced byte by byte.
veggie.post('/wipe', async (c) => {
  const configured = c.env.WIPE_PASS;
  if (!configured) return c.text('🤖 Wipe pass not configured', 200);
  const body = (await c.req.json().catch(() => null)) as { pass?: unknown } | null;
  const given = String(body?.pass ?? '');
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(given)),
    crypto.subtle.digest('SHA-256', enc.encode(configured)),
  ]);
  // timingSafeEqual is a Workers extension; the DOM lib's SubtleCrypto type
  // shadows it in this tsconfig.
  const subtle = crypto.subtle as unknown as {
    timingSafeEqual(x: ArrayBuffer, y: ArrayBuffer): boolean;
  };
  if (!subtle.timingSafeEqual(a, b)) return c.text('🔒 Wrong pass', 200);
  const [claims, veggies, players] = await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM claims'),
    c.env.DB.prepare('DELETE FROM veggies'),
    c.env.DB.prepare('DELETE FROM players'),
  ]);
  const n = (r: D1Result) => r.meta.changes ?? 0;
  return c.text(`🧹 Wiped: ${n(claims!)} claims, ${n(veggies!)} veggies, ${n(players!)} names`, 200);
});

veggie.get('/leaderboard.json', async (c) => {
  const db = c.env.DB;
  const { results: players } = await db
    .prepare(
      `SELECT c.player, p.name, SUM(c.points) AS points,
        SUM(c.action = 'discover') AS finds,
        SUM(c.action = 'confirm') AS confirms,
        SUM(c.action = 'refine') AS refines
       FROM claims c LEFT JOIN players p ON p.id = c.player
       GROUP BY c.player ORDER BY points DESC`
    )
    .all<{ player: string; name: string | null }>();
  const { results: recent } = await db
    .prepare(
      `SELECT c.player, p.name, c.action, c.label, c.points, c.created
       FROM claims c LEFT JOIN players p ON p.id = c.player
       ORDER BY c.created DESC LIMIT 12`
    )
    .all<{ player: string; name: string | null }>();
  const count = await db.prepare('SELECT COUNT(*) AS n FROM veggies').first<{ n: number }>();
  const named = <T extends { player: string; name: string | null }>(rows: T[]) =>
    rows.map(({ name, ...r }) => ({ ...r, player: displayName(r.player, name) }));
  // players rows also carry the raw identity key (`id`) so the leaderboard's
  // inline rename UI can POST /name against it.
  const withId = (players ?? []).map(({ name, ...r }) => ({
    ...r,
    id: r.player,
    player: displayName(r.player, name),
  }));
  return c.json(
    { players: withId, recent: named(recent ?? []), veggies: count?.n ?? 0 },
    200,
    { 'Cache-Control': 'no-store' }
  );
});

veggie.get('/points.geojson', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT v.*, p.name AS finder_name FROM veggies v LEFT JOIN players p ON p.id = v.first_player'
  ).all<VeggieRow & { finder_name: string | null }>();
  return c.json(
    {
      type: 'FeatureCollection',
      features: (results ?? []).map((v) => ({
        type: 'Feature',
        properties: {
          name: v.label,
          category: v.category,
          finder: displayName(v.first_player, v.finder_name),
          confirmations: v.confirmations,
        },
        geometry: { type: 'Point', coordinates: [v.lon, v.lat] },
      })),
    },
    200,
    { 'Cache-Control': 'no-store' }
  );
});
