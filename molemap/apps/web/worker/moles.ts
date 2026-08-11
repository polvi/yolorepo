import { Hono } from 'hono';
import { z } from 'zod';
import type { AppContext } from './env';
import * as db from './db';
import { cosineDistance } from './match';

const moleSchema = z.object({
  label: z.string().trim().max(80).optional(),
  position: z.tuple([z.number(), z.number(), z.number()]),
});

const patchSchema = z.object({
  label: z.string().trim().max(80).optional(),
  status: z.enum(['confirmed', 'dismissed']).optional(),
  retired: z.boolean().optional(),
});

const observationSchema = z.object({
  crop_sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  note: z.string().max(2000).optional(),
  diameter_mm: z.number().positive().optional(),
});

interface ObsView {
  id: string;
  visit_id: string;
  captured_at: number;
  crop_sha256: string | null;
  note: string | null;
  diameter_mm: number | null;
  confidence: number | null;
  created_at: number;
  change_score: number | null; // cosine distance vs the previous observation
}

// Embeddings stay server-side; the UI gets the derived change score.
function toViews(rows: (db.ObservationRow & { captured_at: number })[]): ObsView[] {
  let prevEmbedding: number[] | null = null;
  return rows.map((o) => {
    const embedding = o.embedding ? (JSON.parse(o.embedding) as number[]) : null;
    const change_score =
      embedding && prevEmbedding ? cosineDistance(prevEmbedding, embedding) : null;
    if (embedding) prevEmbedding = embedding;
    return {
      id: o.id,
      visit_id: o.visit_id,
      captured_at: o.captured_at,
      crop_sha256: o.crop_sha256,
      note: o.note,
      diameter_mm: o.diameter_mm,
      confidence: o.confidence,
      created_at: o.created_at,
      change_score,
    };
  });
}

export const moles = new Hono<AppContext>();

moles.get('/', async (c) => {
  const userId = c.get('userId');
  const [rows, allObs] = await Promise.all([
    db.listMoles(c.env.DB, userId),
    db.listObservations(c.env.DB, userId),
  ]);
  const byMole = new Map<string, (db.ObservationRow & { captured_at: number })[]>();
  for (const o of allObs) {
    const list = byMole.get(o.mole_id) ?? [];
    list.push(o);
    byMole.set(o.mole_id, list);
  }
  return c.json({
    moles: rows.map((m) => {
      const views = toViews(byMole.get(m.id) ?? []);
      const latest = views[views.length - 1] ?? null;
      return {
        ...m,
        latest,
        change_score: latest?.change_score ?? null,
        observation_count: views.length,
      };
    }),
  });
});

moles.post('/', async (c) => {
  const parsed = moleSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'invalid' }, 400);
  const userId = c.get('userId');
  await db.upsertUser(c.env.DB, userId);
  const id = crypto.randomUUID();
  await db.insertMole(c.env.DB, {
    id,
    userId,
    label: parsed.data.label ?? '',
    canonical: parsed.data.position,
    source: 'manual',
    status: 'confirmed',
  });
  return c.json({ mole: await db.getMole(c.env.DB, userId, id) }, 201);
});

moles.get('/:id', async (c) => {
  const userId = c.get('userId');
  const mole = await db.getMole(c.env.DB, userId, c.req.param('id'));
  if (!mole) return c.json({ error: 'not found' }, 404);
  return c.json({ mole, observations: toViews(await db.observationsForMole(c.env.DB, mole.id)) });
});

moles.patch('/:id', async (c) => {
  const parsed = patchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid' }, 400);
  const { label, status, retired } = parsed.data;
  const ok = await db.updateMole(c.env.DB, c.get('userId'), c.req.param('id'), {
    label,
    status,
    retiredAt: retired === undefined ? undefined : retired ? Date.now() : null,
  });
  return ok ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404);
});

moles.put('/:id/observations/:visitId', async (c) => {
  const userId = c.get('userId');
  const mole = await db.getMole(c.env.DB, userId, c.req.param('id'));
  if (!mole) return c.json({ error: 'not found' }, 404);
  const visit = await db.getVisit(c.env.DB, userId, c.req.param('visitId'));
  if (!visit) return c.json({ error: 'visit not found' }, 404);
  const parsed = observationSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'invalid' }, 400);
  await db.upsertObservation(c.env.DB, {
    moleId: mole.id,
    visitId: visit.id,
    cropSha256: parsed.data.crop_sha256,
    note: parsed.data.note,
    diameterMm: parsed.data.diameter_mm,
  });
  return c.json({ ok: true });
});

moles.delete('/:id/observations/:visitId', async (c) => {
  const userId = c.get('userId');
  const mole = await db.getMole(c.env.DB, userId, c.req.param('id'));
  if (!mole) return c.json({ error: 'not found' }, 404);
  const ok = await db.deleteObservation(c.env.DB, mole.id, c.req.param('visitId'));
  return ok ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404);
});
