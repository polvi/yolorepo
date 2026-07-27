import { readFileSync } from 'node:fs';
import { defineConfig } from 'astro/config';

// `bun run configure` at the repo root writes stack.generated.json; read it
// here so a fork's base domain becomes the canonical site URL. Fall back to
// the tracked proc.io default when it is absent.
let baseDomain = 'proc.io';
try {
  const generated = JSON.parse(
    readFileSync(new URL('../../../stack.generated.json', import.meta.url), 'utf8'),
  );
  if (typeof generated.baseDomain === 'string') baseDomain = generated.baseDomain;
} catch {
  // Fresh clone without stack.generated.json: keep the default.
}

export default defineConfig({
  site: `https://happybook.${baseDomain}`,
});
