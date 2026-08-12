#!/usr/bin/env bun
// The one-command benchmark: run the pipeline locally (OpenSplat on Metal)
// AND on the k8s node (upload + CPU run + download) over the same photos,
// then print one laptop-vs-server table.
//
//   bun twin/bin/bench.ts --images <dir> [--work ./twin-work] [--iters 30000]
//     [--matcher exhaustive|sequential] [--serial]
//
// Parallel by default: the upload is network-bound and the remote stages run
// on the server, so they barely touch the laptop's cores. Pass --serial to
// run local first and remote after, if you want the laptop numbers taken on
// an otherwise idle machine.

import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { printComparison, type Timings } from './timings';

const { values } = parseArgs({
  options: {
    images: { type: 'string' },
    work: { type: 'string', default: './twin-work' },
    iters: { type: 'string', default: '30000' },
    matcher: { type: 'string', default: 'exhaustive' },
    downscale: { type: 'string', default: '2' },
    serial: { type: 'boolean', default: false },
  },
});

if (!values.images || !existsSync(values.images)) {
  console.error('usage: bun twin/bin/bench.ts --images <photo dir> [--work <dir>] [--serial]');
  process.exit(1);
}
const images = resolve(values.images);
const work = resolve(values.work!);
const binDir = dirname(Bun.main);
mkdirSync(work, { recursive: true });
const flags = ['--images', images, '--work', work, '--iters', values.iters!, '--matcher', values.matcher!, '--downscale', values.downscale!];

const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

async function runSide(name: 'local' | 'remote'): Promise<boolean> {
  const script = name === 'local' ? 'build-splat.ts' : 'remote-splat.ts';
  const log = `${work}/${name}.log`;
  console.log(`[bench] ${name} run started — tail -f ${log}`);
  const cmd = ['bun', `${binDir}/${script}`, ...flags].map(q).join(' ');
  const p = Bun.spawn(['bash', '-c', `exec ${cmd} > ${q(log)} 2>&1`]);
  const code = await p.exited;
  if (code !== 0) console.error(`[bench] ${name} run FAILED (exit ${code}) — see ${log}`);
  else console.log(`[bench] ${name} run done`);
  return code === 0;
}

const t0 = performance.now();
let okLocal: boolean;
let okRemote: boolean;
if (values.serial) {
  okLocal = await runSide('local');
  okRemote = await runSide('remote');
} else {
  [okLocal, okRemote] = await Promise.all([runSide('local'), runSide('remote')]);
}
if (!okLocal && !okRemote) process.exit(1);

const read = async (p: string): Promise<Timings | null> =>
  existsSync(p) ? ((await Bun.file(p).json()) as Timings) : null;
const local = await read(`${work}/dist/timings.json`);
const remote = await read(`${work}/dist/timings.remote.json`);

if (remote) printComparison(local, remote);
else if (local) {
  console.log('\n[bench] local stage times (remote run unavailable):');
  for (const [k, v] of Object.entries(local.stages)) console.log(`  ${k.padEnd(8)} ${v.toFixed(0)}s`);
}
console.log(`\n[bench] wall clock for the whole benchmark: ${((performance.now() - t0) / 1000 / 60).toFixed(1)} min`);
if (okLocal) {
  console.log(`[bench] publish the laptop splat:  bun twin/bin/publish.ts <slug> ${work}/dist/scene.sog --title "…"`);
}
if (okRemote) {
  console.log(`[bench] publish the server splat:  bun twin/bin/publish.ts <slug>-remote ${work}/dist/scene.remote.sog --unlisted`);
}
