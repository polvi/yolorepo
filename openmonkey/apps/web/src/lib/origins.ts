// Origin derivation for the openmonkey web app. The site serves at
// openmonkey.<base>; siblings live at api.openmonkey.<base>, auth.<base>, and
// authgravity.<base>. Works server-side (pass Astro.url.hostname) and in the
// browser (pass location.hostname). Hostnames without the openmonkey. prefix
// (localhost dev, previews) fall back to the upstream proc.io deployment.
import { baseDomainFromHostname } from "@openmonkey/shared";

export function siteBase(hostname: string): string {
  return baseDomainFromHostname(hostname, "openmonkey.");
}

export function siteOrigin(hostname: string): string {
  return `https://openmonkey.${siteBase(hostname)}`;
}

export function apiOrigin(hostname: string): string {
  return `https://api.openmonkey.${siteBase(hostname)}`;
}

export function authOrigin(hostname: string): string {
  return `https://auth.${siteBase(hostname)}`;
}

export function authGravityOrigin(hostname: string): string {
  return `https://authgravity.${siteBase(hostname)}`;
}
