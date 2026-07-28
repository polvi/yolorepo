import { REF_MAIN, SEED_SITE_NAME, SYSTEM_OWNER_ID, validateSiteName } from '@forkable/shared';
import type { Env } from './env';
import { SEED_FILES } from './template/site';

export interface SiteRow {
  name: string;
  owner_user_id: string;
  repo_id: string;
  created_at: number;
}

export function repoStub(env: Env, repoId: string): DurableObjectStub {
  return env.REPO.get(env.REPO.idFromName(repoId));
}

// DO fetch requires an absolute URL; the host is ignored.
export const REPO_BASE = 'https://repo';

export async function getSite(env: Env, name: string): Promise<SiteRow | null> {
  const row = await env.DB.prepare('SELECT * FROM sites WHERE name = ?')
    .bind(name)
    .first<SiteRow>();
  return row ?? null;
}

export async function ensureSeed(env: Env): Promise<SiteRow> {
  const existing = await getSite(env, SEED_SITE_NAME);
  if (existing) return existing;

  const row: SiteRow = {
    name: SEED_SITE_NAME,
    owner_user_id: SYSTEM_OWNER_ID,
    repo_id: crypto.randomUUID(),
    created_at: Date.now(),
  };
  await env.DB.prepare(
    'INSERT INTO sites (name, owner_user_id, repo_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (name) DO NOTHING'
  )
    .bind(row.name, row.owner_user_id, row.repo_id, row.created_at)
    .run();
  // Re-read in case a concurrent request won the insert race.
  const won = await getSite(env, SEED_SITE_NAME);
  if (!won) throw new Error('seed site insert failed');
  if (won.repo_id === row.repo_id) {
    const res = await repoStub(env, row.repo_id).fetch(`${REPO_BASE}/internal/init`, {
      method: 'POST',
      body: JSON.stringify({ files: SEED_FILES }),
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) throw new Error(`seed init failed: ${res.status}`);
  }
  return won;
}

export async function createSite(
  env: Env,
  userId: string,
  name: string
): Promise<{ site?: SiteRow; error?: string; status?: number }> {
  const invalid = validateSiteName(name);
  if (invalid) return { error: invalid, status: 400 };

  const seed = await ensureSeed(env);
  const row: SiteRow = {
    name,
    owner_user_id: userId,
    repo_id: crypto.randomUUID(),
    created_at: Date.now(),
  };
  const insert = await env.DB.prepare(
    'INSERT INTO sites (name, owner_user_id, repo_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (name) DO NOTHING'
  )
    .bind(row.name, row.owner_user_id, row.repo_id, row.created_at)
    .run();
  if (!insert.meta.changes) return { error: 'That name is taken.', status: 409 };

  // Fork the seed: pipe its main closure into the new repo. The payload is
  // opaque to this worker (JSON for the stub DO, a packfile for the real one).
  const exported = await repoStub(env, seed.repo_id).fetch(
    `${REPO_BASE}/internal/export?ref=${encodeURIComponent(REF_MAIN)}`
  );
  if (!exported.ok) {
    await deleteSite(env, row);
    return { error: 'seed export failed', status: 500 };
  }
  const headOid = exported.headers.get('X-Head-Oid') ?? '';
  const imported = await repoStub(env, row.repo_id).fetch(
    `${REPO_BASE}/internal/import?ref=${encodeURIComponent(REF_MAIN)}&oid=${encodeURIComponent(headOid)}`,
    { method: 'POST', body: exported.body, headers: { 'Content-Type': exported.headers.get('Content-Type') ?? 'application/octet-stream' } }
  );
  if (!imported.ok) {
    await deleteSite(env, row);
    return { error: 'fork import failed', status: 500 };
  }
  return { site: row };
}

export async function listSites(env: Env, userId: string): Promise<SiteRow[]> {
  const { results } = await env.DB.prepare(
    'SELECT * FROM sites WHERE owner_user_id = ? ORDER BY created_at DESC'
  )
    .bind(userId)
    .all<SiteRow>();
  return results;
}

export async function deleteSite(env: Env, site: SiteRow): Promise<void> {
  await repoStub(env, site.repo_id)
    .fetch(`${REPO_BASE}/internal/destroy`, { method: 'POST' })
    .catch(() => {});
  await env.DB.prepare('DELETE FROM sites WHERE name = ? AND repo_id = ?')
    .bind(site.name, site.repo_id)
    .run();
}
