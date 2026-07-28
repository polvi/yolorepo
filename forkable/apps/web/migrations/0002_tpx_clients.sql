-- Match the (origin, issuer) registration model: one public client per site
-- origin per TPX provider. The v1 table was never populated.
DROP TABLE tpx_clients;
CREATE TABLE tpx_clients (
  origin TEXT NOT NULL,
  issuer TEXT NOT NULL,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  PRIMARY KEY (origin, issuer)
);
