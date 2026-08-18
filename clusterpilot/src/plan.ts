// Compiles an inventory plus upstream versions into an ordered ExecutionPlan.
//
// This is the only place mutating commands are constructed. Every argv here is
// built from values that came off the cluster or out of a release feed, and the
// model has no input into any of it. That is the property that makes execution
// safe to offer at all: the worst a confused model can do at execution time is
// misdescribe a step, not invent one.

import { installerImage } from "./analyze.ts";
import type { Config } from "./config.ts";
import * as semver from "./semver.ts";
import type { ExecutionPlan, Inventory, PreflightCheck, Step, UpstreamVersions } from "./types.ts";

/** A node reboot on real hardware is slow; the R740xd takes minutes to POST. */
const NODE_REBOOT_TIMEOUT_MS = 20 * 60_000;
const K8S_UPGRADE_TIMEOUT_MS = 20 * 60_000;
const HELM_TIMEOUT_MS = 20 * 60_000;
/**
 * Generous on purpose. A false timeout is not a harmless retry here: helm marks
 * a timed-out release `failed`, which then needs a rollback to clean up, and
 * the kube-prometheus release on this cluster has a "context deadline exceeded"
 * failure in its own history. Waiting longer costs nothing when things go well.
 */
const HELM_WAIT = "15m";
const SETTLE_TIMEOUT_MS = 10 * 60_000;

function kubectlBase(cfg: Config): string[] {
  const argv = [cfg.bin.kubectl];
  if (cfg.kubeContext) argv.push("--context", cfg.kubeContext);
  return argv;
}

export interface PlanOptions {
  /** Where the pre-upgrade etcd snapshot is written. */
  snapshotPath?: string;
  /** Stop after Talos; skip Kubernetes and Helm. */
  talosOnly?: boolean;
  /** Skip chart upgrades. */
  skipHelm?: boolean;
  /**
   * Values file to apply per release, keyed by "namespace/release". Supplied by
   * materializeValues(); a release missing from this map gets no upgrade step,
   * because upgrading without values would silently reset it to chart defaults.
   */
  valuesPaths?: Record<string, string>;
}

export const releaseKey = (namespace: string, name: string) => `${namespace}/${name}`;

