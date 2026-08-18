// Upstream version discovery: GitHub releases for Talos and Kubernetes, chart
// repo indexes for Helm. All plain HTTP, no model involvement.

import { parse as parseYaml } from "yaml";
import type { Config } from "../config.ts";
import { sortStableDesc } from "../semver.ts";
import type { UpstreamVersions } from "../types.ts";

const UA = { "user-agent": "clusterpilot", accept: "application/vnd.github+json" };

async function githubReleases(repo: string, errors: string[]): Promise<string[]> {
  const url = `https://api.github.com/repos/${repo}/releases?per_page=100`;
  const headers: Record<string, string> = { ...UA };
  // Unauthenticated GitHub is 60 requests/hour, which two runs can exhaust.
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) {
      errors.push(`${repo}: HTTP ${res.status}${res.status === 403 ? " (rate limited; set GITHUB_TOKEN)" : ""}`);
      return [];
    }
    const body = (await res.json()) as { tag_name?: string; prerelease?: boolean; draft?: boolean }[];
    return sortStableDesc(
      body
        .filter((r) => !r.prerelease && !r.draft && r.tag_name)
        .map((r) => r.tag_name!.replace(/^v/, "")),
    );
  } catch (err) {
    errors.push(`${repo}: ${(err as Error).message}`);
    return [];
  }
}

interface HelmIndex {
  entries?: Record<string, { version?: string }[]>;
}

/**
 * Pulls the versions of one chart out of a Helm repo index.
 *
 * `entries.<chart>[].version` is the chart's own version. Reading it through a
 * YAML parser rather than by scanning lines keeps the nested `dependencies[]`
 * blocks, which carry their own `version` fields, from being mistaken for it.
 */
export function extractChartVersions(indexYaml: string, chart: string): string[] {
  let doc: HelmIndex;
  try {
    doc = parseYaml(indexYaml) as HelmIndex;
  } catch {
    return [];
  }

  const entries = doc?.entries?.[chart];
  if (!Array.isArray(entries)) return [];

  return sortStableDesc(
    entries
      .map((e) => e?.version)
      .filter((v): v is string => typeof v === "string")
      .map((v) => v.replace(/^v/, "")),
  );
}

async function chartVersions(chart: string, repoUrl: string, errors: string[]): Promise<string[]> {
  const url = `${repoUrl.replace(/\/$/, "")}/index.yaml`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) {
      errors.push(`${chart}: HTTP ${res.status} from ${url}`);
      return [];
    }
    return extractChartVersions(await res.text(), chart);
  } catch (err) {
    errors.push(`${chart}: ${(err as Error).message}`);
    return [];
  }
}

export async function fetchUpstream(cfg: Config, charts: string[]): Promise<UpstreamVersions> {
  const errors: string[] = [];

  const wanted = charts.filter((c) => cfg.helmRepos[c]);
  for (const c of charts) {
    if (!cfg.helmRepos[c]) errors.push(`${c}: no repo configured in helmRepos`);
  }

  const [talos, kubernetes, ...chartResults] = await Promise.all([
    githubReleases(cfg.releases.talos, errors),
    githubReleases(cfg.releases.kubernetes, errors),
    ...wanted.map((c) => chartVersions(c, cfg.helmRepos[c]!, errors)),
  ]);

  const chartMap: Record<string, string[]> = {};
  wanted.forEach((c, i) => {
    chartMap[c] = chartResults[i] ?? [];
  });

  return { talos, kubernetes, charts: chartMap, errors };
}
