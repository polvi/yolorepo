-- TPX (tokenpony.dev) OAuth dynamic client registrations, one per origin
-- (prod custom domain + localhost dev). client_id is public; the client is
-- registered with token_endpoint_auth_method "none", so no secret exists.
CREATE TABLE tpx_clients (
  origin TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
