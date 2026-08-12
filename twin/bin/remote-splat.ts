#!/usr/bin/env bun
// Run the twin pipeline on the k8s node instead of this machine, end to end:
// apply the runner pod, bootstrap its toolchain (cached on the PVC), upload
// the photos, run COLMAP -> OpenSplat (CPU) -> SOG, download the results,
// and print a laptop-vs-server comparison when a local timings.json exists.
//
//   bun twin/bin/remote-splat.ts --images <dir> [--work <dir>] [--iters 30000]
//     [--matcher exhaustive|sequential] [--namespace twin] [--context <kubectl ctx>]
//
// Upload/download are timed too — for a benchmark of "run it here vs ship it
// to the server", the shipping is part of the answer.

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
    'sh-degree': { type: 'string', default: '3' },
    'densify-thresh': { type: 'string', default: '0.0002' },
    resume: { type: 'boolean', default: false },
    namespace: { type: 'string', default: 'twin' },
    context: { type: 'string' },
  },
});

if (!values.images || !existsSync(values.images)) {
  console.error('usage: bun twin/bin/remote-splat.ts --images <photo dir> [--work <dir>]');
  process.exit(1);
}
const images = resolve(values.images);
const work = resolve(values.work!);
const k8sDir = resolve(dirname(Bun.main), '../k8s');
const ns = values.namespace!;
const kc = ['kubectl', ...(values.context ? ['--context', values.context] : [])];
const kcn = [...kc, '-n', ns];

