-- downstream: users arrive via GitHub OAuth; posts hang off repos.
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  github_id INTEGER NOT NULL UNIQUE,
  login TEXT NOT NULL,
  name TEXT,
  avatar_url TEXT,
  gh_token TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- One row per pending /authorize visit, consumed at /callback.
CREATE TABLE oauth_requests (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  state TEXT,
  code_challenge TEXT NOT NULL,
  scope TEXT,
  resource TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Single-use authorization codes. Redemption must be the atomic
-- UPDATE ... WHERE consumed = 0 pattern; never SELECT-then-UPDATE.
CREATE TABLE oauth_codes (
  code_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  scope TEXT,
  resource TEXT,
  expires_at INTEGER NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE tokens (
  token_hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
  user_id INTEGER NOT NULL REFERENCES users(id),
  client_id TEXT NOT NULL,
  scope TEXT,
  resource TEXT,
  expires_at INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0
);

-- Dynamic Client Registration (deprecated in MCP 2026-07-28 but kept for
-- older clients; CIMD clients never appear here).
CREATE TABLE oauth_clients (
  client_id TEXT PRIMARY KEY,
  metadata TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE repos (
  id INTEGER PRIMARY KEY,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (owner, name)
);

CREATE TABLE posts (
  id INTEGER PRIMARY KEY,
  repo_id INTEGER NOT NULL REFERENCES repos(id),
  number INTEGER NOT NULL,
  author_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('finding', 'question', 'guide', 'idea', 'bug')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'declined', 'done')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (repo_id, number)
);

CREATE TABLE comments (
  id INTEGER PRIMARY KEY,
  post_id INTEGER NOT NULL REFERENCES posts(id),
  author_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_posts_repo ON posts(repo_id, kind);
CREATE INDEX idx_comments_post ON comments(post_id);
CREATE INDEX idx_tokens_expiry ON tokens(expires_at);
