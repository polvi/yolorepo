// The stack's base domain, derived from wherever the page is served. This
// surface runs at auth.<base> and its peers (AuthGravity, the apps it signs
// users into) live on sibling subdomains of the same base, so a fork on a
// different domain works with zero configuration. Pass location.hostname in
// browser code and Astro.url.hostname in server-rendered code.

export function stackBase(hostname: string): string {
  // Dev fallback: local serving has no meaningful base domain.
  if (hostname === "localhost" || hostname === "127.0.0.1") return "proc.io";
  return hostname.startsWith("auth.") ? hostname.slice("auth.".length) : hostname.replace(/^[^.]+\./, "");
}

export const authgravityOrigin = (hostname: string): string =>
  `https://authgravity.${stackBase(hostname)}`;
