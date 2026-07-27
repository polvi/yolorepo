// Stack configuration loader: stack.config.jsonc (tracked upstream defaults)
// deep-merged with stack.local.jsonc (gitignored fork overrides). Everything
// that varies per deployment — base domain, auth endpoint, resource IDs —
// resolves through here so forks never edit tracked files.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface StackConfig {
  baseDomain: string;
  authEndpoint: string;
  d1: Record<string, string>;
}

export const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

// Strip // and /* */ comments without touching string contents (URLs contain //).
function stripJsoncComments(src: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (inString) {
      out += c;
      if (c === '\\') { out += src[++i] ?? ''; continue; }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

function readJsonc(path: string): Record<string, unknown> {
  return JSON.parse(stripJsoncComments(readFileSync(path, 'utf8')));
}

export function loadStack(): StackConfig {
  const base = readJsonc(join(repoRoot, 'stack.config.jsonc'));
  const localPath = join(repoRoot, 'stack.local.jsonc');
  const local = existsSync(localPath) ? readJsonc(localPath) : {};
  // A local d1 map replaces the upstream one wholesale: a fork's account
  // doesn't have upstream's databases, so inheriting those IDs would only
  // produce confusing deploy failures.
  const merged = {
    ...base,
    ...local,
    d1: ('d1' in local ? local.d1 : base.d1) as Record<string, string>,
  } as { baseDomain: string; authEndpoint: string | null; d1: Record<string, string> };
  return {
    baseDomain: merged.baseDomain,
    authEndpoint: merged.authEndpoint ?? `https://authgravity.${merged.baseDomain}`,
    d1: merged.d1,
  };
}
