// downstream is both the MCP resource server and its own OAuth 2.1
// authorization server (MCP spec 2026-07-28). GitHub is the upstream
// identity provider: /authorize bounces through github.com, /callback
// mints our single-use code, /token exchanges it under PKCE.
//
// Model-checked in specs/DownstreamAuth.tla: code redemption must be the
// atomic UPDATE ... WHERE consumed = 0 RETURNING form.

import { Hono } from "hono";
import type { Env } from "./env";
import { apiOrigin, mcpResource, webOrigin } from "./env";
import { pkceMatches, randomToken, sha256hex } from "./crypto";
import { github } from "./github";

const CODE_TTL_S = 300;
const ACCESS_TTL_S = 30 * 24 * 3600;
const REFRESH_TTL_S = 90 * 24 * 3600;
const SCOPE = "downstream";

const now = () => Math.floor(Date.now() / 1000);

export function protectedResourceMetadata(env: Env) {
  return {
    resource: mcpResource(env),
    authorization_servers: [apiOrigin(env)],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "downstream",
    resource_documentation: `${webOrigin(env)}/docs`,
  };
}

export function authServerMetadata(env: Env) {
  const issuer = apiOrigin(env);
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`,
    revocation_endpoint: `${issuer}/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [SCOPE],
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: true,
    service_documentation: `${webOrigin(env)}/docs`,
  };
}

export function unauthorized(env: Env, description?: string): Response {
  const parts = [
    `Bearer resource_metadata="${apiOrigin(env)}/.well-known/oauth-protected-resource"`,
    `scope="${SCOPE}"`,
  ];
  if (description) parts.push(`error="invalid_token"`, `error_description="${description}"`);
  return new Response(JSON.stringify({ error: "unauthorized", error_description: description ?? "authorization required" }), {
    status: 401,
    headers: { "Content-Type": "application/json", "WWW-Authenticate": parts.join(", ") },
  });
}

export type AuthedUser = {
  id: number;
  github_id: number;
  login: string;
  name: string | null;
  avatar_url: string | null;
  gh_token: string | null;
};

