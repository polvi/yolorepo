export const SITE_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

export const RESERVED_NAMES = new Set([
  'www',
  'api',
  'app',
  'auth',
  'git',
  'admin',
  'static',
  'cdn',
  'mail',
  'forkable',
  'dashboard',
  'docs',
  'help',
  'status',
  'blog',
  'dev',
  'staging',
  'test',
  'root',
  'system',
]);

export const SEED_SITE_NAME = 'start';
export const SYSTEM_OWNER_ID = 'system';

export function validateSiteName(name: string): string | null {
  if (!SITE_NAME_RE.test(name)) {
    return 'Names are 1-40 characters of lowercase letters, numbers, and hyphens (no leading or trailing hyphen).';
  }
  if (RESERVED_NAMES.has(name)) {
    return 'That name is reserved.';
  }
  return null;
}
