import type { ListingUpsert, TrustStatus, VerdictStatus } from './trust';

// ---------------------------------------------------------------- users/hosts

export async function upsertUser(db: D1Database, id: string): Promise<void> {
  await db
    .prepare('INSERT OR IGNORE INTO users (id, created_at) VALUES (?, ?)')
    .bind(id, Date.now())
    .run();
}

export async function upsertHost(db: D1Database, userId: string): Promise<void> {
  await upsertUser(db, userId);
  await db
    .prepare('INSERT OR IGNORE INTO hosts (user_id, created_at) VALUES (?, ?)')
    .bind(userId, Date.now())
    .run();
}

export async function updateHost(
  db: D1Database,
  userId: string,
  fields: { display_name?: string; contact?: string }
): Promise<void> {
  await upsertHost(db, userId);
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (fields.display_name !== undefined) {
    sets.push('display_name = ?');
    binds.push(fields.display_name);
  }
  if (fields.contact !== undefined) {
    sets.push('contact = ?');
    binds.push(fields.contact);
  }
  if (!sets.length) return;
  binds.push(userId);
  await db
    .prepare(`UPDATE hosts SET ${sets.join(', ')} WHERE user_id = ?`)
    .bind(...binds)
    .run();
}

export async function getHost(
  db: D1Database,
  userId: string
): Promise<{ display_name: string; contact: string } | null> {
  return db
    .prepare('SELECT display_name, contact FROM hosts WHERE user_id = ?')
    .bind(userId)
    .first<{ display_name: string; contact: string }>();
}

// ---------------------------------------------------------------- tokens

export interface TokenRow {
  token_hash: string;
  name: string;
  created_at: number;
  last_used_at: number | null;
}

export async function listTokens(db: D1Database, userId: string): Promise<TokenRow[]> {
  const { results } = await db
    .prepare(
      'SELECT token_hash, name, created_at, last_used_at FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC'
    )
    .bind(userId)
    .all<TokenRow>();
  return results;
}

export async function insertToken(
  db: D1Database,
  args: { tokenHash: string; userId: string; name: string }
): Promise<void> {
  await db
    .prepare('INSERT INTO api_tokens (token_hash, user_id, name, created_at) VALUES (?, ?, ?, ?)')
    .bind(args.tokenHash, args.userId, args.name, Date.now())
    .run();
}

export async function deleteToken(db: D1Database, userId: string, tokenHash: string): Promise<boolean> {
  const res = await db
    .prepare('DELETE FROM api_tokens WHERE token_hash = ? AND user_id = ?')
    .bind(tokenHash, userId)
    .run();
  return res.meta.changes > 0;
}

// ---------------------------------------------------------------- listings

export interface ListingRow {
  id: string;
  host_id: string;
  slug: string;
  endpoint_url: string;
  gpu_model: string;
  cpu_tee: string;
  model_id: string;
  model_digest: string | null;
  ctx_len: number;
  price_in_piconero: number;
  price_out_piconero: number;
  region: string;
  simulated: number;
  trust_status: TrustStatus;
  runner_version: string | null;
  hpke_pub: string | null;
  sign_pub: string | null;
  attestation_doc: string | null;
  verdict: string | null;
  verified_at: number | null;
  last_heartbeat: number | null;
  challenge: string | null;
  challenge_issued_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface HeartbeatRow {
  at: number;
  sessions_open: number;
  tokens_in_total: number;
  tokens_out_total: number;
  uptime_s: number;
}

function randomId(bytes = 8): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export async function getListing(db: D1Database, id: string): Promise<ListingRow | null> {
  return db.prepare('SELECT * FROM listings WHERE id = ?').bind(id).first<ListingRow>();
}

export async function getListingForHost(
  db: D1Database,
  id: string,
  hostId: string
): Promise<ListingRow | null> {
  return db
    .prepare('SELECT * FROM listings WHERE id = ? AND host_id = ?')
    .bind(id, hostId)
    .first<ListingRow>();
}

export async function listListingsForHost(db: D1Database, hostId: string): Promise<ListingRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM listings WHERE host_id = ? ORDER BY created_at DESC')
    .bind(hostId)
    .all<ListingRow>();
  return results;
}

