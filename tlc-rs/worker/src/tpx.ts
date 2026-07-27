// TPX (tokenpony.dev) integration, server side. The worker holds no LLM
// credentials and never sees TPX tokens: the browser is an OAuth 2.1 public
// client (PKCE + PAR) talking to api.tokenpony.dev directly. The worker's
// only jobs are caching the dynamic client registration (one public
// client_id per origin), serving the OAuth callback shell, and serving the
// shared client script.

import { page } from "./page";
import { TPX_JS } from "./tpx-client";

export const TPX_DEFAULT_ISSUER = "https://api.tokenpony.dev";

// Origin-form https issuers only (no path/query/credentials; RFC 8414 path
// insertion is not supported). Returns the normalized issuer or null.
function normalizeIssuer(raw: string | null): string | null {
  if (!raw) return TPX_DEFAULT_ISSUER;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.search || u.hash || u.username || u.password) return null;
  if (u.pathname !== "/" && u.pathname !== "") return null;
  return u.origin;
}

// The origin the *browser* is on, derived from the Host header rather than
// url.origin: wrangler dev rewrites the request URL to the route's custom
// domain, which would register a prod redirect_uri for a localhost browser.
// The hard allowlist means a forged Host header can't poison the
// registration cache with an attacker-controlled redirect_uri origin.
function clientOrigin(request: Request): string | null {
  const host = request.headers.get("host") ?? new URL(request.url).host;
  if (host === "tlc.proc.io") return "https://tlc.proc.io";
  if (/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) return `http://${host}`;
  return null;
}

/**
 * GET /tpx/client[?issuer=...][&refresh=1] — the public client registration
 * for this origin at the given TPX provider (default: tokenpony), registering
 * lazily (RFC 7591) on first use. The registration endpoint is taken from the
 * issuer's own RFC 8414 metadata, never from the request, so the worker only
 * ever POSTs to a URL the provider itself advertises. refresh=1 forces
 * re-registration; the browser uses it to heal a registration the provider no
 * longer recognizes (PAR/token returns invalid_client).
 */
export async function tpxClient(request: Request, db: D1Database): Promise<Response> {
  const url = new URL(request.url);
  const origin = clientOrigin(request);
  if (!origin) {
    return Response.json({ error: "origin_not_allowed" }, { status: 403 });
  }
  const issuer = normalizeIssuer(url.searchParams.get("issuer"));
  if (!issuer) {
    return Response.json({ error: "invalid_issuer" }, { status: 400 });
  }

  if (url.searchParams.get("refresh") !== "1") {
    const row = await db
      .prepare("SELECT client_id, redirect_uri FROM tpx_clients WHERE origin = ? AND issuer = ?")
      .bind(origin, issuer)
      .first<{ client_id: string; redirect_uri: string }>();
    if (row) {
      return Response.json({ client_id: row.client_id, redirect_uri: row.redirect_uri, issuer });
    }
  }

  // A provider speaks TPX iff its AS metadata advertises the llm-inference
  // authorization details type (tokenpony.dev/llms.txt, step 0).
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
  if (!meta) {
    return Response.json({ error: "provider_discovery_failed" }, { status: 502 });
  }
  if (
    meta.issuer !== issuer ||
    !meta.authorization_details_types_supported?.includes("llm-inference") ||
    !meta.registration_endpoint?.startsWith("https://")
  ) {
    return Response.json({ error: "not_a_tpx_provider" }, { status: 400 });
  }

  const redirectUri = `${origin}/tpx/callback`;
  let clientId: string | undefined;
  try {
    const reg = await fetch(meta.registration_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "tlc.proc.io spec defense",
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "none",
      }),
    });
    if (reg.ok) clientId = ((await reg.json()) as { client_id?: string }).client_id;
  } catch {
    // fall through to the 502 below
  }
  if (!clientId) {
    // Never cache a failure; the next request retries.
    return Response.json({ error: "tpx_registration_failed" }, { status: 502 });
  }

  await db
    .prepare(
      `INSERT INTO tpx_clients (origin, issuer, client_id, redirect_uri) VALUES (?, ?, ?, ?)
       ON CONFLICT(origin, issuer) DO UPDATE SET client_id = excluded.client_id, redirect_uri = excluded.redirect_uri`,
    )
    .bind(origin, issuer, clientId, redirectUri)
    .run();
  return Response.json({ client_id: clientId, redirect_uri: redirectUri, issuer });
}

/**
 * GET /tpx/callback — static shell; the code exchange (iss/state validation,
 * PKCE verifier, token storage) runs client-side in /tpx.js, since only the
 * browser holds the verifier and receives the tokens.
 */
export function tpxCallback(): Response {
  return page(
    "Connecting to tokenpony",
    `<h1>Connecting to tokenpony</h1>
<p id="tpx-cb-status" class="dim">Exchanging authorization code…</p>
<div id="tpx-callback"></div>
<script src="/tpx.js"></script>`,
  );
}

/** GET /tpx.js — shared browser client (OAuth + defense chat). */
export function tpxJs(): Response {
  return new Response(TPX_JS, {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      // Small file; skipping caching avoids stale-JS-vs-new-HTML skew.
      "Cache-Control": "no-cache",
    },
  });
}
