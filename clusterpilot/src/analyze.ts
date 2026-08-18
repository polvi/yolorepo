// Deterministic gap analysis.
//
// The split of labour in clusterpilot: this file decides *what is true* (which
// versions are behind, which upgrade steps exist, what blocks an upgrade) using
// plain comparisons, and the model decides *what to do about it* (sequencing
// prose, risk framing, what to watch). Version arithmetic is never delegated to
// a language model, least of all a local one.

import * as semver from "./semver.ts";
import type { Finding, Inventory, UpstreamVersions } from "./types.ts";

/**
 * The installer image for a Talos upgrade. A node built from an Image Factory
 * schematic must be upgraded with an image built from that same schematic, or
 * the upgrade silently drops every system extension the node depends on -- for
 * this cluster that includes the ZFS module backing every PVC.
 */
export function installerImage(version: string, schematic?: string): string {
  return schematic
    ? `factory.talos.dev/installer/${schematic}:v${version}`
    : `ghcr.io/siderolabs/installer:v${version}`;
}

function findingsForTalos(inv: Inventory, up: UpstreamVersions): Finding[] {
  const out: Finding[] = [];
  const singleNode = inv.kubeNodes.length === 1;

  const versions = new Set(inv.talosNodes.map((n) => n.version).filter(Boolean) as string[]);
  if (versions.size > 1) {
    out.push({
      id: "talos.drift",
      severity: "warning",
      category: "talos",
      title: "Talos versions differ across nodes",
      detail: `Nodes are not on a single Talos version: ${[...versions].join(", ")}. Converge them before starting a new upgrade so the cluster has one known-good baseline.`,
    });
  }

  for (const node of inv.talosNodes) {
    if (!node.version) {
      out.push({
        id: `talos.${node.name}.unknown`,
        severity: "warning",
        category: "talos",
        title: `Could not read the Talos version on ${node.name}`,
        detail:
          "talosctl could not reach the node. Talos API keys expire; re-authenticate and re-run before trusting the rest of this plan.",
        suggested: [`talosctl -n ${node.name} version`],
      });
      continue;
    }

    if (up.talos.length === 0) continue;

    const latest = up.talos[0]!;
    const path = semver.upgradePath(node.version, up.talos);
    if (path.length === 0) {
      out.push({
        id: `talos.${node.name}.current`,
        severity: "info",
        category: "talos",
        title: `Talos on ${node.name} is current`,
        detail: `Running ${node.version}, the newest stable release in the ${semver.minorSeries(node.version)} series and above.`,
        current: node.version,
        latest,
      });
      continue;
    }

    const distance = semver.minorDistance(node.version, latest);
    const severity = distance >= 2 ? "critical" : distance === 1 ? "warning" : "info";
    const steps = path.map(
      (v) =>
        `talosctl upgrade --nodes ${node.name} --image ${installerImage(v, node.schematic)}`,
    );

    out.push({
      id: `talos.${node.name}.upgrade`,
      severity,
      category: "talos",
      title: `Talos on ${node.name}: ${node.version} → ${latest}`,
      detail: [
        `Talos upgrades one minor series at a time, landing on the newest patch of each. That makes the path ${[node.version, ...path].join(" → ")} (${path.length} reboot${path.length === 1 ? "" : "s"}).`,
        node.schematic
          ? `This node was built from Image Factory schematic ${node.schematic}, carrying ${node.extensions.map((e) => e.name).join(", ") || "no extensions"}. Every upgrade image below is built from that same schematic; using the stock installer instead would drop those extensions.`
          : "No Image Factory schematic was found, so the stock installer applies. Confirm this node genuinely has no system extensions before upgrading.",
        singleNode
          ? "This is a single-node cluster, so the reboot is a full outage and etcd goes with it. Take a snapshot first. Do not reach for --preserve: it is deprecated as of Talos 1.13 and selects a legacy upgrade path, and the ephemeral partition is preserved by default without it."
          : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
      current: node.version,
      latest,
      suggested: steps,
    });
  }

  return out;
}

function findingsForKubernetes(inv: Inventory, up: UpstreamVersions): Finding[] {
  const out: Finding[] = [];
  if (inv.kubeNodes.length === 0) return out;

  const kubelets = [...new Set(inv.kubeNodes.map((n) => n.kubeletVersion))];
  const oldest = semver.sortDesc(kubelets).at(-1)!;
  const newest = semver.sortDesc(kubelets)[0]!;

  // Kubernetes supports kubelets up to 3 minors behind the API server.
  if (semver.minorDistance(oldest, newest) > 3) {
    out.push({
      id: "k8s.skew",
      severity: "critical",
      category: "kubernetes",
      title: "Kubelet version skew exceeds the supported window",
      detail: `Oldest kubelet is ${oldest}, newest is ${newest}. Kubernetes supports at most 3 minor versions of skew; bring the laggards up before anything else.`,
      current: oldest,
      latest: newest,
    });
  }

  if (up.kubernetes.length === 0) return out;

  const latest = up.kubernetes[0]!;
  const path = semver.upgradePath(newest, up.kubernetes);
  if (path.length === 0) {
    out.push({
      id: "k8s.current",
      severity: "info",
      category: "kubernetes",
      title: "Kubernetes is current",
      detail: `Control plane is on ${newest}, the newest stable release.`,
      current: newest,
      latest,
    });
    return out;
  }

  const distance = semver.minorDistance(newest, latest);
  out.push({
    id: "k8s.upgrade",
    severity: distance >= 3 ? "critical" : distance >= 1 ? "warning" : "info",
    category: "kubernetes",
    title: `Kubernetes: ${newest} → ${latest}`,
    detail: [
      `Control plane upgrades go one minor at a time: ${[newest, ...path].join(" → ")}.`,
      "On Talos this is `talosctl upgrade-k8s`, which rolls the static pods and the kubelet for you; it is not a Helm or kubeadm operation.",
      "Check the Talos support matrix first. Each Talos release supports a bounded range of Kubernetes versions, so the Talos upgrade generally has to land before the Kubernetes one.",
    ].join("\n\n"),
    current: newest,
    latest,
    suggested: path.map((v) => `talosctl --nodes ${inv.kubeNodes[0]!.name} upgrade-k8s --to ${v}`),
  });

  return out;
}

function findingsForHelm(inv: Inventory, up: UpstreamVersions): Finding[] {
  const out: Finding[] = [];

  for (const rel of inv.helmReleases) {
    if (rel.status !== "deployed") {
      out.push({
        id: `helm.${rel.name}.status`,
        severity: "warning",
        category: "helm",
        title: `Helm release ${rel.name} is ${rel.status}`,
        detail: `A release that is not 'deployed' will make the next upgrade of it ambiguous. Resolve the state in ${rel.namespace} before upgrading it.`,
        suggested: [`helm -n ${rel.namespace} history ${rel.name}`],
      });
    }

    const available = up.charts[rel.chart];
    if (!available || available.length === 0) continue;

    const latest = available[0]!;
    if (semver.compareStrings(latest, rel.chartVersion) <= 0) {
      out.push({
        id: `helm.${rel.name}.current`,
        severity: "info",
        category: "helm",
        title: `${rel.chart} is current at ${rel.chartVersion}`,
        detail: `No newer chart published in the configured repo.`,
        current: rel.chartVersion,
        latest,
      });
      continue;
    }

    const kind = semver.gap(rel.chartVersion, latest);
    out.push({
      id: `helm.${rel.name}.upgrade`,
      severity: kind === "major" ? "warning" : "info",
      category: "helm",
      title: `${rel.chart} (${rel.name}): ${rel.chartVersion} → ${latest}`,
      detail:
        kind === "major"
          ? `This is a major chart bump, which for charts like these usually means CRD changes that Helm will not apply on its own. Read the upgrade notes and apply CRDs by hand before the release upgrade.`
          : `A ${kind} chart update is available.`,
      current: rel.chartVersion,
      latest,
      suggested: [
        `helm -n ${rel.namespace} get values ${rel.name} > ${rel.name}-values.yaml`,
        `helm -n ${rel.namespace} upgrade ${rel.name} <repo>/${rel.chart} --version ${latest} -f ${rel.name}-values.yaml`,
      ],
    });
  }

  return out;
}

function findingsForTopologyAndHealth(inv: Inventory): Finding[] {
  const out: Finding[] = [];

  const controlPlanes = inv.kubeNodes.filter((n) =>
    n.roles.some((r) => r === "control-plane" || r === "master"),
  );

  if (controlPlanes.length === 1 && inv.kubeNodes.length === 1) {
    out.push({
      id: "topology.single-node",
      severity: "warning",
      category: "topology",
      title: "Single-node cluster: every upgrade is a full outage",
      detail: [
        "There is one node, and it is the control plane, so there is nowhere to drain to and no etcd quorum to survive a reboot. Each Talos upgrade takes the whole cluster down for the duration of a reboot.",
        "Two consequences for the plan: take an etcd snapshot immediately before any Talos upgrade, and schedule the work in a window where downtime is acceptable rather than treating it as a rolling operation.",
      ].join("\n\n"),
      suggested: [`talosctl -n ${inv.kubeNodes[0]!.name} etcd snapshot etcd-backup.db`],
    });
  } else if (controlPlanes.length === 2) {
    out.push({
      id: "topology.even-quorum",
      severity: "warning",
      category: "topology",
      title: "Two control-plane nodes cannot lose one",
      detail:
        "A 2-member etcd cluster loses quorum when either member goes down, so a rolling upgrade will stall the API server. Add a third control-plane node before upgrading.",
    });
  }

  for (const node of inv.kubeNodes) {
    if (!node.ready) {
      out.push({
        id: `health.${node.name}.notready`,
        severity: "critical",
        category: "workload",
        title: `Node ${node.name} is not Ready`,
        detail: "Do not start an upgrade against a cluster that is already degraded. Fix this first.",
      });
    }
    if (node.pressures.length > 0) {
      out.push({
        id: `health.${node.name}.pressure`,
        severity: "warning",
        category: "hardware",
        title: `Node ${node.name} reports ${node.pressures.join(", ")}`,
        detail:
          "Talos upgrades pull a new installer image and rewrite the boot partition, both of which need headroom. Clear the pressure condition before upgrading.",
      });
    }
  }

  const crashers = inv.workloads.unhealthyPods.filter((p) => p.reason.includes("CrashLoop"));
  if (crashers.length > 0) {
    out.push({
      id: "health.crashloops",
      severity: "warning",
      category: "workload",
      title: `${crashers.length} pod(s) in CrashLoopBackOff`,
      detail: `Existing crash loops make it impossible to tell whether an upgrade broke something new. Resolve or acknowledge them first: ${crashers
        .slice(0, 5)
        .map((p) => `${p.namespace}/${p.name}`)
        .join(", ")}.`,
    });
  }

  if (inv.workloads.pendingPvcs.length > 0) {
    out.push({
      id: "health.pending-pvcs",
      severity: "warning",
      category: "workload",
      title: `${inv.workloads.pendingPvcs.length} PVC(s) not Bound`,
      detail: `Unbound volumes usually mean the storage provisioner is unhappy, which an upgrade will make worse: ${inv.workloads.pendingPvcs
        .slice(0, 5)
        .map((p) => `${p.namespace}/${p.name}`)
        .join(", ")}.`,
    });
  }

  // Node-local storage turns "reboot a node" into "take those volumes offline".
  const zfs = inv.talosNodes.some((n) => n.extensions.some((e) => e.name === "zfs"));
  if (zfs) {
    out.push({
      id: "hardware.local-storage",
      severity: "info",
      category: "hardware",
      title: "Storage is node-local ZFS",
      detail: [
        "The ZFS system extension is installed, so persistent volumes live on this node's pool rather than on network storage. They cannot follow a workload to another node, and they only survive an upgrade if the upgrade preserves the data partitions.",
        "Two things follow: the upgrade image must carry the matching ZFS extension (the schematic handles this), and the pool should be verified healthy before and after each reboot.",
      ].join("\n\n"),
      suggested: ["kubectl get zfsvolumes -A", "kubectl -n kube-system get pods -l role=openebs-zfs"],
    });
  }

  const failed = inv.probes.filter((p) => !p.ok);
  if (failed.length > 0) {
    out.push({
      id: "probes.failed",
      severity: "warning",
      category: "workload",
      title: `${failed.length} probe(s) failed; this plan is working from partial data`,
      detail: failed.map((p) => `${p.id}: ${p.error}`).join("\n"),
    });
  }

  return out;
}

const SEVERITY_RANK: Record<Finding["severity"], number> = { critical: 0, warning: 1, info: 2 };

export function analyze(inv: Inventory, up: UpstreamVersions): Finding[] {
  const findings = [
    ...findingsForTopologyAndHealth(inv),
    ...findingsForTalos(inv, up),
    ...findingsForKubernetes(inv, up),
    ...findingsForHelm(inv, up),
  ];

  if (up.errors.length > 0) {
    findings.push({
      id: "upstream.errors",
      severity: "info",
      category: "workload",
      title: "Some upstream version lookups failed",
      detail: up.errors.join("\n"),
    });
  }

  return findings.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}
