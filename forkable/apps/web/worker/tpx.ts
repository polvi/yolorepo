// TPX (tokenpony.dev) integration, server side. The worker holds no LLM
// credentials and never sees TPX tokens: the browser is an OAuth 2.1 public
// client (PKCE + PAR) talking to the provider directly. The worker only
// caches the dynamic client registration (one public client_id per site
// origin per provider). Ported from tlc-rs/worker/src/tpx.ts.

import { NS_TPX } from '@forkable/shared';

export const TPX_DEFAULT_ISSUER = 'https://api.tokenpony.dev';

// Origin-form https issuers only (no path/query/credentials).
function normalizeIssuer(raw: string | null): string | null {
  if (!raw) return TPX_DEFAULT_ISSUER;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.search || u.hash || u.username || u.password) return null;
  if (u.pathname !== '/' && u.pathname !== '') return null;
  return u.origin;
}

// The origin the *browser* is on, from the Host header (wrangler dev rewrites
// request URLs to the route host). Allowlist: the route's own host, or
// localhost forms (including <site>.localhost) for dev.
function clientOrigin(request: Request): string | null {
  const routeUrl = new URL(request.url);
  const host = request.headers.get('host') ?? routeUrl.host;
  if (host === routeUrl.host) return `${routeUrl.protocol}//${host}`;
  if (/^([a-z0-9-]+\.)?(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) return `http://${host}`;
  return null;
}

/**
 * GET .../tpx/client[?issuer=...][&refresh=1] — the public client
 * registration for this site origin at the given TPX provider, registered
 * lazily (RFC 7591) against the endpoint the provider's own RFC 8414
 * metadata advertises. refresh=1 forces re-registration.
 */
export async function tpxClient(request: Request, db: D1Database): Promise<Response> {
  const url = new URL(request.url);
  const origin = clientOrigin(request);
  if (!origin) return Response.json({ error: 'origin_not_allowed' }, { status: 403 });
  const issuer = normalizeIssuer(url.searchParams.get('issuer'));
  if (!issuer) return Response.json({ error: 'invalid_issuer' }, { status: 400 });

  if (url.searchParams.get('refresh') !== '1') {
    const row = await db
      .prepare('SELECT client_id, redirect_uri FROM tpx_clients WHERE origin = ? AND issuer = ?')
      .bind(origin, issuer)
      .first<{ client_id: string; redirect_uri: string }>();
    if (row) return Response.json({ client_id: row.client_id, redirect_uri: row.redirect_uri, issuer });
  }

  interface AsMeta {
    issuer?: string;
    registration_endpoint?: string;
    authorization_details_types_supported?: string[];
  }
  let meta: AsMeta | undefined;
  try {
    const res = await fetch(`${issuer}/.well-known/oauth-authorization-server`);
    if (res.ok) meta = (await res.json()) as AsMeta;
  } catch {
    // handled below
  }
  if (!meta) return Response.json({ error: 'provider_discovery_failed' }, { status: 502 });
  if (
    meta.issuer !== issuer ||
    !meta.authorization_details_types_supported?.includes('llm-inference') ||
    !meta.registration_endpoint?.startsWith('https://')
  ) {
    return Response.json({ error: 'not_a_tpx_provider' }, { status: 400 });
  }

  const redirectUri = `${origin}${NS_TPX}/callback`;
  let clientId: string | undefined;
  try {
    const reg = await fetch(meta.registration_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: `${new URL(origin).host} via forkable`,
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: 'none',
      }),
    });
    if (reg.ok) clientId = ((await reg.json()) as { client_id?: string }).client_id;
  } catch {
    // fall through
  }
  if (!clientId) return Response.json({ error: 'tpx_registration_failed' }, { status: 502 });

  await db
    .prepare(
      `INSERT INTO tpx_clients (origin, issuer, client_id, redirect_uri) VALUES (?, ?, ?, ?)
       ON CONFLICT(origin, issuer) DO UPDATE SET client_id = excluded.client_id, redirect_uri = excluded.redirect_uri`
    )
    .bind(origin, issuer, clientId, redirectUri)
    .run();
  return Response.json({ client_id: clientId, redirect_uri: redirectUri, issuer });
}
