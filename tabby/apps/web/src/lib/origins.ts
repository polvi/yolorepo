// Origins are derived from location.hostname so forks run on their own base
// domain unchanged; proc.io appears only as the dev fallback.
const UPSTREAM_BASE_DOMAIN = 'proc.io';
const APP_PREFIX = 'tabby.';

export function baseDomain(): string {
  const h = location.hostname;
  return h.startsWith(APP_PREFIX) ? h.slice(APP_PREFIX.length) : UPSTREAM_BASE_DOMAIN;
}

export function loginUrl(): string {
  return `https://auth.${baseDomain()}/login?return_to=${encodeURIComponent(location.href)}`;
}

export function registerUrl(): string {
  return `https://auth.${baseDomain()}/register?return_to=${encodeURIComponent(location.href)}`;
}

export function accountUrl(): string {
  return `https://auth.${baseDomain()}/account?return_to=${encodeURIComponent(location.href)}`;
}
