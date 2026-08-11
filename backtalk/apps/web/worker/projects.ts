import { Hono } from 'hono';
import { z } from 'zod';
import type { AppContext } from './env';
import * as db from './db';
import { generatePublicKey } from './auth';

const createSchema = z.object({ name: z.string().trim().min(1).max(80) });
const patchSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  // Comma-separated exact origins, e.g. "https://tabby.proc.io"; '' = any.
  allowed_origins: z
    .string()
    .max(2000)
    .refine(
      (s) =>
        s
          .split(',')
          .map((o) => o.trim())
          .filter(Boolean)
          .every((o) => /^https?:\/\/[^\s/]+$/.test(o)),
      'origins must look like https://host, comma-separated'
    )
    .optional(),
});

const DAYS_DEFAULT = 14;

export const projects = new Hono<AppContext>();

projects.get('/', async (c) => {
  const userId = c.get('userId');
  await db.upsertUser(c.env.DB, userId);
  return c.json({ projects: await db.listProjects(c.env.DB, userId) });
});

projects.post('/', async (c) => {
  const parsed = createSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid project name' }, 400);
  const userId = c.get('userId');
  await db.upsertUser(c.env.DB, userId);
  const id = crypto.randomUUID();
  const publicKey = generatePublicKey();
  await db.createProject(c.env.DB, { id, ownerId: userId, name: parsed.data.name, publicKey });
  return c.json({ id, public_key: publicKey }, 201);
});

projects.get('/:id', async (c) => {
  const project = await db.getProject(c.env.DB, c.get('userId'), c.req.param('id'));
  if (!project) return c.json({ error: 'not found' }, 404);
  return c.json({ project, counts: await db.projectCounts(c.env.DB, project.id) });
});

projects.patch('/:id', async (c) => {
  const parsed = patchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'invalid' }, 400);
  const ok = await db.updateProject(c.env.DB, c.get('userId'), c.req.param('id'), {
    name: parsed.data.name,
    allowedOrigins: parsed.data.allowed_origins,
  });
  return ok ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404);
});

projects.delete('/:id', async (c) => {
  const ok = await db.deleteProject(c.env.DB, c.get('userId'), c.req.param('id'));
  return ok ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404);
});

projects.get('/:id/feedback', async (c) => {
  const project = await db.getProject(c.env.DB, c.get('userId'), c.req.param('id'));
  if (!project) return c.json({ error: 'not found' }, 404);
  const status = c.req.query('status') as never;
  const limit = Math.min(Number(c.req.query('limit')) || 100, 500);
  return c.json({ items: await db.listFeedback(c.env.DB, project.id, status || undefined, limit) });
});

projects.get('/:id/errors', async (c) => {
  const project = await db.getProject(c.env.DB, c.get('userId'), c.req.param('id'));
  if (!project) return c.json({ error: 'not found' }, 404);
  const status = c.req.query('status') as never;
  const limit = Math.min(Number(c.req.query('limit')) || 100, 500);
  return c.json({
    groups: await db.listErrorGroups(c.env.DB, project.id, status || undefined, limit),
  });
});

projects.get('/:id/stats', async (c) => {
  const project = await db.getProject(c.env.DB, c.get('userId'), c.req.param('id'));
  if (!project) return c.json({ error: 'not found' }, 404);
  const days = Math.min(Number(c.req.query('days')) || DAYS_DEFAULT, 90);
  const since = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
  return c.json(await db.statsOverview(c.env.DB, project.id, since));
});