export function buildPlan(
  cfg: Config,
  inv: Inventory,
  up: UpstreamVersions,
  opts: PlanOptions = {},
): ExecutionPlan {
  const steps: Step[] = [];
  const singleNode = inv.kubeNodes.length === 1;
  const snapshotPath = opts.snapshotPath ?? `etcd-${inv.collectedAt.slice(0, 10)}.db`;

  const talosWork = inv.talosNodes.filter(
    (n) => n.version && semver.upgradePath(n.version, up.talos).length > 0,
  );
  const kubeNewest = semver.sortDesc(inv.kubeNodes.map((n) => n.kubeletVersion))[0];
  const k8sPath = kubeNewest ? semver.upgradePath(kubeNewest, up.kubernetes) : [];
  const helmWork = opts.skipHelm
    ? []
    : inv.helmReleases.filter((r) => {
        const latest = up.charts[r.chart]?.[0];
        return !!latest && semver.compareStrings(latest, r.chartVersion) > 0;
      });

  const willRebootOrUpgradeControlPlane = talosWork.length > 0 || k8sPath.length > 0;

  // An etcd snapshot is the only rollback a single-node cluster has, so it is
  // step one whenever anything is going to touch the control plane.
  if (willRebootOrUpgradeControlPlane && inv.talosNodes[0]) {
    const node = inv.talosNodes[0].name;
    steps.push({
      id: "snapshot",
      title: "Take an etcd snapshot",
      kind: "snapshot",
      argv: [cfg.bin.talosctl, "-n", node, "etcd", "snapshot", snapshotPath],
      effect: `Writes an etcd backup to ${snapshotPath} on this machine. Changes nothing on the cluster.`,
      downtime: "none",
      preflight: [{ kind: "cluster-healthy" }],
      verify: [],
    });
  }

  for (const node of talosWork) {
    const path = semver.upgradePath(node.version!, up.talos);
    for (const version of path) {
      const image = installerImage(version, node.schematic);
      const preflight: PreflightCheck[] = [
        { kind: "cluster-healthy" },
        { kind: "no-crashloops" },
        { kind: "snapshot-exists", path: snapshotPath },
      ];
      // Guard the exact failure that would cost the ZFS volumes.
      if (node.schematic) {
        preflight.push({ kind: "schematic-matches", node: node.name, schematic: node.schematic });
      }

      steps.push({
        id: `talos-${node.name}-${version}`,
        title: `Upgrade Talos on ${node.name} to ${version}`,
        kind: "talos-upgrade",
        // No --preserve: deprecated since 1.13, and it selects the legacy
        // upgrade path. The ephemeral partition is preserved by default.
        argv: [cfg.bin.talosctl, "-n", node.name, "upgrade", "--image", image, "--wait"],
        effect: `Installs ${image} and reboots ${node.name}.${
          singleNode ? " This is a single-node cluster, so the API server and every workload go down until it comes back." : ""
        }`,
        downtime: singleNode ? "full-outage" : "brief",
        preflight,
        watch: {
          kind: "node-reboot",
          node: node.name,
          expectTalosVersion: version,
          timeoutMs: NODE_REBOOT_TIMEOUT_MS,
        },
        verify: [
          [cfg.bin.talosctl, "-n", node.name, "version"],
          [...kubectlBase(cfg), "get", "nodes", "-o", "wide"],
        ],
      });
    }
  }

  if (!opts.talosOnly && kubeNewest) {
    for (const version of k8sPath) {
      const node = inv.talosNodes[0]?.name ?? inv.kubeNodes[0]?.name ?? "";
      steps.push({
        id: `k8s-${version}`,
        title: `Upgrade Kubernetes to ${version}`,
        kind: "k8s-upgrade",
        argv: [cfg.bin.talosctl, "-n", node, "upgrade-k8s", "--to", version],
        effect:
          "Rolls the control plane static pods and the kubelet. The API server restarts; workloads keep running.",
        downtime: singleNode ? "brief" : "none",
        preflight: [{ kind: "cluster-healthy" }, { kind: "snapshot-exists", path: snapshotPath }],
        watch: { kind: "k8s-version", expectVersion: version, timeoutMs: K8S_UPGRADE_TIMEOUT_MS },
        verify: [[...kubectlBase(cfg), "get", "nodes", "-o", "wide"]],
      });
    }
  }

  if (!opts.talosOnly) {
    for (const rel of helmWork) {
      const latest = up.charts[rel.chart]![0]!;
      const repo = cfg.helmRepos[rel.chart];
      // Without a repo we cannot name the chart, so this becomes a manual step
      // rather than a guess at the reference.
      if (!repo) continue;

      // Every upgrade carries an explicit -f. A bare `helm upgrade` resets the
      // release to chart defaults, which on this cluster would mean discarding
      // things like a 500Gi TSDB volume and its retention. If we have no values
      // to apply, we emit no step rather than a destructive one.
      const valuesPath = opts.valuesPaths?.[releaseKey(rel.namespace, rel.name)];
      if (!valuesPath) continue;

      steps.push({
        id: `helm-${rel.namespace}-${rel.name}-${latest}`,
        title: `Upgrade ${rel.chart} (${rel.name}) to ${latest}`,
        kind: "helm-upgrade",
        argv: [
          cfg.bin.helm,
          ...(cfg.kubeContext ? ["--kube-context", cfg.kubeContext] : []),
          "-n",
          rel.namespace,
          "upgrade",
          rel.name,
          rel.chart,
          "--repo",
          repo,
          "--version",
          latest,
          // -f rather than --reuse-values on purpose: --reuse-values layers the
          // old values over the new chart and suppresses newly-introduced
          // defaults, which defeats the point of moving to the latest chart.
          "-f",
          valuesPath,
          "--wait",
          "--timeout",
          HELM_WAIT,
        ],
        effect: `Upgrades the ${rel.name} release in ${rel.namespace} from ${rel.chartVersion} to ${latest}, applying ${valuesPath} on top of the new chart's defaults.`,
        downtime: "none",
        preflight: [{ kind: "cluster-healthy" }],
        watch: {
          kind: "helm-release",
          release: rel.name,
          namespace: rel.namespace,
          expectChartVersion: latest,
          timeoutMs: HELM_TIMEOUT_MS,
        },
        verify: [
          [
            cfg.bin.helm,
            ...(cfg.kubeContext ? ["--kube-context", cfg.kubeContext] : []),
            "-n",
            rel.namespace,
            "status",
            rel.name,
          ],
        ],
      });
    }
  }

  if (steps.length > 0) {
    steps.push({
      id: "final-verify",
      title: "Confirm the cluster settled",
      kind: "verify",
      argv: [...kubectlBase(cfg), "get", "nodes", "-o", "wide"],
      effect: "Reads cluster state. Changes nothing.",
      downtime: "none",
      preflight: [],
      watch: { kind: "settle", timeoutMs: SETTLE_TIMEOUT_MS },
      verify: [
        [...kubectlBase(cfg), "get", "pods", "-A", "--field-selector", "status.phase!=Running"],
      ],
    });
  }

  return { createdAt: new Date().toISOString(), context: inv.kubeContext, steps };
}
