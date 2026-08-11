// All D1 access for molemap. Writes that must be idempotent use
// client-generated UUID primary keys + INSERT OR IGNORE; multi-row writes go
// through DB.batch, which D1 runs atomically.

export type ArtifactKind = 'splat' | 'pointcloud' | 'crop' | 'preview' | 'manifest' | 'detections';
export type MoleStatus = 'confirmed' | 'proposed' | 'dismissed';

export interface VisitRow {
  id: string;
  user_id: string;
  captured_at: number;
  status: 'uploaded' | 'ready';
  alignment: string; // JSON: column-major 4x4
  manifest: string | null;
  created_at: number;
}

export interface ArtifactRow {
  visit_id: string;
  sha256: string;
  kind: ArtifactKind;
  size: number;
  r2_key: string;
  label: string;
  detection_id: string | null;
  created_at: number;
}

export interface MoleRow {
  id: string;
  user_id: string;
  label: string;
  canonical_x: number;
  canonical_y: number;
  canonical_z: number;
  source: 'manual' | 'detected';
  status: MoleStatus;
  created_at: number;
  retired_at: number | null;
}

export interface ObservationRow {
  id: string;
  mole_id: string;
  visit_id: string;
  crop_sha256: string | null;
  note: string | null;
  diameter_mm: number | null;
  confidence: number | null;
  embedding: string | null; // JSON float array
  created_at: number;
}

export interface TokenRow {
  token_hash: string;
  name: string;
  created_at: number;
  last_used_at: number | null;
}

export async function upsertUser(db: D1Database, id: string): Promise<void> {
  await db
    .prepare('INSERT OR IGNORE INTO users (id, created_at) VALUES (?, ?)')
    .bind(id, Date.now())
    .run();
}

// ---------------------------------------------------------------- visits

export async function insertVisit(
  db: D1Database,
  args: { id: string; userId: string; capturedAt: number; manifest: string | null }
): Promise<void> {
  await db
    .prepare(
      'INSERT OR IGNORE INTO visits (id, user_id, captured_at, manifest, created_at) VALUES (?, ?, ?, ?, ?)'
    )
    .bind(args.id, args.userId, args.capturedAt, args.manifest, Date.now())
    .run();
}

export async function getVisit(db: D1Database, userId: string, id: string): Promise<VisitRow | null> {
  return db
    .prepare('SELECT * FROM visits WHERE id = ? AND user_id = ?')
    .bind(id, userId)
    .first<VisitRow>();
}

export async function listVisits(
  db: D1Database,
  userId: string
): Promise<(VisitRow & { artifact_count: number })[]> {
  const { results } = await db
    .prepare(
      `SELECT v.*, (SELECT COUNT(*) FROM artifacts a WHERE a.visit_id = v.id) AS artifact_count
       FROM visits v WHERE v.user_id = ? ORDER BY v.captured_at`
    )
    .bind(userId)
    .all<VisitRow & { artifact_count: number }>();
  return results;
}

export async function updateVisitAlignment(
  db: D1Database,
  userId: string,
  id: string,
  alignment: string
): Promise<boolean> {
  const res = await db
    .prepare('UPDATE visits SET alignment = ? WHERE id = ? AND user_id = ?')
    .bind(alignment, id, userId)
    .run();
  return res.meta.changes > 0;
}

export async function updateVisitManifest(db: D1Database, id: string, manifest: string): Promise<void> {
  await db.prepare('UPDATE visits SET manifest = ? WHERE id = ?').bind(manifest, id).run();
}

export async function setVisitReady(db: D1Database, id: string): Promise<void> {
  await db.prepare("UPDATE visits SET status = 'ready' WHERE id = ?").bind(id).run();
}

// ---------------------------------------------------------------- artifacts

