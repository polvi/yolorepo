// Browser-side TPX client: OAuth 2.1 public client (PKCE + PAR) talking to
// the provider directly. Tokens live in localStorage on the site origin; the
// worker never sees them. Ported from tlc-rs, adapted for a popup grant flow
// (the panel is an iframe, and provider pages refuse to be framed).

export interface Provider {
  issuer: string;
  resource: string;
  authorization_endpoint: string;
  token_endpoint: string;
  par_endpoint: string | null;
  revocation_endpoint: string | null;
}

export interface Tokens {
  access_token: string;
  refresh_token?: string;
  budget: number;
  expires_at: number;
  provider: Provider;
}

export const DEFAULT_ISSUER = 'https://api.tokenpony.dev';
export const DEFAULT_MODEL = 'kimi-k2.7-code';
export const DEFAULT_BUDGET = 0.25;

const NS = '/__forkable__';
const K = {
  tokens: 'forkable.tpx.tokens',
  spent: 'forkable.tpx.spent',
  model: 'forkable.tpx.model',
  lock: 'forkable.tpx.refresh_lock',
  pkce: 'forkable.tpx.pkce', // localStorage: the callback runs in a popup
};

const loadJson = <T>(key: string): T | null => {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : null;
  } catch {
    return null;
  }
};
const saveJson = (key: string, v: unknown) => localStorage.setItem(key, JSON.stringify(v));

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randB64url = () => b64url(crypto.getRandomValues(new Uint8Array(32)));
const challengeS256 = async (verifier: string) =>
  b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));

export const usd = (n: number): string => {
  const v = Math.round(n * 1e6) / 1e6;
  return '$' + (v < 0.01 && v > 0 ? v.toFixed(4) : v.toFixed(2));
};

export class GrantGoneError extends Error {
  constructor() {
    super('grant expired or revoked');
  }
}

// ---------- tokens ----------
export const getTokens = (): Tokens | null => loadJson<Tokens>(K.tokens);
const setTokens = (t: Tokens) => saveJson(K.tokens, t);
export const getSpent = (): number => Number(localStorage.getItem(K.spent) ?? '0');
export const addSpent = (cost: number) => localStorage.setItem(K.spent, String(getSpent() + cost));
export const clearGrant = (): void => {
  localStorage.removeItem(K.tokens);
  localStorage.removeItem(K.spent);
};

export const getModel = (): string => localStorage.getItem(K.model) ?? DEFAULT_MODEL;
export const setModel = (m: string) => localStorage.setItem(K.model, m);

// ---------- provider discovery ----------
const stripSlash = (s: string) => s.replace(/\/+$/, '');

export async function discoverProvider(input: string): Promise<Provider> {
  let base: string;
  try {
    base = new URL(input.trim()).origin;
  } catch {
    throw new Error('enter a provider origin, e.g. https://api.tokenpony.dev');
  }
  let resource = base;
  let as = base;
  try {
    const pr = (await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json()) as {
      resource?: string;
      authorization_servers?: string[];
    };
    if (typeof pr.resource === 'string') resource = stripSlash(pr.resource);
    if (pr.authorization_servers?.[0]) as = stripSlash(pr.authorization_servers[0]);
  } catch {
    // provider may be its own AS
  }
  const res = await fetch(`${as}/.well-known/oauth-authorization-server`);
  if (!res.ok) throw new Error(`provider discovery failed (${res.status})`);
  const meta = (await res.json()) as Record<string, unknown>;
  const types = meta.authorization_details_types_supported;
  if (!Array.isArray(types) || !types.includes('llm-inference')) {
    throw new Error('this provider does not support TPX llm-inference grants');
  }
  if (!meta.issuer || !meta.authorization_endpoint || !meta.token_endpoint) {
    throw new Error('provider metadata is incomplete');
  }
  return {
    issuer: stripSlash(meta.issuer as string),
    resource,
    authorization_endpoint: meta.authorization_endpoint as string,
    token_endpoint: meta.token_endpoint as string,
    par_endpoint: (meta.pushed_authorization_request_endpoint as string) || null,
    revocation_endpoint: (meta.revocation_endpoint as string) || null,
  };
}

// ---------- client registration (worker-cached) ----------
async function getClient(refresh: boolean, issuer: string): Promise<{ client_id: string; redirect_uri: string }> {
  const res = await fetch(
    `${NS}/tpx/client?issuer=${encodeURIComponent(issuer)}${refresh ? '&refresh=1' : ''}`
  );
  const body = (await res.json().catch(() => ({}))) as { error?: string; client_id?: string; redirect_uri?: string };
  if (!res.ok || !body.client_id) {
    throw new Error(
      body.error === 'not_a_tpx_provider'
        ? 'this provider does not speak TPX'
        : 'provider registration unavailable; try again in a minute'
    );
  }
  return body as { client_id: string; redirect_uri: string };
}

// ---------- token plumbing ----------
async function tokenRequest(endpoint: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const e = new Error(
      (body.error_description as string) || (body.error as string) || `token endpoint ${res.status}`
    ) as Error & { code?: string };
    e.code = body.error as string;
    throw e;
  }
  return body;
}

function storeTokenResponse(body: Record<string, unknown>, fallbackBudget: number, provider: Provider): void {
  const details = Array.isArray(body.authorization_details)
    ? (body.authorization_details as Array<{ type?: string; budget?: number }>).find(
        (d) => d?.type === 'llm-inference'
      )
    : null;
  setTokens({
    access_token: body.access_token as string,
    refresh_token: body.refresh_token as string | undefined,
    budget: typeof details?.budget === 'number' ? details.budget : fallbackBudget,
    expires_at: Date.now() + (((body.expires_in as number) || 3600) - 300) * 1000,
    provider,
  });
}