/** Validate a Bearer token for the MCP resource. Returns null if invalid. */
export async function authenticate(env: Env, req: Request): Promise<AuthedUser | null> {
  const auth = req.headers.get("Authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const hash = await sha256hex(m[1].trim());
  const row = await env.DB.prepare(
    `SELECT u.id, u.github_id, u.login, u.name, u.avatar_url, u.gh_token, t.resource
       FROM tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = ? AND t.kind = 'access' AND t.revoked = 0 AND t.expires_at > ?`,
  )
    .bind(hash, now())
    .first<any>();
  if (!row) return null;
  // RFC 8707 audience check: only accept tokens minted for this MCP server.
  if (row.resource && row.resource !== mcpResource(env)) return null;
  const { resource: _drop, ...user } = row;
  return user as AuthedUser;
}

async function resolveRedirectUris(env: Env, clientId: string): Promise<string[] | null> {
  if (/^https:\/\//.test(clientId)) {
    // Client ID Metadata Document: the client_id IS a URL to its metadata.
    try {
      const res = await fetch(clientId, {
        headers: { Accept: "application/json", "User-Agent": "downstream-mcp" },
      });
      if (!res.ok) return null;
      const doc: any = await res.json();
      if (doc.client_id && doc.client_id !== clientId) return null;
      if (!Array.isArray(doc.redirect_uris)) return null;
      return doc.redirect_uris.filter((u: unknown) => typeof u === "string");
    } catch {
      return null;
    }
  }
  const row = await env.DB.prepare("SELECT metadata FROM oauth_clients WHERE client_id = ?")
    .bind(clientId)
    .first<{ metadata: string }>();
  if (!row) return null;
  try {
    const meta = JSON.parse(row.metadata);
    return Array.isArray(meta.redirect_uris) ? meta.redirect_uris : [];
  } catch {
    return [];
  }
}

function htmlError(title: string, detail: string): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="font-family:ui-monospace,monospace;max-width:40rem;margin:4rem auto;padding:0 1rem"><h1 style="font-size:1.2rem">${title}</h1><p>${detail}</p></body>`,
    { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

function tokenError(error: string, description: string, status = 400): Response {
  return new Response(JSON.stringify({ error, error_description: description }), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export const oauthRoutes = new Hono<{ Bindings: Env }>();

oauthRoutes.get("/.well-known/oauth-protected-resource", (c) => c.json(protectedResourceMetadata(c.env)));
oauthRoutes.get("/.well-known/oauth-protected-resource/mcp", (c) => c.json(protectedResourceMetadata(c.env)));
oauthRoutes.get("/.well-known/oauth-authorization-server", (c) => c.json(authServerMetadata(c.env)));

// Dynamic Client Registration — deprecated in 2026-07-28, kept for older clients.
oauthRoutes.post("/register", async (c) => {
  let meta: any;
  try {
    meta = await c.req.json();
  } catch {
    return tokenError("invalid_client_metadata", "body must be JSON");
  }
  if (!Array.isArray(meta.redirect_uris) || meta.redirect_uris.length === 0) {
    return tokenError("invalid_redirect_uri", "redirect_uris is required");
  }
  const clientId = randomToken("dsc_");
  await c.env.DB.prepare("INSERT INTO oauth_clients (client_id, metadata) VALUES (?, ?)")
    .bind(clientId, JSON.stringify(meta))
    .run();
  return c.json(
    { client_id: clientId, token_endpoint_auth_method: "none", ...meta },
    201,
  );
});

oauthRoutes.get("/authorize", async (c) => {
  const q = c.req.query();
  if (!c.env.GITHUB_CLIENT_ID || !c.env.GITHUB_CLIENT_SECRET) {
    return htmlError(
      "GitHub sign-in not configured",
      "This downstream deployment has no GitHub OAuth app yet. The operator must create one (callback URL: this origin + /callback) and set the GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET secrets.",
    );
  }
  if (q.response_type !== "code") return htmlError("Unsupported response_type", "Only response_type=code is supported.");
  if (!q.client_id || !q.redirect_uri) return htmlError("Missing parameter", "client_id and redirect_uri are required.");
  if (!q.code_challenge || (q.code_challenge_method || "S256") !== "S256") {
    return htmlError("PKCE required", "code_challenge with method S256 is required.");
  }
  const uris = await resolveRedirectUris(c.env, q.client_id);
  if (uris === null) return htmlError("Unknown client", "client_id is not a resolvable Client ID Metadata Document or registered client.");
  if (!uris.includes(q.redirect_uri)) return htmlError("redirect_uri mismatch", "redirect_uri is not registered for this client.");

  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    "INSERT INTO oauth_requests (id, client_id, redirect_uri, state, code_challenge, scope, resource) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(id, q.client_id, q.redirect_uri, q.state ?? null, q.code_challenge, q.scope ?? SCOPE, q.resource ?? mcpResource(c.env))
    .run();

  const gh = new URL("https://github.com/login/oauth/authorize");
  gh.searchParams.set("client_id", c.env.GITHUB_CLIENT_ID);
  gh.searchParams.set("redirect_uri", `${apiOrigin(c.env)}/callback`);
  gh.searchParams.set("state", id);
  // No GitHub scopes: public read access + identity is all we need.
  return c.redirect(gh.toString(), 302);
});

oauthRoutes.get("/callback", async (c) => {
  const { code, state, error } = c.req.query();
  if (!state) return htmlError("Missing state", "Start over from your MCP client.");
  const reqRow = await c.env.DB.prepare("DELETE FROM oauth_requests WHERE id = ? RETURNING *")
    .bind(state)
    .first<any>();
  if (!reqRow) return htmlError("Unknown or expired authorization request", "Start over from your MCP client.");

  const redirect = new URL(reqRow.redirect_uri);
  if (reqRow.state) redirect.searchParams.set("state", reqRow.state);
  redirect.searchParams.set("iss", apiOrigin(c.env)); // RFC 9207

  if (error || !code) {
    redirect.searchParams.set("error", error || "access_denied");
    return c.redirect(redirect.toString(), 302);
  }

  const ghRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": "downstream-mcp" },
    body: JSON.stringify({
      client_id: c.env.GITHUB_CLIENT_ID,
      client_secret: c.env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${apiOrigin(c.env)}/callback`,
    }),
  });
  const ghTok: any = await ghRes.json();
  if (!ghTok.access_token) {
    redirect.searchParams.set("error", "access_denied");
    redirect.searchParams.set("error_description", "GitHub token exchange failed");
    return c.redirect(redirect.toString(), 302);
  }

  const ghUser: any = await github.user(ghTok.access_token);
  const user = await c.env.DB.prepare(
    `INSERT INTO users (github_id, login, name, avatar_url, gh_token) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(github_id) DO UPDATE SET login = excluded.login, name = excluded.name,
       avatar_url = excluded.avatar_url, gh_token = excluded.gh_token
     RETURNING id`,
  )
    .bind(ghUser.id, ghUser.login, ghUser.name ?? null, ghUser.avatar_url ?? null, ghTok.access_token)
    .first<{ id: number }>();

  const ourCode = randomToken("dsac_");
  await c.env.DB.prepare(
    `INSERT INTO oauth_codes (code_hash, user_id, client_id, redirect_uri, code_challenge, scope, resource, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(await sha256hex(ourCode), user!.id, reqRow.client_id, reqRow.redirect_uri, reqRow.code_challenge, reqRow.scope, reqRow.resource, now() + CODE_TTL_S)
    .run();

  redirect.searchParams.set("code", ourCode);
  return c.redirect(redirect.toString(), 302);
});

oauthRoutes.post("/token", async (c) => {
  const form = await c.req.parseBody();
  const grant = form["grant_type"];

  if (grant === "authorization_code") {
    const code = String(form["code"] ?? "");
    const verifier = String(form["code_verifier"] ?? "");
    const clientId = String(form["client_id"] ?? "");
    if (!code || !verifier || !clientId) return tokenError("invalid_request", "code, code_verifier and client_id are required");

    // Atomic single-use consumption (see specs/DownstreamAuth.tla).
    const row = await c.env.DB.prepare(
      "UPDATE oauth_codes SET consumed = 1 WHERE code_hash = ? AND consumed = 0 AND expires_at > ? RETURNING *",
    )
      .bind(await sha256hex(code), now())
      .first<any>();
    if (!row) return tokenError("invalid_grant", "code is invalid, expired, or already used");
    if (row.client_id !== clientId) return tokenError("invalid_grant", "client_id mismatch");
    if (form["redirect_uri"] && String(form["redirect_uri"]) !== row.redirect_uri) {
      return tokenError("invalid_grant", "redirect_uri mismatch");
    }
    if (!(await pkceMatches(verifier, row.code_challenge))) return tokenError("invalid_grant", "PKCE verification failed");
    const resource = form["resource"] ? String(form["resource"]) : row.resource;
    if (resource !== row.resource) return tokenError("invalid_target", "resource mismatch");

    return c.json(await mintTokens(c.env, row.user_id, row.client_id, row.scope, row.resource), 200, {
      "Cache-Control": "no-store",
    });
  }

  if (grant === "refresh_token") {
    const refresh = String(form["refresh_token"] ?? "");
    if (!refresh) return tokenError("invalid_request", "refresh_token is required");
    // Rotate: revoke atomically so a replayed refresh token fails.
    const row = await c.env.DB.prepare(
      "UPDATE tokens SET revoked = 1 WHERE token_hash = ? AND kind = 'refresh' AND revoked = 0 AND expires_at > ? RETURNING *",
    )
      .bind(await sha256hex(refresh), now())
      .first<any>();
    if (!row) return tokenError("invalid_grant", "refresh token is invalid, expired, or already used");
    return c.json(await mintTokens(c.env, row.user_id, row.client_id, row.scope, row.resource), 200, {
      "Cache-Control": "no-store",
    });
  }

  return tokenError("unsupported_grant_type", `unsupported grant_type ${String(grant)}`);
});

oauthRoutes.post("/revoke", async (c) => {
  const form = await c.req.parseBody();
  const token = String(form["token"] ?? "");
  if (token) {
    await c.env.DB.prepare("UPDATE tokens SET revoked = 1 WHERE token_hash = ?")
      .bind(await sha256hex(token))
      .run();
  }
  return new Response(null, { status: 200 });
});

async function mintTokens(env: Env, userId: number, clientId: string, scope: string | null, resource: string | null) {
  const access = randomToken("ds_");
  const refresh = randomToken("dsr_");
  const t = now();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO tokens (token_hash, kind, user_id, client_id, scope, resource, expires_at) VALUES (?, 'access', ?, ?, ?, ?, ?)")
      .bind(await sha256hex(access), userId, clientId, scope, resource, t + ACCESS_TTL_S),
    env.DB.prepare("INSERT INTO tokens (token_hash, kind, user_id, client_id, scope, resource, expires_at) VALUES (?, 'refresh', ?, ?, ?, ?, ?)")
      .bind(await sha256hex(refresh), userId, clientId, scope, resource, t + REFRESH_TTL_S),
  ]);
  return {
    access_token: access,
    token_type: "Bearer",
    expires_in: ACCESS_TTL_S,
    refresh_token: refresh,
    scope: scope ?? SCOPE,
  };
}
