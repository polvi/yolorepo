// Shared timings.json shape + the laptop-vs-server comparison table, used by
// remote-splat.ts and bench.ts.

export interface Timings {
  host: string;
  runner: string;
  ncpu: number;
  images: number;
  iters: number;
  matcher: string;
  mapper: string;
  stages: Record<string, number>;
  total_s: number;
}

const ROWS = ['extract', 'match', 'map', 'train', 'sog', 'upload', 'download'];

export function printComparison(local: Timings | null, remote: Timings): void {
  console.log(
    `\n${'stage'.padEnd(10)}${'laptop (s)'.padStart(12)}${'server (s)'.padStart(12)}   server: ${remote.host}, ${remote.ncpu} cpus`
  );
  for (const s of ROWS) {
    const l = local?.stages[s];
    const r = remote.stages[s];
    if (l === undefined && r === undefined) continue;
    console.log(
      `${s.padEnd(10)}${(l === undefined ? '—' : l.toFixed(0)).padStart(12)}${(r === undefined ? '—' : r.toFixed(0)).padStart(12)}`
    );
  }
  const rTotal = remote.total_s + (remote.stages.upload ?? 0) + (remote.stages.download ?? 0);
  console.log(
    `${'total'.padEnd(10)}${(local ? local.total_s.toFixed(0) : '—').padStart(12)}${rTotal.toFixed(0).padStart(12)}   (server total includes transfer)`
  );
}
