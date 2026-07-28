// wrangler dev simulates the first configured route's host, rewriting every
// request's URL and Host header to it — which destroys the `<site>.localhost`
// host dispatch this app relies on. Generate a routes-free dev config so the
// local server passes hosts through untouched.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(import.meta.dir, '..');
const src = readFileSync(join(dir, 'wrangler.jsonc'), 'utf8');
const out = src.replace(/"routes": \[[\s\S]*?\],\n/, '');
writeFileSync(join(dir, 'wrangler.dev.jsonc'), out);
console.log('wrote wrangler.dev.jsonc (routes stripped for host passthrough)');
