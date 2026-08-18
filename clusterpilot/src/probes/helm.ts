// Helm probe. `helm list -o json` gives the deployed chart version as a single
// "name-version" string, which we split into the two fields the analyzer wants.

import type { Config } from "../config.ts";
import { run } from "../exec.ts";
import type { HelmRelease, ProbeResult } from "../types.ts";

interface RawRelease {
  name: string;
  namespace: string;
  revision: string;
  status: string;
  chart: string;
  app_version: string;
}

/**
 * Splits "kube-prometheus-stack-88.1.5" into name and version. Chart names
 * contain dashes too, so we anchor on the last dash followed by a digit.
 */
export function splitChart(chart: string): { name: string; version: string } {
  const match = chart.match(/^(.*)-(\d[\w.+-]*)$/);
  if (!match) return { name: chart, version: "" };
  return { name: match[1]!, version: match[2]! };
}

export async function probeHelm(
  cfg: Config,
): Promise<{ releases: HelmRelease[]; probes: ProbeResult[] }> {
  const probes: ProbeResult[] = [];
  const command = [cfg.bin.helm];
  if (cfg.kubeContext) command.push("--kube-context", cfg.kubeContext);
  command.push("list", "-A", "-o", "json");

  const res = await run(command, { timeoutMs: cfg.timeoutMs });
  if (!res.ok) {
    probes.push({
      id: "helm.list",
      command,
      ok: false,
      error: res.stderr.trim() || `exit ${res.code}`,
      durationMs: res.durationMs,
    });
    return { releases: [], probes };
  }

  let raw: RawRelease[] = [];
  try {
    raw = JSON.parse(res.stdout) as RawRelease[];
  } catch (err) {
    probes.push({
      id: "helm.list",
      command,
      ok: false,
      error: `unparseable JSON: ${(err as Error).message}`,
      durationMs: res.durationMs,
    });
    return { releases: [], probes };
  }

  const releases: HelmRelease[] = raw.map((r) => {
    const { name, version } = splitChart(r.chart);
    return {
      name: r.name,
      namespace: r.namespace,
      chart: name,
      chartVersion: version,
      appVersion: r.app_version,
      status: r.status,
    };
  });

  // Fetch each release's supplied values. Needed both to build a correct
  // upgrade command and to record the release in the synced state file.
  await Promise.all(
    releases.map(async (rel) => {
      const argv = [cfg.bin.helm];
      if (cfg.kubeContext) argv.push("--kube-context", cfg.kubeContext);
      argv.push("-n", rel.namespace, "get", "values", rel.name, "-o", "yaml");

      const got = await run(argv, { timeoutMs: cfg.timeoutMs });
      probes.push({
        id: `helm.values.${rel.namespace}.${rel.name}`,
        command: argv,
        ok: got.ok,
        error: got.ok ? undefined : got.stderr.trim() || `exit ${got.code}`,
        durationMs: got.durationMs,
      });

      if (got.ok) {
        const text = got.stdout.trim();
        // helm prints "null" for a release installed with no overrides.
        rel.userValues = text === "null" || text === "" ? "" : text;
      }
    }),
  );

  probes.push({
    id: "helm.list",
    command,
    ok: true,
    data: releases.length,
    durationMs: res.durationMs,
  });
  return { releases, probes };
}