function run(cmd: string[], opts: { stdin?: Blob | 'inherit'; quiet?: boolean } = {}): void {
  if (!opts.quiet) console.log(`[twin] ${cmd.join(' ')}`);
  const p = Bun.spawnSync(cmd, {
    stdin: opts.stdin === 'inherit' ? 'inherit' : opts.stdin,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  if (p.exitCode !== 0) {
    console.error(`[twin] failed (exit ${p.exitCode}): ${cmd.join(' ')}`);
    process.exit(1);
  }
}

function capture(cmd: string[]): string {
  const p = Bun.spawnSync(cmd, { stdout: 'pipe', stderr: 'pipe' });
  if (p.exitCode !== 0) {
    console.error(p.stderr.toString());
    console.error(`[twin] failed: ${cmd.join(' ')}`);
    process.exit(1);
  }
  return p.stdout.toString();
}

/** kubectl exec with a shell command, output streamed live. */
async function podSh(cmd: string, opts: { stdin?: ReadableStream | Uint8Array } = {}): Promise<void> {
  const argv = [...kcn, 'exec', ...(opts.stdin ? ['-i'] : []), 'twin-runner', '--', 'bash', '-c', cmd];
  const p = Bun.spawn(argv, {
    stdin: opts.stdin ?? 'ignore',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  if ((await p.exited) !== 0) {
    console.error(`[twin] remote command failed: ${cmd.slice(0, 80)}`);
    process.exit(1);
  }
}

const timed: Record<string, number> = {};
async function timedStep<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  const r = await fn();
  timed[name] = (performance.now() - t0) / 1000;
  return r;
}

// 1. runner pod (idempotent) — ns, PVC, pod, then wait until it can exec.
for (const f of ['ns.yaml', 'pvc.yaml', 'runner-pod.yaml']) {
  run([...kc, 'apply', '-f', `${k8sDir}/${f}`]);
}
run([...kcn, 'wait', '--for=condition=Ready', 'pod/twin-runner', '--timeout=300s']);

// 2. scripts; toolchain is baked into the twin-runner image, so bootstrap
// only runs (and only costs anything) on a stock-debian pod.
console.log('\n[twin] syncing scripts…');
const scriptsTar = Bun.spawnSync(['tar', '-cf', '-', '-C', k8sDir, 'bootstrap.sh', 'pipeline.sh', 'run-pipeline.sh']);
await podSh('mkdir -p /work/scripts && tar -xf - -C /work/scripts', { stdin: scriptsTar.stdout });
await timedStep('bootstrap', () =>
  podSh('command -v opensplat >/dev/null 2>&1 || bash /work/scripts/bootstrap.sh')
);

// 3. photos, over the HTTPS uploader (parallel, content-addressed, resumes
// for free — see bin/upload.ts). Stale non-photo state from earlier runs is
// cleared, but images stay: the manifest diff skips whatever already
// matches.
console.log('\n[twin] uploading photos…');
const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
await timedStep('upload', async () => {
  // Clear stale outputs ONLY when no pipeline is running — when attaching to
  // a live one, these are its working directories, not stale state.
  await podSh(
    'mkdir -p /work/job/images; ' +
      "if ! pgrep -f '/work/scripts/[p]ipeline.sh' >/dev/null; then " +
      'rm -rf /work/job/colmap /work/job/opensplat /work/job/dist; fi'
  );
  const p = Bun.spawn(
    ['bun', `${dirname(Bun.main)}/upload.ts`, '--images', images,
      ...(values.context ? ['--context', values.context] : []), '--namespace', ns],
    { stdout: 'inherit', stderr: 'inherit' }
  );
  if ((await p.exited) !== 0) {
    console.error('[twin] photo upload failed');
    process.exit(1);
  }
});

// 4. the pipeline itself, detached in the pod (run-pipeline.sh) and watched
// with short-lived execs — a single long exec dies with its websocket while
// the pipeline runs on regardless. Stage timing happens remotely, in
// pipeline.sh.
await timedStep('pipeline', async () => {
  await podSh(
    `env ITERS=${Number(values.iters)} MATCHER=${values.matcher} ` +
      `DOWNSCALE=${Number(values.downscale)} SH_DEGREE=${Number(values['sh-degree'])} ` +
      `DENSIFY_THRESH=${Number(values['densify-thresh'])} RESUME=${values.resume ? 1 : 0} ` +
      `bash /work/scripts/run-pipeline.sh`
  );
  // Every probe distinguishes three outcomes: a definitive answer, a
  // definitive absence, and "kubectl itself failed" (flaky WAN/apiserver) —
  // only many consecutive failures of the transport count against the run.
  const podQuiet = (cmd: string): { ok: boolean; out: string } => {
    const p = Bun.spawnSync([...kcn, 'exec', 'twin-runner', '--', 'bash', '-c', cmd], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return { ok: p.exitCode === 0, out: p.exitCode === 0 ? p.stdout.toString() : '' };
  };
  const probe = (): 'running' | 'succeeded' | `failed:${string}` | 'gone' | 'unreachable' => {
    const status = podQuiet('cat /work/job/status 2>/dev/null || echo __NONE__');
    if (!status.ok) return 'unreachable';
    const s = status.out.trim();
    if (s === '0') return 'succeeded';
    if (s !== '__NONE__') return `failed:${s}`;
    // No status file: still running, or an attached legacy run that never
    // writes one — for those, timings.json appearing means success.
    const run = podQuiet("pgrep -f '/work/scripts/[p]ipeline.sh' >/dev/null && echo yes || echo no");
    if (!run.ok) return 'unreachable';
    if (run.out.trim() === 'yes') return 'running';
    const done = podQuiet('test -f /work/job/dist/timings.json && echo yes || echo no');
    if (!done.ok) return 'unreachable';
    return done.out.trim() === 'yes' ? 'succeeded' : 'gone';
  };

  let offset = 0;
  let unreachable = 0;
  let goneOnce = false;
  for (;;) {
    const chunk = podQuiet(`tail -c +${offset + 1} /work/job/pipeline.log 2>/dev/null | head -c 500000`);
    if (chunk.ok && chunk.out) {
      offset += Buffer.byteLength(chunk.out);
      process.stdout.write(chunk.out);
    }
    const state = probe();
    if (state === 'succeeded') return;
    if (state.startsWith('failed:')) {
      console.error(`[twin] pipeline failed (exit ${state.slice(7)}) — kubectl -n ${ns} exec twin-runner -- tail -50 /work/job/pipeline.log`);
      process.exit(1);
    }
    if (state === 'unreachable') {
      // 60 consecutive misses ≈ 10+ minutes without contact.
      if (++unreachable >= 60) {
        console.error('[twin] lost contact with the pod for 10+ minutes — the pipeline may still be running; re-run to re-attach');
        process.exit(1);
      }
    } else {
      unreachable = 0;
    }
    if (state === 'gone') {
      // Grace once: status is written moments after the process exits.
      if (goneOnce) {
        console.error('[twin] pipeline is not running and produced no result — check /work/job/pipeline.log');
        process.exit(1);
      }
      goneOnce = true;
      await Bun.sleep(15_000);
      continue;
    }
    if (state === 'running') goneOnce = false;
    await Bun.sleep(10_000);
  }
});

// 5. results
console.log('\n[twin] downloading results…');
mkdirSync(`${work}/dist`, { recursive: true });
const sog = `${work}/dist/scene.remote.sog`;
await timedStep('download', async () => {
  const kexec = [...kcn, 'exec', 'twin-runner', '--', 'cat', '/work/job/dist/scene.sog']
    .map(q)
    .join(' ');
  const p = Bun.spawn(['bash', '-c', `${kexec} > ${q(sog)}`], { stdout: 'inherit', stderr: 'inherit' });
  if ((await p.exited) !== 0) {
    console.error('[twin] download failed');
    process.exit(1);
  }
});
const remote = JSON.parse(
  capture([...kcn, 'exec', 'twin-runner', '--', 'cat', '/work/job/dist/timings.json'])
) as Timings;
remote.stages['upload'] = timed.upload!;
remote.stages['download'] = timed.download!;
await Bun.write(`${work}/dist/timings.remote.json`, JSON.stringify(remote, null, 2));

// 6. report
console.log(`\n[twin] splat ready: ${sog}`);
const localPath = `${work}/dist/timings.json`;
const local = existsSync(localPath)
  ? (JSON.parse(await Bun.file(localPath).text()) as Timings)
  : null;
printComparison(local, remote);
if (!local) {
  console.log(`\n[twin] no local timings at ${localPath} — run bin/build-splat.ts on the same photos to compare.`);
}
if (timed.bootstrap! > 2) {
  console.log(
    `[twin] bootstrap took ${timed.bootstrap!.toFixed(0)}s (excluded from totals — build the twin-runner image to skip it, see twin/k8s/)`
  );
}
