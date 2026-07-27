// Build-time stack configuration. `bun run configure` at the repo root writes
// stack.generated.json; this module reads it so a fork's domain flows into
// every page. When the file is absent (fresh clone, CI), the tracked proc.io
// defaults apply.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface Stack {
  baseDomain: string;
  authEndpoint: string;
}

const DEFAULTS: Stack = {
  baseDomain: 'proc.io',
  authEndpoint: 'https://authgravity.proc.io',
};

// Walk upward looking for stack.generated.json, starting from this file's
// directory (…/happybook/apps/marketing/src/lib, four levels below the repo
// root) and then from the build's working directory as a fallback for
// bundlers that relocate the module.
function findStackFile(): string | null {
  const starts: string[] = [];
  try {
    starts.push(dirname(fileURLToPath(import.meta.url)));
  } catch {
    // import.meta.url may not be a file URL under some bundlers.
  }
  starts.push(process.cwd());
  for (const start of starts) {
    let dir = resolve(start);
    for (let i = 0; i < 10; i++) {
      const candidate = join(dir, 'stack.generated.json');
      if (existsSync(candidate)) return candidate;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

function load(): Stack {
  try {
    const path = findStackFile();
    if (!path) return DEFAULTS;
    return { ...DEFAULTS, ...(JSON.parse(readFileSync(path, 'utf8')) as Partial<Stack>) };
  } catch {
    return DEFAULTS;
  }
}

export const stack: Stack = load();
export const baseDomain: string = stack.baseDomain;
export const appHost = `app.happybook.${baseDomain}`;
export const appUrl = `https://${appHost}`;
export const siteUrl = `https://happybook.${baseDomain}`;
