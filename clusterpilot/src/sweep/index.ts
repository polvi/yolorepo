// The sweep: look for anything abnormal right now, and anything trending that
// way, across metrics, kernel logs, and Kubernetes object state.
//
// This is the counterpart to `status`. Status answers "what is installed and
// what is behind"; the sweep answers "is this cluster healthy". They need
// different inputs and produce different output, so they are separate commands
// rather than one command with a flag.
//
// Degradation is deliberate. Prometheus is the best source by a wide margin --
// it is the only one that remembers yesterday, which is what makes trends
// possible -- but a cluster without it still sweeps, losing the trends and
// falling back to what kubectl and talosctl report directly. A sweep that
// refused to run without monitoring would be useless exactly when monitoring
// broke.

import type { Config } from "../config.ts";
import { run } from "../exec.ts";
import { probeKubernetes } from "../probes/kubernetes.ts";
import type { Severity } from "../types.ts";
import { redactText } from "../redact.ts";
import { collectCrashLogs, sweepKernelLogs } from "./logs.ts";
import { checkAlerts, checkCapacity, checkHardware, checkWorkloads } from "./metrics.ts";
import { Prometheus } from "./promql.ts";
import type { Anomaly, Headroom, SweepReport, SweepSource } from "./types.ts";

export interface SweepOptions {
  /** How far back kernel logs still count as current. */
  windowHours?: number;
  /** Skip the crash-log collection pass, which is the slowest part. */
  skipLogs?: boolean;
}

/** Lines of a failing Talos service log to carry as evidence. */
const SERVICE_LOG_TAIL = 20;

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

/** Real problems first, expected noise last, most severe first within each. */
export function sortAnomalies(anomalies: Anomaly[]): Anomaly[] {
  return [...anomalies].sort((a, b) => {
    if (!!a.expected !== !!b.expected) return a.expected ? 1 : -1;
    const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    return bySeverity !== 0 ? bySeverity : a.id.localeCompare(b.id);
  });
}

/** Anomalies that are actually claiming something is wrong. */
export function realAnomalies(anomalies: Anomaly[]): Anomaly[] {
  return anomalies.filter((a) => !a.expected && a.severity !== "info");
}