// Refresh tokens rotate on use; a best-effort lock keeps two tabs from racing.
let refreshing: Promise<Tokens> | null = null;
function refreshTokens(): Promise<Tokens> {
  refreshing ??= doRefresh().finally(() => {
    refreshing = null;
  });
  return refreshing;
}
async function doRefresh(): Promise<Tokens> {
  const lock = Number(localStorage.getItem(K.lock) ?? '0');
  if (Date.now() - lock < 15000) {
    await new Promise((r) => setTimeout(r, 1500));
    const t = getTokens();
    if (t && Date.now() < t.expires_at) return t;
  }
  localStorage.setItem(K.lock, String(Date.now()));
  try {
    const t = getTokens();
    if (!t?.refresh_token) throw new GrantGoneError();
    const client = await getClient(false, t.provider.issuer);
    const body = await tokenRequest(t.provider.token_endpoint, {
      grant_type: 'refresh_token',
      refresh_token: t.refresh_token,
      client_id: client.client_id,
    });
    storeTokenResponse(body, t.budget, t.provider);
    return getTokens()!;
  } catch (e) {
    if ((e as { code?: string }).code === 'invalid_grant') {
      clearGrant();
      throw new GrantGoneError();
    }
    throw e;
  } finally {
    localStorage.removeItem(K.lock);
  }
}

export async function tpxFetch(path: string, init?: RequestInit): Promise<Response> {
  let t = getTokens();
  if (!t) throw new GrantGoneError();
  if (Date.now() >= t.expires_at) t = await refreshTokens();
  const withAuth = (tok: Tokens) =>
    fetch(tok.provider.resource + path, {
      ...init,
      headers: { ...(init?.headers as Record<string, string>), Authorization: `Bearer ${tok.access_token}` },
    });
  let res = await withAuth(t);
  if (res.status === 401) {
    t = await refreshTokens();
    res = await withAuth(t);
    if (res.status === 401) {
      clearGrant();
      throw new GrantGoneError();
    }
  }
  return res;
}

export async function loadModels(): Promise<string[]> {
  const resource = getTokens()?.provider.resource ?? DEFAULT_ISSUER;
  try {
    const res = await fetch(`${resource}/models`);
    const body = (await res.json()) as { data?: Array<{ id: string }> };
    return (body.data ?? []).map((m) => m.id);
  } catch {
    return [DEFAULT_MODEL];
  }
}

// ---------- grant flow (popup) ----------
/** Build the authorization URL (discovery + registration + PKCE + PAR). */
export async function buildGrantUrl(budget: number, providerInput: string): Promise<string> {
  budget = Math.max(0.01, Math.round(budget * 1e6) / 1e6);
  const p = await discoverProvider(providerInput);
  let client = await getClient(false, p.issuer);
  const verifier = randB64url();
  const state = randB64url();
  saveJson(K.pkce, { verifier, state, provider: p });
  const params: Record<string, string> = {
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: client.redirect_uri,
    code_challenge: await challengeS256(verifier),
    code_challenge_method: 'S256',
    state,
    resource: p.resource,
    authorization_details: JSON.stringify([{ type: 'llm-inference', budget }]),
  };
  if (!p.par_endpoint) return `${p.authorization_endpoint}?${new URLSearchParams(params)}`;

  const par = (q: Record<string, string>) =>
    fetch(p.par_endpoint!, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(q),
    });
  let res = await par(params);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (body.error === 'invalid_client') {
      client = await getClient(true, p.issuer);
      params.client_id = client.client_id;
      params.redirect_uri = client.redirect_uri;
      res = await par(params);
    }
    if (!res.ok) {
      const b2 = (await res.json().catch(() => ({}))) as { error?: string; error_description?: string };
      throw new Error(b2.error_description || b2.error || 'authorization request failed');
    }
  }
  const out = (await res.json()) as { request_uri: string };
  return `${p.authorization_endpoint}?client_id=${encodeURIComponent(params.client_id)}&request_uri=${encodeURIComponent(out.request_uri)}`;
}

/** Runs on the callback page (popup). Returns an error message or null. */
export async function runCallback(): Promise<string | null> {
  const q = new URLSearchParams(location.search);
  const pkce = loadJson<{ verifier: string; state: string; provider: Provider }>(K.pkce);
  localStorage.removeItem(K.pkce);
  if (q.get('error')) return `The provider declined: ${q.get('error_description') || q.get('error')}.`;
  if (!pkce) return 'This response does not match a grant started here; start again.';
  const p = pkce.provider;
  if (q.get('iss') !== p.issuer) return 'Issuer mismatch; refusing to continue.';
  if (q.get('state') !== pkce.state) return 'State mismatch; refusing to continue.';
  const code = q.get('code');
  if (!code) return 'Missing authorization code.';
  try {
    const client = await getClient(false, p.issuer);
    const body = await tokenRequest(p.token_endpoint, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: client.redirect_uri,
      client_id: client.client_id,
      code_verifier: pkce.verifier,
    });
    storeTokenResponse(body, 0, p);
    localStorage.setItem(K.spent, '0');
    return null;
  } catch (e) {
    return `Code exchange failed (${e instanceof Error ? e.message : String(e)}); start again.`;
  }
}

export async function revokeGrant(): Promise<void> {
  const t = getTokens();
  if (t?.refresh_token && t.provider.revocation_endpoint) {
    try {
      const client = await getClient(false, t.provider.issuer);
      await fetch(t.provider.revocation_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          token: t.refresh_token,
          token_type_hint: 'refresh_token',
          client_id: client.client_id,
        }),
      });
    } catch {
      // best-effort
    }
  }
  clearGrant();
}