export async function upsertArtifact(
  db: D1Database,
  args: {
    visitId: string;
    sha256: string;
    kind: ArtifactKind;
    size: number;
    r2Key: string;
    label: string;
    detectionId: string | null;
  }
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO artifacts (visit_id, sha256, kind, size, r2_key, label, detection_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (visit_id, sha256) DO UPDATE SET kind = excluded.kind,
         size = excluded.size, label = excluded.label, detection_id = excluded.detection_id`
    )
    .bind(
      args.visitId,
      args.sha256,
      args.kind,
      args.size,
      args.r2Key,
      args.label,
      args.detectionId,
      Date.now()
    )
    .run();
}

export async function artifactsForVisit(db: D1Database, visitId: string): Promise<ArtifactRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM artifacts WHERE visit_id = ? ORDER BY created_at')
    .bind(visitId)
    .all<ArtifactRow>();
  return results;
}

export async function artifactRow(
  db: D1Database,
  visitId: string,
  sha256: string
): Promise<ArtifactRow | null> {
  return db
    .prepare('SELECT * FROM artifacts WHERE visit_id = ? AND sha256 = ?')
    .bind(visitId, sha256)
    .first<ArtifactRow>();
}

/** Any artifact row with this sha belonging to a visit this user owns. */
export async function artifactByShaForUser(
  db: D1Database,
  userId: string,
  sha256: string
): Promise<ArtifactRow | null> {
  return db
    .prepare(
      `SELECT a.* FROM artifacts a JOIN visits v ON v.id = a.visit_id
       WHERE a.sha256 = ? AND v.user_id = ? LIMIT 1`
    )
    .bind(sha256, userId)
    .first<ArtifactRow>();
}

// ---------------------------------------------------------------- moles

export async function insertMole(
  db: D1Database,
  args: {
    id: string;
    userId: string;
    label: string;
    canonical: [number, number, number];
    source: 'manual' | 'detected';
    status: MoleStatus;
  }
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO moles (id, user_id, label, canonical_x, canonical_y, canonical_z, source, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      args.id,
      args.userId,
      args.label,
      args.canonical[0],
      args.canonical[1],
      args.canonical[2],
      args.source,
      args.status,
      Date.now()
    )
    .run();
}

export async function getMole(db: D1Database, userId: string, id: string): Promise<MoleRow | null> {
  return db
    .prepare('SELECT * FROM moles WHERE id = ? AND user_id = ?')
    .bind(id, userId)
    .first<MoleRow>();
}

export async function listMoles(db: D1Database, userId: string): Promise<MoleRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM moles WHERE user_id = ? ORDER BY created_at')
    .bind(userId)
    .all<MoleRow>();
  return results;
}

export async function updateMole(
  db: D1Database,
  userId: string,
  id: string,
  fields: { label?: string; status?: MoleStatus; retiredAt?: number | null }
): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE moles SET label = COALESCE(?, label), status = COALESCE(?, status),
         retired_at = CASE WHEN ?3 THEN ?4 ELSE retired_at END
       WHERE id = ? AND user_id = ?`
    )
    .bind(
      fields.label ?? null,
      fields.status ?? null,
      fields.retiredAt === undefined ? 0 : 1,
      fields.retiredAt ?? null,
      id,
      userId
    )
    .run();
  return res.meta.changes > 0;
}

// ---------------------------------------------------------------- observations

/** All observations for a user's moles, joined with visit capture time. */
export async function listObservations(
  db: D1Database,
  userId: string
): Promise<(ObservationRow & { captured_at: number })[]> {
  const { results } = await db
    .prepare(
      `SELECT o.*, v.captured_at FROM mole_observations o
       JOIN moles m ON m.id = o.mole_id
       JOIN visits v ON v.id = o.visit_id
       WHERE m.user_id = ? ORDER BY v.captured_at`
    )
    .bind(userId)
    .all<ObservationRow & { captured_at: number }>();
  return results;
}

export async function observationsForMole(
  db: D1Database,
  moleId: string
): Promise<(ObservationRow & { captured_at: number })[]> {
  const { results } = await db
    .prepare(
      `SELECT o.*, v.captured_at FROM mole_observations o
       JOIN visits v ON v.id = o.visit_id
       WHERE o.mole_id = ? ORDER BY v.captured_at`
    )
    .bind(moleId)
    .all<ObservationRow & { captured_at: number }>();
  return results;
}

export async function insertObservationIgnore(
  db: D1Database,
  args: {
    id: string;
    moleId: string;
    visitId: string;
    cropSha256: string | null;
    confidence: number | null;
    embedding: string | null;
  }
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO mole_observations
       (id, mole_id, visit_id, crop_sha256, confidence, embedding, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(args.id, args.moleId, args.visitId, args.cropSha256, args.confidence, args.embedding, Date.now())
    .run();
}

export async function upsertObservation(
  db: D1Database,
  args: {
    moleId: string;
    visitId: string;
    cropSha256?: string | null;
    note?: string | null;
    diameterMm?: number | null;
  }
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO mole_observations (id, mole_id, visit_id, crop_sha256, note, diameter_mm, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (mole_id, visit_id) DO UPDATE SET
         crop_sha256 = COALESCE(excluded.crop_sha256, crop_sha256),
         note = COALESCE(excluded.note, note),
         diameter_mm = COALESCE(excluded.diameter_mm, diameter_mm)`
    )
    .bind(
      crypto.randomUUID(),
      args.moleId,
      args.visitId,
      args.cropSha256 ?? null,
      args.note ?? null,
      args.diameterMm ?? null,
      Date.now()
    )
    .run();
}

export async function deleteObservation(
  db: D1Database,
  moleId: string,
  visitId: string
): Promise<boolean> {
  const res = await db
    .prepare('DELETE FROM mole_observations WHERE mole_id = ? AND visit_id = ?')
    .bind(moleId, visitId)
    .run();
  return res.meta.changes > 0;
}

// ---------------------------------------------------------------- tokens

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
