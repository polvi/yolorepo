-- Site registry. Repo contents live in the per-site RepoDO (id = repo_id).
CREATE TABLE IF NOT EXISTS sites (
  name TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sites_owner ON sites (owner_user_id);

-- TPX OAuth dynamic client registrations, one per site origin.
CREATE TABLE IF NOT EXISTS tpx_clients (
  origin TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  issuer TEXT NOT NULL,
  registered_at INTEGER NOT NULL
);
