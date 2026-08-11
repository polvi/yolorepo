import { Hono } from 'hono';
import { z } from 'zod';
import type { AppContext } from './env';
import * as db from './db';
import { MATCH_RADIUS, matchDetections, type Detection } from './match';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;

// Small artifacts (images/JSON) vs. the heavy 3D payloads. Uploads above the
// Cloudflare plan's request body limit (100 MB on Free/Pro) never reach us.
const MAX_SMALL_BYTES = 25 * 1024 * 1024;
const MAX_LARGE_BYTES = 200 * 1024 * 1024;

const KINDS = ['splat', 'pointcloud', 'crop', 'preview', 'manifest', 'detections'] as const;

const visitSchema = z.object({
  id: z.string().regex(UUID_RE),
  captured_at: z.number().int().positive(),
  manifest: z.unknown().optional(),
});

const alignmentSchema = z.object({
  alignment: z.array(z.number().finite()).length(16),
});

const beginSchema = z.object({
  sha256: z.string().regex(SHA256_RE),
  kind: z.enum(KINDS),
  size: z.number().int().positive(),
  label: z.string().max(200).optional(),
});

const finalizeSchema = z.object({ manifest: z.unknown().optional() });

const detectionSchema = z.object({
  id: z.string().min(1),
  position: z.tuple([z.number(), z.number(), z.number()]),
  confidence: z.number().optional(),
  embedding: z.array(z.number()).optional(),
  cropSha: z.string().regex(SHA256_RE).optional(),
});
const detectionsFileSchema = z.union([
  z.array(detectionSchema),
  z.object({ detections: z.array(detectionSchema) }),
]);

function maxBytes(kind: (typeof KINDS)[number]): number {
  return kind === 'splat' || kind === 'pointcloud' ? MAX_LARGE_BYTES : MAX_SMALL_BYTES;
}

async function sha256HexOf(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const visits = new Hono<AppContext>();

visits.get('/', async (c) => {
  const userId = c.get('userId');
  await db.upsertUser(c.env.DB, userId);
  return c.json({ visits: await db.listVisits(c.env.DB, userId) });
});

visits.post('/', async (c) => {
  const parsed = visitSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'invalid' }, 400);
  const userId = c.get('userId');
  await db.upsertUser(c.env.DB, userId);
  await db.insertVisit(c.env.DB, {
    id: parsed.data.id.toLowerCase(),
    userId,
    capturedAt: parsed.data.captured_at,
    manifest: parsed.data.manifest === undefined ? null : JSON.stringify(parsed.data.manifest),
  });
  return c.json({ id: parsed.data.id.toLowerCase() }, 201);
});

visits.get('/:id', async (c) => {
  const visit = await db.getVisit(c.env.DB, c.get('userId'), c.req.param('id'));
  if (!visit) return c.json({ error: 'not found' }, 404);
  return c.json({ visit, artifacts: await db.artifactsForVisit(c.env.DB, visit.id) });
});

visits.patch('/:id', async (c) => {
  const parsed = alignmentSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'alignment must be 16 numbers' }, 400);
  const ok = await db.updateVisitAlignment(
    c.env.DB,
    c.get('userId'),
    c.req.param('id'),
    JSON.stringify(parsed.data.alignment)
  );
  return ok ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404);
});

// Upload handshake: the CLI declares an artifact, we answer whether the bytes
// are already in R2 (dedup across visits — same sha, same key).
visits.post('/:id/artifacts', async (c) => {
  const userId = c.get('userId');
  const visit = await db.getVisit(c.env.DB, userId, c.req.param('id'));
  if (!visit) return c.json({ error: 'not found' }, 404);
  const parsed = beginSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'invalid' }, 400);
  const { sha256, kind, size, label } = parsed.data;
  if (size > maxBytes(kind)) return c.json({ error: 'too large for kind' }, 413);

  const key = `${userId}/${sha256}`;
  const head = await c.env.BLOBS.head(key);
  await db.upsertArtifact(c.env.DB, {
    visitId: visit.id,
    sha256,
    kind,
    size,
    r2Key: key,
    label: label ?? '',
  });
  return c.json({ needed: head === null });
});

visits.put('/:id/artifacts/:sha256', async (c) => {
  const userId = c.get('userId');
  const visit = await db.getVisit(c.env.DB, userId, c.req.param('id'));
  if (!visit) return c.json({ error: 'not found' }, 404);
  const sha = c.req.param('sha256');
  if (!SHA256_RE.test(sha)) return c.json({ error: 'invalid sha256' }, 400);
  const row = await db.artifactRow(c.env.DB, visit.id, sha);
  if (!row) return c.json({ error: 'declare the artifact first (POST /artifacts)' }, 400);

  const cap = maxBytes(row.kind);
  const declared = Number(c.req.header('content-length') ?? '0');
  if (declared > cap) {
    return c.json(
      { error: 'too large', note: 'Workers request bodies are also capped by the Cloudflare plan' },
      413
    );
  }
  const body = await c.req.arrayBuffer();
  if (body.byteLength === 0) return c.json({ error: 'empty body' }, 400);
  if (body.byteLength > cap) {
    return c.json(
      { error: 'too large', note: 'Workers request bodies are also capped by the Cloudflare plan' },
      413
    );
  }
  // Server-side re-hash: the sha is the artifact's identity and R2 key.
  if ((await sha256HexOf(body)) !== sha) return c.json({ error: 'hash mismatch' }, 400);

  await c.env.BLOBS.put(`${userId}/${sha}`, body);
  return c.json({ ok: true });
});

