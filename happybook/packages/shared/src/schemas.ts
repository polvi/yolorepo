import { z } from 'zod';

export const rectSchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
});

export const textAnchorSchema = z.object({
  kind: z.literal('text'),
  page: z.number().int().positive(),
  quote: z.string(),
  prefix: z.string(),
  suffix: z.string(),
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  rects: z.array(rectSchema),
});

export const regionAnchorSchema = z.object({
  kind: z.literal('region'),
  page: z.number().int().positive(),
  rect: rectSchema,
});

export const pointAnchorSchema = z.object({
  kind: z.literal('point'),
  page: z.number().int().positive(),
  x: z.number(),
  y: z.number(),
});

export const anchorSchema = z.discriminatedUnion('kind', [
  textAnchorSchema,
  regionAnchorSchema,
  pointAnchorSchema,
]);

export const recordTypeSchema = z.enum(['notebook', 'document', 'highlight', 'link', 'progress']);

export const changeSchema = z.object({
  id: z.string().uuid(),
  type: recordTypeSchema,
  notebookId: z.string().uuid(),
  data: z.unknown(),
  updatedAt: z.number().int().positive(),
  writeId: z.string().uuid(),
  deleted: z.union([z.literal(0), z.literal(1)]),
});

export const pushRequestSchema = z.object({
  changes: z.array(changeSchema).max(200),
});
