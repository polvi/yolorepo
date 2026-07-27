-- Re-key TPX client registrations by (origin, issuer): visitors may fund the
-- defense chat from any TPX-speaking provider, and RFC 7591 registration is
-- once per provider. Existing rows are the tokenpony reference provider.
ALTER TABLE tpx_clients RENAME TO tpx_clients_old;
CREATE TABLE tpx_clients (
  origin TEXT NOT NULL,
  issuer TEXT NOT NULL,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (origin, issuer)
);
INSERT INTO tpx_clients (origin, issuer, client_id, redirect_uri, created_at)
  SELECT origin, 'https://api.tokenpony.dev', client_id, redirect_uri, created_at
  FROM tpx_clients_old;
DROP TABLE tpx_clients_old;