// Finalize: verify every declared artifact's bytes exist, then commit
// status='ready' + manifest with a single conditional UPDATE. The guard and
// the write must be one atomic statement: TLC on specs/VisitUpload.tla showed
// validate-then-write lets two concurrent finalizes commit different
// manifests.
visits.post('/:id/finalize', async (c) => {
  const userId = c.get('userId');
  const visitId = c.req.param('id');
  const visit = await db.getVisit(c.env.DB, userId, visitId);
  if (!visit) return c.json({ error: 'not found' }, 404);
  const parsed = finalizeSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: 'invalid' }, 400);
  const manifest =
    parsed.data.manifest === undefined ? visit.manifest : JSON.stringify(parsed.data.manifest);

  const rows = await db.artifactsForVisit(c.env.DB, visitId);
  if (rows.length === 0) return c.json({ error: 'no artifacts declared' }, 400);
  const missing: string[] = [];
  for (const row of rows) {
    if ((await c.env.BLOBS.head(row.r2_key)) === null) missing.push(row.sha256);
  }
  if (missing.length > 0) return c.json({ error: 'artifacts not uploaded', missing }, 409);

  const res = await c.env.DB.prepare(
    `UPDATE visits SET status = 'ready', manifest = ?1
     WHERE id = ?2 AND user_id = ?3 AND (manifest IS NULL OR manifest = ?1)`
  )
    .bind(manifest, visitId, userId)
    .run();
  if (res.meta.changes === 0) {
    const current = await db.getVisit(c.env.DB, userId, visitId);
    if (current && current.manifest === manifest) return c.json({ status: current.status });
    return c.json({ error: 'already finalized with a different manifest' }, 409);
  }

  // Replayed finalize: the commit above is idempotent, and matching already
  // ran the first time — nothing more to do.
  if (visit.status === 'ready') return c.json({ status: 'ready' });

  const stats = await runMoleMatching(c.env, userId, { ...visit, manifest });
  return c.json({ status: 'ready', ...stats });
});

/**
 * If the visit shipped a detections artifact, match each detection against
 * the user's existing moles (attach an observation) or create a new
 * source='detected' status='proposed' mole. Matching itself is pure
 * (match.ts); this applies the outcome to D1.
 */
async function runMoleMatching(
  env: AppContext['Bindings'],
  userId: string,
  visit: db.VisitRow
): Promise<{ attached: number; proposed: number }> {
  const rows = await db.artifactsForVisit(env.DB, visit.id);
  const det = rows.find((r) => r.kind === 'detections');
  if (!det) return { attached: 0, proposed: 0 };

  const object = await env.BLOBS.get(det.r2_key);
  if (!object) return { attached: 0, proposed: 0 };
  const parsed = detectionsFileSchema.safeParse(await object.json().catch(() => null));
  if (!parsed.success) return { attached: 0, proposed: 0 };
  const detections: Detection[] = Array.isArray(parsed.data) ? parsed.data : parsed.data.detections;

  const moles = await db.listMoles(env.DB, userId);
  const candidates = moles
    .filter((m) => m.retired_at === null)
    .map((m) => ({
      id: m.id,
      canonical: [m.canonical_x, m.canonical_y, m.canonical_z] as [number, number, number],
      status: m.status,
    }));
  const alignment = JSON.parse(visit.alignment) as number[];
  const outcome = matchDetections(detections, candidates, alignment, MATCH_RADIUS);

  for (const { moleId, detection } of outcome.attach) {
    await db.insertObservationIgnore(env.DB, {
      id: crypto.randomUUID(),
      moleId,
      visitId: visit.id,
      cropSha256: detection.cropSha ?? null,
      confidence: detection.confidence ?? null,
      embedding: detection.embedding ? JSON.stringify(detection.embedding) : null,
    });
  }
  for (const group of outcome.create) {
    const moleId = crypto.randomUUID();
    await db.insertMole(env.DB, {
      id: moleId,
      userId,
      label: '',
      canonical: group.canonical,
      source: 'detected',
      status: 'proposed',
    });
    // UNIQUE(mole_id, visit_id): only the strongest lands if several
    // detections in this visit merged into one new mole.
    const strongest = [...group.detections].sort(
      (a, b) => (b.confidence ?? 0) - (a.confidence ?? 0)
    )[0]!;
    await db.insertObservationIgnore(env.DB, {
      id: crypto.randomUUID(),
      moleId,
      visitId: visit.id,
      cropSha256: strongest.cropSha ?? null,
      confidence: strongest.confidence ?? null,
      embedding: strongest.embedding ? JSON.stringify(strongest.embedding) : null,
    });
  }
  return { attached: outcome.attach.length, proposed: outcome.create.length };
}