export async function listPublicListings(
  db: D1Database,
  opts: { includeSimulated: boolean; gpu?: string; model?: string }
): Promise<ListingRow[]> {
  const where: string[] = [];
  const binds: unknown[] = [];
  if (!opts.includeSimulated) where.push('simulated = 0');
  if (opts.gpu) {
    where.push('gpu_model LIKE ?');
    binds.push(`%${opts.gpu}%`);
  }
  if (opts.model) {
    where.push('model_id LIKE ?');
    binds.push(`%${opts.model}%`);
  }
  const sql =
    'SELECT * FROM listings' +
    (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
    ' ORDER BY last_heartbeat DESC NULLS LAST, created_at DESC LIMIT 200';
  const { results } = await db
    .prepare(sql)
    .bind(...binds)
    .all<ListingRow>();
  return results;
}

// Upsert by (host, slug). A re-registration keeps id, trust state, and the
// last attestation; only the host-declared fields change. Flipping
// `simulated` is a trust-relevant change, so the stored status is reset and
// the runner has to attest again.
export async function upsertListing(
  db: D1Database,
  hostId: string,
  slug: string,
  body: ListingUpsert
): Promise<{ id: string; created: boolean }> {
  const now = Date.now();
  const simulated = body.simulated === true || body.simulated === 1 ? 1 : 0;
  const existing = await db
    .prepare('SELECT id, simulated FROM listings WHERE host_id = ? AND slug = ?')
    .bind(hostId, slug)
    .first<{ id: string; simulated: number }>();
  if (existing) {
    const resetTrust = existing.simulated !== simulated;
    await db
      .prepare(
        'UPDATE listings SET endpoint_url = ?, gpu_model = ?, cpu_tee = ?, model_id = ?, ctx_len = ?, ' +
          'price_in_piconero = ?, price_out_piconero = ?, region = ?, simulated = ?, updated_at = ?' +
          (resetTrust
            ? ", trust_status = 'offline', verified_at = NULL, verdict = NULL, attestation_doc = NULL, challenge = NULL, challenge_issued_at = NULL"
            : '') +
          ' WHERE id = ?'
      )
      .bind(
        body.endpoint_url,
        body.gpu_model,
        body.cpu_tee,
        body.model_id,
        body.ctx_len,
        body.price_in_piconero,
        body.price_out_piconero,
        body.region,
        simulated,
        now,
        existing.id
      )
      .run();
    return { id: existing.id, created: false };
  }
  const id = randomId(8);
  await db
    .prepare(
      'INSERT INTO listings (id, host_id, slug, endpoint_url, gpu_model, cpu_tee, model_id, ctx_len, ' +
        'price_in_piconero, price_out_piconero, region, simulated, created_at, updated_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .bind(
      id,
      hostId,
      slug,
      body.endpoint_url,
      body.gpu_model,
      body.cpu_tee,
      body.model_id,
      body.ctx_len,
      body.price_in_piconero,
      body.price_out_piconero,
      body.region,
      simulated,
      now,
      now
    )
    .run();
  return { id, created: true };
}

export async function deleteListing(db: D1Database, id: string, hostId: string): Promise<boolean> {
  const batch = await db.batch([
    db.prepare('DELETE FROM heartbeats WHERE listing_id = ?').bind(id),
    db.prepare('DELETE FROM attestations WHERE listing_id = ?').bind(id),
    db.prepare('DELETE FROM disputes WHERE listing_id = ?').bind(id),
    db.prepare('DELETE FROM listings WHERE id = ? AND host_id = ?').bind(id, hostId),
  ]);
  return (batch[3]?.meta.changes ?? 0) > 0;
}

// ---------------------------------------------------------------- attestation

export interface AttestResult {
  status: VerdictStatus;
  trust: TrustStatus;
  checks: unknown[];
  docJson: string;
  fromDoc: {
    runner_version?: string;
    hpke_pub?: string;
    sign_pub?: string;
    model_id?: string;
    model_digest?: string;
    ctx_len?: number;
  };
}

export async function recordAttestation(
  db: D1Database,
  listingId: string,
  r: AttestResult
): Promise<void> {
  const now = Date.now();
  const verdictJson = JSON.stringify({ status: r.status, checks: r.checks });
  const success = r.trust === 'verified' || r.trust === 'simulated';
  const stmts = [
    db
      .prepare(
        'INSERT INTO attestations (id, listing_id, received_at, status, checks, doc) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .bind(randomId(8), listingId, now, r.status, JSON.stringify(r.checks), r.docJson),
    db
      .prepare(
        'UPDATE listings SET trust_status = ?, verdict = ?, attestation_doc = ?, updated_at = ?, ' +
          'runner_version = COALESCE(?, runner_version), hpke_pub = COALESCE(?, hpke_pub), ' +
          'sign_pub = COALESCE(?, sign_pub), model_id = COALESCE(?, model_id), ' +
          'model_digest = COALESCE(?, model_digest), ctx_len = COALESCE(?, ctx_len)' +
          (success ? ', verified_at = ?, challenge = NULL, challenge_issued_at = NULL' : '') +
          ' WHERE id = ?'
      )
      .bind(
        r.trust,
        verdictJson,
        r.docJson,
        now,
        r.fromDoc.runner_version ?? null,
        r.fromDoc.hpke_pub ?? null,
        r.fromDoc.sign_pub ?? null,
        r.fromDoc.model_id ?? null,
        r.fromDoc.model_digest ?? null,
        r.fromDoc.ctx_len ?? null,
        ...(success ? [now] : []),
        listingId
      ),
    // Keep history bounded per listing.
    db
      .prepare(
        'DELETE FROM attestations WHERE listing_id = ? AND id NOT IN ' +
          '(SELECT id FROM attestations WHERE listing_id = ? ORDER BY received_at DESC LIMIT 50)'
      )
      .bind(listingId, listingId),
  ];
  await db.batch(stmts);
}

export async function listAttestations(
  db: D1Database,
  listingId: string,
  limit = 20
): Promise<{ id: string; received_at: number; status: string; checks: string }[]> {
  const { results } = await db
    .prepare(
      'SELECT id, received_at, status, checks FROM attestations WHERE listing_id = ? ORDER BY received_at DESC LIMIT ?'
    )
    .bind(listingId, limit)
    .all<{ id: string; received_at: number; status: string; checks: string }>();
  return results;
}

// ---------------------------------------------------------------- heartbeats

export async function recordHeartbeat(
  db: D1Database,
  listingId: string,
  hb: { sessions_open: number; tokens_in_total: number; tokens_out_total: number; uptime_s: number },
  challenge: { value: string; issuedAt: number } | null
): Promise<void> {
  const now = Date.now();
  const stmts = [
    db
      .prepare(
        'INSERT OR REPLACE INTO heartbeats (listing_id, at, sessions_open, tokens_in_total, tokens_out_total, uptime_s) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .bind(listingId, now, hb.sessions_open, hb.tokens_in_total, hb.tokens_out_total, hb.uptime_s),
    challenge
      ? db
          .prepare(
            'UPDATE listings SET last_heartbeat = ?, challenge = ?, challenge_issued_at = ?, updated_at = ? WHERE id = ?'
          )
          .bind(now, challenge.value, challenge.issuedAt, now, listingId)
      : db
          .prepare('UPDATE listings SET last_heartbeat = ?, updated_at = ? WHERE id = ?')
          .bind(now, now, listingId),
    // Keep ~1 day of 5-minute heartbeats per listing.
    db
      .prepare(
        'DELETE FROM heartbeats WHERE listing_id = ? AND at NOT IN ' +
          '(SELECT at FROM heartbeats WHERE listing_id = ? ORDER BY at DESC LIMIT 300)'
      )
      .bind(listingId, listingId),
  ];
  await db.batch(stmts);
}

export async function latestHeartbeat(db: D1Database, listingId: string): Promise<HeartbeatRow | null> {
  return db
    .prepare(
      'SELECT at, sessions_open, tokens_in_total, tokens_out_total, uptime_s FROM heartbeats WHERE listing_id = ? ORDER BY at DESC LIMIT 1'
    )
    .bind(listingId)
    .first<HeartbeatRow>();
}

export async function latestHeartbeats(
  db: D1Database,
  listingIds: string[]
): Promise<Map<string, HeartbeatRow>> {
  const out = new Map<string, HeartbeatRow>();
  if (!listingIds.length) return out;
  const placeholders = listingIds.map(() => '?').join(',');
  const { results } = await db
    .prepare(
      `SELECT h.listing_id, h.at, h.sessions_open, h.tokens_in_total, h.tokens_out_total, h.uptime_s
       FROM heartbeats h
       JOIN (SELECT listing_id, MAX(at) AS at FROM heartbeats WHERE listing_id IN (${placeholders}) GROUP BY listing_id) m
         ON m.listing_id = h.listing_id AND m.at = h.at`
    )
    .bind(...listingIds)
    .all<HeartbeatRow & { listing_id: string }>();
  for (const { listing_id, ...hb } of results) out.set(listing_id, hb);
  return out;
}

// ---------------------------------------------------------------- disputes

export async function countRecentDisputes(db: D1Database, listingId: string, sinceMs: number): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS n FROM disputes WHERE listing_id = ? AND created_at > ?')
    .bind(listingId, sinceMs)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function insertDispute(
  db: D1Database,
  d: { listing_id: string; offer: string; tx_proof: string; note: string }
): Promise<string> {
  const id = randomId(8);
  await db
    .prepare('INSERT INTO disputes (id, listing_id, offer, tx_proof, note, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, d.listing_id, d.offer, d.tx_proof, d.note, Date.now())
    .run();
  return id;
}

export async function countDisputes(db: D1Database, listingIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!listingIds.length) return out;
  const placeholders = listingIds.map(() => '?').join(',');
  const { results } = await db
    .prepare(`SELECT listing_id, COUNT(*) AS n FROM disputes WHERE listing_id IN (${placeholders}) GROUP BY listing_id`)
    .bind(...listingIds)
    .all<{ listing_id: string; n: number }>();
  for (const r of results) out.set(r.listing_id, r.n);
  return out;
}
