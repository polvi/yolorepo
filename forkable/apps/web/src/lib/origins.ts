// The one place browser code derives peer origins from its own hostname.
// Site pages live at <site>.forkable.<base> (or <site>.localhost in dev).

export function baseDomain(): string {
  const m = location.hostname.match(/^[^.]+\.forkable\.(.+)$/);
  return m ? m[1]! : 'proc.io';
}

export function loginUrl(): string {
  // procauth, the stack's themed auth surface (resolves the forkable theme
  // from return_to).
  return `https://auth.${baseDomain()}/login?return_to=${encodeURIComponent(location.href)}`;
}
