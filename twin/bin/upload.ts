#!/usr/bin/env bun
// The fast path for getting photos onto the k8s node: parallel HTTPS PUTs to
// the twin-upload LoadBalancer IP (direct TCP to the pod, no apiserver in
// the data path), content-addressed so re-runs resume for free.
//
//   bun twin/bin/upload.ts --images <dir> [--parallel 8] [--url https://…]
//     [--namespace twin] [--context <kubectl ctx>]
//
// kubectl is used for control only: apply the Service+Ingress, start the
// in-pod server, and fetch its bearer token. Data rides HTTPS through the
// caddy ingress at twin-upload.<baseDomain>.

import { existsSync, readdirSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    images: { type: 'string' },
    parallel: { type: 'string', default: '8' },
    url: { type: 'string' },
    namespace: { type: 'string', default: 'twin' },
    context: { type: 'string' },
  },
});

if (!values.images || !existsSync(values.images)) {
  console.error('usage: bun twin/bin/upload.ts --images <photo dir> [--parallel 8]');
  process.exit(1);
}
const images = resolve(values.images);
const parallel = Math.max(1, Number(values.parallel));
const ns = values.namespace!;
const kc = ['kubectl', ...(values.context ? ['--context', values.context] : [])];
const kcn = [...kc, '-n', ns];
const k8sDir = resolve(dirname(Bun.main), '../k8s');

function capture(cmd: string[], allowFail = false): string {
  const p = Bun.spawnSync(cmd, { stdout: 'pipe', stderr: 'pipe' });
  if (p.exitCode !== 0 && !allowFail) {
    console.error(p.stderr.toString());
    console.error(`[upload] failed: ${cmd.join(' ')}`);
    process.exit(1);
  }
  return p.exitCode === 0 ? p.stdout.toString() : '';
}

// --- control plane: service, server, credentials ---------------------------

capture([...kc, 'apply', '-f', `${k8sDir}/upload-svc.yaml`]);

// Sync the server script (tiny; buffered stdin over kubectl is fine at this
// size) and start it if it isn't running.
const tar = Bun.spawnSync(['tar', '-cf', '-', '-C', resolve(dirname(Bun.main)), 'upload-server.ts']);
Bun.spawnSync([...kcn, 'exec', '-i', 'twin-runner', '--', 'bash', '-c',
  'mkdir -p /work/scripts && tar -xf - -C /work/scripts'], { stdin: tar.stdout });
capture([...kcn, 'exec', 'twin-runner', '--', 'bash', '-c',
  // Port probe, not pgrep: a pgrep -f pattern would match this very shell's
  // command line (it contains the script path twice). Any HTTP response,
  // even 401, means the server is up; connection refused means start it.
  `curl -s -o /dev/null http://127.0.0.1:8080/health || ` +
    `{ nohup bun /work/scripts/upload-server.ts >/work/upload-server.log 2>&1 & sleep 1; }`]);

const token = capture([...kcn, 'exec', 'twin-runner', '--', 'cat', '/work/upload.token']).trim();
const { baseDomain } = (await Bun.file(
  resolve(dirname(Bun.main), '../../stack.generated.json')
).json()) as { baseDomain: string };
const base = values.url ?? `https://twin-upload.${baseDomain}`;
const opts = { headers: { authorization: `Bearer ${token}` } };

// First TLS handshake may also cover caddy's on-demand cert issuance; give
// it a couple of minutes.
let healthy = false;
for (let i = 0; i < 60 && !healthy; i++) {
  try {
    healthy = ((await (await fetch(`${base}/health`, opts)).json()) as { ok: boolean }).ok;
  } catch {
    await Bun.sleep(2000);
  }
}
if (!healthy) {
  console.error(`[upload] server at ${base} never became healthy — kubectl -n ${ns} exec twin-runner -- cat /work/upload-server.log`);
  process.exit(1);
}

// --- diff -------------------------------------------------------------------

type Entry = { size: number; hash: string };
const { files: remote } = (await (await fetch(`${base}/manifest`, opts)).json()) as {
  files: Record<string, Entry>;
};

const names = readdirSync(images)
  .filter((f) => !f.startsWith('.'))
  .sort();
const todo: { name: string; size: number }[] = [];
let skipped = 0;
let skippedBytes = 0;
for (const name of names) {
  const f = Bun.file(`${images}/${name}`);
  const r = remote[name];
  if (r && r.size === f.size && r.hash === Bun.hash(await f.arrayBuffer()).toString(16)) {
    skipped++;
    skippedBytes += f.size;
  } else {
    todo.push({ name, size: f.size });
  }
}
const totalBytes = todo.reduce((a, b) => a + b.size, 0);
console.log(
  `[upload] ${names.length} files: ${skipped} already on server (${(skippedBytes / 1e9).toFixed(1)} GB), ` +
    `${todo.length} to send (${(totalBytes / 1e9).toFixed(1)} GB), ${parallel} streams -> ${base}`
);

// --- parallel upload with retry ----------------------------------------------

let sent = 0;
let done = 0;
let failed = 0;
const t0 = performance.now();
const queue = [...todo];

async function worker(): Promise<void> {
  for (;;) {
    const item = queue.shift();
    if (!item) return;
    const body = await Bun.file(`${images}/${item.name}`).arrayBuffer();
    const hash = Bun.hash(body).toString(16);
    let ok = false;
    for (let attempt = 1; attempt <= 4 && !ok; attempt++) {
      try {
        const res = await fetch(`${base}/file/${encodeURIComponent(item.name)}`, {
          method: 'PUT',
          body,
          ...opts,
          headers: { ...opts.headers, 'x-content-hash': hash },
        });
        ok = res.ok;
        if (!ok && attempt === 4) console.error(`\n[upload] ${item.name}: HTTP ${res.status}`);
      } catch (e) {
        if (attempt === 4) console.error(`\n[upload] ${item.name}: ${String(e)}`);
        else await Bun.sleep(1000 * attempt);
      }
    }
    if (ok) {
      sent += item.size;
      done++;
    } else failed++;
  }
}

const ticker = setInterval(() => {
  const secs = (performance.now() - t0) / 1000;
  const rate = sent / 1e6 / secs;
  const eta = rate > 0 ? (totalBytes - sent) / 1e6 / rate : 0;
  process.stdout.write(
    `\r[upload] ${done}/${todo.length} files  ${(sent / 1e9).toFixed(2)}/${(totalBytes / 1e9).toFixed(2)} GB  ` +
      `${rate.toFixed(1)} MB/s  eta ${Math.ceil(eta / 60)}m   `
  );
}, 2000);

await Promise.all(Array.from({ length: parallel }, worker));
clearInterval(ticker);

const secs = (performance.now() - t0) / 1000;
console.log(
  `\n[upload] done: ${done} sent, ${skipped} skipped, ${failed} failed in ${(secs / 60).toFixed(1)}m ` +
    `(${(sent / 1e6 / secs).toFixed(1)} MB/s)`
);
if (failed > 0) process.exit(1);
