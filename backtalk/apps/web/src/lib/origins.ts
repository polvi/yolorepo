// Origins are derived from location.hostname so forks run on their own base
// domain unchanged; proc.io appears only as the dev fallback. Auth happens
// in-page against authgravity.<base> (see authg.ts), never on hosted screens.
const UPSTREAM_BASE_DOMAIN = 'proc.io';
const APP_PREFIX = 'backtalk.';

export function baseDomain(): string {
  const h = location.hostname;
  return h.startsWith(APP_PREFIX) ? h.slice(APP_PREFIX.length) : UPSTREAM_BASE_DOMAIN;
}
