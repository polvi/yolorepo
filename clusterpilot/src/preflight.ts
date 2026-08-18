// Preflight gates, evaluated against freshly collected state immediately before
// each step runs -- not against the state the plan was built from.
//
// The gap matters. A plan generated at 09:00 and approved at 14:00 describes a
// cluster that may have changed: a node went NotReady, someone rolled a
// release, the snapshot got deleted. Re-checking at the last moment is what
// keeps an approved plan from acting on stale facts.

import { stat } from "node:fs/promises";
import type { Config } from "./config.ts";
import { collect } from "./probes/index.ts";
import type { Inventory, PreflightCheck } from "./types.ts";

export interface PreflightResult {
  ok: boolean;
  /** One line per check, for the journal and the console. */
  lines: string[];
  failures: string[];
}

async function evaluate(
  cfg: Config,
  check: PreflightCheck,
  inv: Inventory,
): Promise<{ ok: boolean; line: string }> {
  switch (check.kind) {
    case "cluster-healthy": {
      const notReady = inv.kubeNodes.filter((n) => !n.ready).map((n) => n.name);
      const pressured = inv.kubeNodes.filter((n) => n.pressures.length > 0).map((n) => n.name);
      if (notReady.length > 0) {
        return { ok: false, line: `cluster-healthy: nodes not Ready: ${notReady.join(", ")}` };
      }
      if (pressured.length > 0) {
        return { ok: false, line: `cluster-healthy: nodes under pressure: ${pressured.join(", ")}` };
      }
      if (inv.kubeNodes.length === 0) {
        return { ok: false, line: "cluster-healthy: could not read any nodes" };
      }
      return { ok: true, line: `cluster-healthy: ${inv.kubeNodes.length} node(s) Ready` };
    }

    case "no-crashloops": {
      const crashers = inv.workloads.unhealthyPods.filter((p) => p.reason.includes("CrashLoop"));
      if (crashers.length > 0) {
        return {
          ok: false,
          line: `no-crashloops: ${crashers.map((p) => `${p.namespace}/${p.name}`).join(", ")}`,
        };
      }
      return { ok: true, line: "no-crashloops: none" };
    }

    case "snapshot-exists": {
      try {
        const st = await stat(check.path);
        if (st.size === 0) {
          return { ok: false, line: `snapshot-exists: ${check.path} is empty` };
        }
        return { ok: true, line: `snapshot-exists: ${check.path} (${st.size} bytes)` };
      } catch {
        return { ok: false, line: `snapshot-exists: ${check.path} is missing` };
      }
    }

    case "schematic-matches": {
      // The check that protects the ZFS extension, and with it every PVC.
      const node = inv.talosNodes.find((n) => n.name === check.node);
      if (!node) return { ok: false, line: `schematic-matches: ${check.node} not found` };
      if (node.schematic !== check.schematic) {
        return {
          ok: false,
          line: `schematic-matches: ${check.node} now reports ${node.schematic ?? "none"}, plan was built for ${check.schematic}`,
        };
      }
      return { ok: true, line: `schematic-matches: ${check.schematic.slice(0, 12)}…` };
    }

    case "talos-version-is": {
      const node = inv.talosNodes.find((n) => n.name === check.node);
      if (node?.version !== check.version) {
        return {
          ok: false,
          line: `talos-version-is: ${check.node} is ${node?.version ?? "unknown"}, expected ${check.version}`,
        };
      }
      return { ok: true, line: `talos-version-is: ${check.version}` };
    }

    case "k8s-version-is": {
      const versions = new Set(inv.kubeNodes.map((n) => n.kubeletVersion));
      if (!versions.has(check.version)) {
        return {
          ok: false,
          line: `k8s-version-is: found ${[...versions].join(", ")}, expected ${check.version}`,
        };
      }
      return { ok: true, line: `k8s-version-is: ${check.version}` };
    }
  }
}

/** Collects fresh state once, then evaluates every check against it. */
export async function runPreflight(
  cfg: Config,
  checks: PreflightCheck[],
): Promise<PreflightResult & { inventory: Inventory }> {
  const inventory = await collect(cfg);
  const lines: string[] = [];
  const failures: string[] = [];

  for (const check of checks) {
    const { ok, line } = await evaluate(cfg, check, inventory);
    lines.push(`${ok ? "ok  " : "FAIL"} ${line}`);
    if (!ok) failures.push(line);
  }

  return { ok: failures.length === 0, lines, failures, inventory };
}
