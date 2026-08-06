// Origin derivation for the downstream web app. The site serves at
// downstream.<base>; the API worker lives at api.downstream.<base>. Works
// server-side (pass Astro.url.hostname) and in the browser (pass
// location.hostname). Hostnames without the downstream. prefix (localhost dev,
// previews) fall back to the upstream proc.io deployment.

const UPSTREAM_BASE_DOMAIN = "proc.io";
const APP_PREFIX = "downstream.";

export function siteBase(hostname: string): string {
  return hostname.startsWith(APP_PREFIX)
    ? hostname.slice(APP_PREFIX.length)
    : UPSTREAM_BASE_DOMAIN;
}

export function siteOrigin(hostname: string): string {
  return `https://downstream.${siteBase(hostname)}`;
}

export function apiOrigin(hostname: string): string {
  return `https://api.downstream.${siteBase(hostname)}`;
}

export function mcpEndpoint(hostname: string): string {
  return `${apiOrigin(hostname)}/mcp`;
}
