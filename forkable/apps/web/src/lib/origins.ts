// The one place browser code derives peer origins from its own hostname.
// Site pages live at <site>.forkable.<base> (or <site>.localhost in dev).

export function baseDomain(): string {
  const m = location.hostname.match(/^[^.]+\.forkable\.(.+)$/);
  return m ? m[1]! : 'proc.io';
}

export function authgravityOrigin(): string {
  return `https://authgravity.${baseDomain()}`;
}

export function loginUrl(): string {
  return `${authgravityOrigin()}/login?return_to=${encodeURIComponent(location.href)}`;
}
