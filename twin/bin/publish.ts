#!/usr/bin/env bun
// Publish a splat scene to the twin-scenes R2 bucket via wrangler.
//
//   bun twin/bin/publish.ts <slug> <scene.sog|.spz|.ply> [--title "My Place"]
//     [--rot-x 180] [--unlisted] [--bucket twin-scenes]
//
// Write order is load-bearing (model-checked in twin/specs/TwinPublish.tla):
// artifact first, then meta, then the index — so a scene reachable from the
// index is always fully readable, and meta never describes bytes that have
// not landed yet.

import { basename, dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    title: { type: 'string' },
    'rot-x': { type: 'string', default: '180' },
    unlisted: { type: 'boolean', default: false },
    bucket: { type: 'string', default: 'twin-scenes' },
  },
});

const [slug, file] = positionals;
if (!slug || !file || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) {
  console.error(
    'usage: bun twin/bin/publish.ts <slug> <splat file> [--title "…"] [--unlisted]\n' +
      '  slug: lowercase letters, digits, dashes'
  );
  process.exit(1);
}
const splat = Bun.file(resolve(file));
if (!(await splat.exists())) {
  console.error(`no such file: ${file}`);
  process.exit(1);
}

const repoRoot = resolve(dirname(Bun.main), '../..');
const webDir = `${repoRoot}/twin/apps/web`;
const bucket = values.bucket!;

function wrangler(args: string[], opts: { stdin?: string; allowFail?: boolean } = {}): string {
  const p = Bun.spawnSync(['bun', 'x', 'wrangler', ...args], {
    cwd: webDir,
    stdin: opts.stdin === undefined ? undefined : new TextEncoder().encode(opts.stdin),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (p.exitCode !== 0 && !opts.allowFail) {
    console.error(p.stderr.toString());
    console.error(`wrangler ${args.slice(0, 4).join(' ')} … failed`);
    process.exit(1);
  }
  return p.exitCode === 0 ? p.stdout.toString() : '';
}

const bytes = new Uint8Array(await splat.arrayBuffer());
const sha256 = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
const meta = {
  slug,
  title: values.title ?? slug,
  file: basename(file),
  size: bytes.byteLength,
  sha256,
  rotXDeg: Number(values['rot-x']),
  created: new Date().toISOString(),
};

// 1. artifact
console.log(`[twin] uploading ${meta.file} (${(meta.size / 1e6).toFixed(1)} MB)…`);
wrangler([
  'r2', 'object', 'put', `${bucket}/scenes/${slug}/splat`,
  '--file', resolve(file), '--content-type', 'application/octet-stream', '--remote',
]);

// 2. meta
const metaPath = `${process.env.TMPDIR ?? '/tmp'}/twin-meta-${slug}.json`;
await Bun.write(metaPath, JSON.stringify(meta, null, 2));
wrangler([
  'r2', 'object', 'put', `${bucket}/scenes/${slug}/meta.json`,
  '--file', metaPath, '--content-type', 'application/json', '--remote',
]);

// 3. index (last, so listed scenes are always fully readable)
const raw = wrangler(['r2', 'object', 'get', `${bucket}/index.json`, '--pipe', '--remote'], {
  allowFail: true,
});
let scenes: { slug: string; title: string; created: string; size: number }[] = [];
try {
  scenes = (JSON.parse(raw) as { scenes: typeof scenes }).scenes ?? [];
} catch {
  /* first publish: no index yet */
}
scenes = scenes.filter((s) => s.slug !== slug);
if (!values.unlisted) {
  scenes.push({ slug, title: meta.title, created: meta.created, size: meta.size });
  scenes.sort((a, b) => b.created.localeCompare(a.created));
}
const indexPath = `${process.env.TMPDIR ?? '/tmp'}/twin-index.json`;
await Bun.write(indexPath, JSON.stringify({ scenes }, null, 2));
wrangler([
  'r2', 'object', 'put', `${bucket}/index.json`,
  '--file', indexPath, '--content-type', 'application/json', '--remote',
]);

const { baseDomain } = JSON.parse(
  await Bun.file(`${repoRoot}/stack.generated.json`).text()
) as { baseDomain: string };
console.log(`[twin] published${values.unlisted ? ' (unlisted)' : ''}:`);
console.log(`       https://twin.${baseDomain}/s/${slug}`);