export async function runSweep(cfg: Config, opts: SweepOptions = {}): Promise<SweepReport> {
  const anomalies: Anomaly[] = [];
  const headroom: Headroom[] = [];
  const sources: SweepSource[] = [];

  const prom = await Prometheus.discover(cfg);

  if (prom) {
    sources.push({
      id: "prometheus",
      ok: true,
      note: `${prom.target.namespace}/${prom.target.service}:${prom.target.port} via the API server proxy`,
    });

    const [capacity, hardware, workloads, alerts] = await Promise.all([
      checkCapacity(prom),
      checkHardware(prom),
      checkWorkloads(prom),
      checkAlerts(prom),
    ]);

    anomalies.push(...capacity.anomalies, ...hardware, ...workloads, ...alerts);
    headroom.push(...capacity.headroom);
  } else {
    sources.push({
      id: "prometheus",
      ok: false,
      note: "not reachable; capacity trends, hardware counters, and firing alerts were skipped",
    });
  }

  // Object state. Always collected: it needs no monitoring stack, and node
  // conditions are the one signal that must never depend on the thing being
  // monitored still working.
  const kube = await probeKubernetes(cfg);
  sources.push({
    id: "kubernetes",
    ok: kube.probes.every((p) => p.ok),
    note: kube.probes.filter((p) => !p.ok).map((p) => `${p.id}: ${p.error}`).join("; ") || undefined,
  });

  for (const node of kube.nodes) {
    if (!node.ready) {
      anomalies.push({
        id: `node.${node.name}.notready`,
        severity: "critical",
        category: "control-plane",
        title: `Node ${node.name} is not Ready`,
        detail: "The kubelet is not reporting healthy. Nothing schedules here until it is.",
        evidence: [`Ready condition is not True on ${node.name}`],
      });
    }
    for (const pressure of node.pressures) {
      anomalies.push({
        id: `node.${node.name}.${pressure}`,
        severity: "critical",
        category: "capacity",
        title: `Node ${node.name} reports ${pressure}`,
        detail:
          "The kubelet has raised a pressure condition, which means it is already evicting or about to. " +
          "This is downstream of something filling up; the headroom table says what.",
        evidence: [`${pressure}=True on ${node.name}`],
      });
    }
  }

  for (const pvc of kube.workloads.pendingPvcs) {
    anomalies.push({
      id: `pvc.unbound.${pvc.namespace}/${pvc.name}`,
      severity: "warning",
      category: "storage",
      title: `PVC ${pvc.namespace}/${pvc.name} is not Bound`,
      detail: "Whatever wants this volume cannot start until it binds.",
      evidence: ["phase is not Bound"],
    });
  }

  // Without Prometheus there is no restart history, so pod phase from the API
  // is the only workload signal left. With it, checkWorkloads already covered
  // this from the time series, and repeating it here would double-report.
  if (!prom) {
    for (const pod of kube.workloads.unhealthyPods) {
      anomalies.push({
        id: `pod.${pod.namespace}/${pod.name}`,
        severity: pod.phase === "Pending" ? "warning" : "critical",
        category: "workload",
        title: `${pod.namespace}/${pod.name} is ${pod.phase}${pod.reason ? ` (${pod.reason})` : ""}`,
        detail: "Reported from the API server; no restart history is available without Prometheus.",
        evidence: [`phase ${pod.phase}`, `restarts ${pod.restarts}`],
      });
    }
  }

  // Talos service health, which sits below Kubernetes and stays readable when
  // the API server does not.
  const talosProblems = await checkTalosServices(cfg);
  anomalies.push(...talosProblems.anomalies);
  sources.push({ id: "talos-services", ok: talosProblems.ok, note: talosProblems.note });

  if (!opts.skipLogs) {
    const kernel = await sweepKernelLogs(cfg, opts.windowHours);
    anomalies.push(...kernel.anomalies);
    sources.push({ id: "kernel-logs", ok: kernel.ok, note: kernel.note });

    // Only for pods the checks already flagged, so this stays proportional to
    // the number of things going wrong rather than the size of the cluster.
    const restarting = anomalies
      .filter((a) => a.category === "workload" && !a.expected)
      .map((a) => a.id.match(/^(?:restarts|oom|phase|pod)\.([^/]+)\/([^.]+)/))
      .filter(Boolean)
      .map((m) => ({ namespace: m![1]!, name: m![2]! }));

    const unique = [...new Map(restarting.map((p) => [`${p.namespace}/${p.name}`, p])).values()];
    const crashLogs = await collectCrashLogs(cfg, unique.slice(0, 10));

    for (const log of crashLogs) {
      const target = anomalies.find((a) => a.id.includes(log.ref));
      if (target) {
        target.evidence.push("--- previous container logs (tail) ---", log.text);
      }
    }
    sources.push({ id: "crash-logs", ok: true, note: `${crashLogs.length} previous-container log(s) collected` });
  }

  return {
    collectedAt: new Date().toISOString(),
    context: cfg.kubeContext,
    anomalies: sortAnomalies(anomalies),
    headroom: headroom.sort((a, b) => b.usedFraction - a.usedFraction),
    sources,
  };
}

async function checkTalosServices(
  cfg: Config,
): Promise<{ anomalies: Anomaly[]; ok: boolean; note?: string }> {
  const anomalies: Anomaly[] = [];
  const failures: string[] = [];
  let anyOk = false;

  for (const node of cfg.talosNodes) {
    const res = await run([cfg.bin.talosctl, "-n", node, "services"], { timeoutMs: cfg.timeoutMs });
    if (!res.ok) {
      failures.push(`${node}: ${res.stderr.trim().slice(0, 200) || `exit ${res.code}`}`);
      continue;
    }
    anyOk = true;

    // Columns: NODE SERVICE STATE HEALTH LAST CHANGE LAST EVENT
    for (const line of res.stdout.split("\n").slice(1)) {
      const cols = line.trim().split(/\s{2,}/);
      if (cols.length < 4) continue;
      const [, service, state, health] = cols;
      if (!service || state === undefined || health === undefined) continue;

      // "?" is Talos's marker for a service with no health check, which is
      // normal for one-shot services and must not read as unhealthy.
      const unhealthy = health !== "OK" && health !== "?";
      if (state === "Running" && !unhealthy) continue;

      // The service's own log says why, and it is the one place that knows.
      const log = await run([cfg.bin.talosctl, "-n", node, "logs", service], {
        timeoutMs: 20_000,
        maxBytes: 512 * 1024,
      });
      const tail = log.ok
        ? redactText(log.stdout.trim()).split("\n").slice(-SERVICE_LOG_TAIL).join("\n")
        : "";

      anomalies.push({
        id: `talos.service.${node}.${service}`,
        severity: state === "Running" ? "warning" : "critical",
        category: "control-plane",
        title: `Talos service ${service} on ${node}: state ${state}, health ${health}`,
        detail:
          "Talos services sit below Kubernetes. A failure here explains failures above it, not the other way round.",
        evidence: tail ? [line.trim(), `--- talosctl logs ${service} (tail) ---`, tail] : [line.trim()],
      });
    }
  }

  return { anomalies, ok: anyOk, note: failures.join("; ") || undefined };
}

export type { Anomaly, Headroom, SweepReport } from "./types.ts";
