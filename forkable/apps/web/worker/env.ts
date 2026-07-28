export interface Env {
  DB: D1Database;
  REPO: DurableObjectNamespace;
  ASSETS: Fetcher;
  AUTH_ENDPOINT?: string;
  BASE_DOMAIN?: string;
  DEV_USER_ID?: string;
}

export type AppContext = {
  Bindings: Env;
  Variables: {
    userId: string;
    siteName: string;
  };
};

export function baseDomain(env: Env): string {
  return env.BASE_DOMAIN ?? 'proc.io';
}

export function authEndpoint(env: Pick<Env, 'AUTH_ENDPOINT'>): string {
  return env.AUTH_ENDPOINT ?? 'https://authgravity.proc.io';
}

// wrangler dev rewrites request URLs to the deployed route host, so the Host
// header (which keeps the browser's real host) is the source of truth.
export function requestHost(req: Request): string {
  return req.headers.get('host') ?? new URL(req.url).host;
}

export function requestHostname(req: Request): string {
  const host = requestHost(req);
  const colon = host.lastIndexOf(':');
  return colon === -1 ? host : host.slice(0, colon);
}

// The one place site-origin structure is known. hostname -> site name, or null
// for the apex (dashboard) host. Dev hosts (`<site>.localhost`) follow the same
// shape.
export function siteNameFromHostname(hostname: string, env: Env): string | null {
  const host = hostname.toLowerCase();
  const apexes = [`forkable.${baseDomain(env)}`, 'localhost', '127.0.0.1'];
  if (apexes.includes(host)) return null;
  for (const suffix of [`.forkable.${baseDomain(env)}`, '.localhost']) {
    if (host.endsWith(suffix)) {
      const label = host.slice(0, -suffix.length);
      if (label && !label.includes('.')) return label;
    }
  }
  return null;
}
