#!/usr/bin/env bun
// Drone photos -> Gaussian splat, entirely local (Apple Silicon friendly):
//   COLMAP (feature_extractor -> matcher -> mapper, glomap when installed)
//   -> OpenSplat (Metal) -> @playcanvas/splat-transform (.sog)
//
//   bun twin/bin/build-splat.ts --images <dir> [--work <dir>] [--iters 30000]
//     [--matcher exhaustive|sequential]
//
// exhaustive matching is best under ~400 photos; sequential is much faster
// for larger sets when photos are in capture order (drone missions are).
//
// Writes dist/timings.json alongside the splat — same shape as the k8s
// runner (bin/remote-splat.ts) emits, so the two are directly comparable.

import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { cpus, hostname } from 'node:os';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    images: { type: 'string' },
    work: { type: 'string', default: './twin-work' },
    iters: { type: 'string', default: '30000' },
    matcher: { type: 'string', default: 'exhaustive' },
    // OpenSplat loads every image into RAM at full res before training:
    // 1067 20MP photos ≈ 64GB+ decoded, an instant OOM on most machines.
    // Downscale 2 (≈2700px) is standard splat-training resolution.
    downscale: { type: 'string', default: '2' },
    // Match opensplat defaults; lower both on RAM-limited machines —
    // gaussian count (and so memory) grows with densification until
    // training's midpoint, far past where the run starts.
    'sh-degree': { type: 'string', default: '3' },
    'densify-thresh': { type: 'string', default: '0.0002' },
    // Skip the COLMAP stages when a mapped model already exists (e.g. a
    // previous run died during training).
    resume: { type: 'boolean', default: false },
  },
});

if (!values.images || !existsSync(values.images)) {
  console.error('usage: bun twin/bin/build-splat.ts --images <photo dir> [--work <dir>]');
  process.exit(1);
}
const images = resolve(values.images);
const work = resolve(values.work!);

function need(tool: string, hint: string): void {
  if (!Bun.which(tool)) {
    console.error(`${tool} not found — ${hint}`);
    process.exit(1);
  }
}
need('colmap', 'brew install colmap');
need(
  'opensplat',
  'build from https://github.com/pierotofy/OpenSplat with GPU_RUNTIME=MPS (Metal)'
);

const stages: Record<string, number> = {};

function run(stage: string, cmd: string[]): void {
  console.log(`\n[twin] ${cmd.join(' ')}`);
  const t0 = performance.now();
  const p = Bun.spawnSync(cmd, { stdout: 'inherit', stderr: 'inherit' });
  if (p.exitCode !== 0) {
    console.error(`[twin] failed (exit ${p.exitCode}): ${cmd[0]}`);
    process.exit(1);
  }
  stages[stage] = (stages[stage] ?? 0) + (performance.now() - t0) / 1000;
}

const colmapDir = `${work}/colmap`;
const db = `${colmapDir}/db.db`;
const sparse = `${colmapDir}/sparse`;
mkdirSync(sparse, { recursive: true });

const resuming = values.resume && existsSync(`${sparse}/0`);
if (resuming) console.log('[twin] resuming: sparse model exists, skipping COLMAP stages');

if (!resuming) run('extract', [
  'colmap', 'feature_extractor',
  '--database_path', db,
  '--image_path', images,
  '--ImageReader.single_camera', '1',
  '--ImageReader.camera_model', 'SIMPLE_RADIAL',
]);

if (!resuming)
  run(
    'match',
    values.matcher === 'sequential'
      ? ['colmap', 'sequential_matcher', '--database_path', db, '--SequentialMatching.overlap', '15']
      : ['colmap', 'exhaustive_matcher', '--database_path', db]
  );

// glomap is a drop-in global mapper, ~10x faster than colmap's incremental
// one on big scenes; fall back silently when it isn't installed.
const mapper = Bun.which('glomap') ? 'glomap' : 'colmap';
if (!resuming)
  run('map', [mapper, 'mapper', '--database_path', db, '--image_path', images, '--output_path', sparse]);
if (!existsSync(`${sparse}/0`)) {
  console.error('[twin] mapper produced no model — check image overlap/quality');
  process.exit(1);
}

// OpenSplat consumes a COLMAP-layout project dir; assemble one from symlinks.
const project = `${work}/opensplat/project`;
mkdirSync(`${project}/sparse`, { recursive: true });
for (const [link, target] of [
  [`${project}/images`, images],
  [`${project}/sparse/0`, `${sparse}/0`],
] as const) {
  rmSync(link, { recursive: true, force: true });
  symlinkSync(target, link);
}

const ply = `${work}/opensplat/splat.ply`;
run('train', ['opensplat', project, '-n', values.iters!, '-d', values.downscale!,
  '--sh-degree', values['sh-degree']!, '--densify-grad-thresh', values['densify-thresh']!, '-o', ply]);

mkdirSync(`${work}/dist`, { recursive: true });
const sog = `${work}/dist/scene.sog`;
run('sog', ['bunx', '@playcanvas/splat-transform', ply, sog]);

const timings = {
  host: hostname(),
  runner: 'local (opensplat Metal)',
  ncpu: cpus().length,
  images: readdirSync(images).filter((f) => /\.(jpe?g|png)$/i.test(f)).length,
  iters: Number(values.iters),
  matcher: values.matcher,
  mapper,
  downscale: Number(values.downscale),
  shDegree: Number(values['sh-degree']),
  densifyThresh: Number(values['densify-thresh']),
  resumed: resuming,
  stages,
  total_s: Object.values(stages).reduce((a, b) => a + b, 0),
};
await Bun.write(`${work}/dist/timings.json`, JSON.stringify(timings, null, 2));

console.log(`\n[twin] splat ready: ${sog}`);
for (const [k, v] of Object.entries(stages)) console.log(`       ${k.padEnd(8)} ${v.toFixed(1)}s`);
console.log(`       total    ${timings.total_s.toFixed(1)}s`);
console.log(`[twin] publish it:   bun twin/bin/publish.ts <slug> ${sog} --title "My Place"`);
