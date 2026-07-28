import { z } from 'zod';

export const CreateSiteRequest = z.object({
  name: z.string().min(1).max(40),
});
export type CreateSiteRequest = z.infer<typeof CreateSiteRequest>;

export const SiteInfo = z.object({
  name: z.string(),
  owner: z.boolean(),
  has_fork: z.boolean(),
});
export type SiteInfo = z.infer<typeof SiteInfo>;

export const SiteSummary = z.object({
  name: z.string(),
  created_at: z.number(),
});
export type SiteSummary = z.infer<typeof SiteSummary>;
