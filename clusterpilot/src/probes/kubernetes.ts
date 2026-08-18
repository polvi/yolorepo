// Kubernetes probes: node versions and the health signals that decide whether
// an upgrade is safe to start today.

import type { Config } from "../config.ts";
import { run } from "../exec.ts";
import type { KubeNode, ProbeResult, WorkloadHealth } from "../types.ts";

/** Caps on what we carry into the model prompt; the full data stays in the inventory JSON. */
const MAX_UNHEALTHY_PODS = 25;
const MAX_WARNINGS = 20;

function kubectl(cfg: Config, ...args: string[]): string[] {
  const argv = [cfg.bin.kubectl];
  if (cfg.kubeContext) argv.push("--context", cfg.kubeContext);
  return [...argv, ...args];
}

async function getJson<T>(
  cfg: Config,
  id: string,
  args: string[],
  probes: ProbeResult[],
): Promise<T | undefined> {
  const command = kubectl(cfg, ...args);
  const res = await run(command, { timeoutMs: cfg.timeoutMs });
  if (!res.ok) {
    probes.push({
      id,
      command,
      ok: false,
      error: res.stderr.trim() || `exit ${res.code}`,
      durationMs: res.durationMs,
    });
    return undefined;
  }
  if (res.truncated) {
    probes.push({
      id,
      command,
      ok: false,
      error: "output exceeded the size cap, so the JSON is incomplete and was not parsed",
      durationMs: res.durationMs,
    });
    return undefined;
  }

  try {
    const parsed = JSON.parse(res.stdout) as T;
    probes.push({ id, command, ok: true, durationMs: res.durationMs });
    return parsed;
  } catch (err) {
    probes.push({
      id,
      command,
      ok: false,
      error: `unparseable JSON: ${(err as Error).message}`,
      durationMs: res.durationMs,
    });
    return undefined;
  }
}

interface NodeList {
  items: {
    metadata: { name: string; labels?: Record<string, string> };
    status: {
      nodeInfo: {
        kubeletVersion: string;
        osImage: string;
        kernelVersion: string;
        containerRuntimeVersion: string;
      };
      conditions: { type: string; status: string }[];
    };
  }[];
}

interface PodList {
  items: {
    metadata: { name: string; namespace: string };
    status: {
      phase: string;
      reason?: string;
      containerStatuses?: {
        restartCount: number;
        state?: { waiting?: { reason?: string }; terminated?: { reason?: string } };
      }[];
    };
  }[];
}

interface PvcList {
  items: { metadata: { name: string; namespace: string }; status: { phase: string } }[];
}

interface EventList {
  items: {
    type: string;
    reason?: string;
    message?: string;
    count?: number;
    metadata: { namespace?: string };
  }[];
}

export async function probeKubernetes(
  cfg: Config,
): Promise<{ nodes: KubeNode[]; workloads: WorkloadHealth; probes: ProbeResult[] }> {
  const probes: ProbeResult[] = [];

  const nodeList = await getJson<NodeList>(cfg, "k8s.nodes", ["get", "nodes", "-o", "json"], probes);
  const nodes: KubeNode[] = (nodeList?.items ?? []).map((n) => {
    const ready = n.status.conditions.find((c) => c.type === "Ready")?.status === "True";
    // Every condition except Ready is a problem when True.
    const pressures = n.status.conditions
      .filter((c) => c.type !== "Ready" && c.status === "True")
      .map((c) => c.type);
    const roles = Object.keys(n.metadata.labels ?? {})
      .filter((k) => k.startsWith("node-role.kubernetes.io/"))
      .map((k) => k.replace("node-role.kubernetes.io/", ""));
    return {
      name: n.metadata.name,
      kubeletVersion: n.status.nodeInfo.kubeletVersion.replace(/^v/, ""),
      roles: roles.length > 0 ? roles : ["worker"],
      ready,
      osImage: n.status.nodeInfo.osImage,
      kernel: n.status.nodeInfo.kernelVersion,
      containerRuntime: n.status.nodeInfo.containerRuntimeVersion,
      pressures,
    };
  });

  const podList = await getJson<PodList>(
    cfg,
    "k8s.pods",
    ["get", "pods", "-A", "-o", "json"],
    probes,
  );
  const unhealthyPods = (podList?.items ?? [])
    .filter((p) => p.status.phase !== "Running" && p.status.phase !== "Succeeded")
    .map((p) => {
      const cs = p.status.containerStatuses ?? [];
      const reason =
        p.status.reason ??
        cs.find((c) => c.state?.waiting?.reason)?.state?.waiting?.reason ??
        cs.find((c) => c.state?.terminated?.reason)?.state?.terminated?.reason ??
        "";
      return {
        namespace: p.metadata.namespace,
        name: p.metadata.name,
        phase: p.status.phase,
        reason,
        restarts: cs.reduce((sum, c) => sum + c.restartCount, 0),
      };
    })
    .slice(0, MAX_UNHEALTHY_PODS);

  const pvcList = await getJson<PvcList>(cfg, "k8s.pvcs", ["get", "pvc", "-A", "-o", "json"], probes);
  const pendingPvcs = (pvcList?.items ?? [])
    .filter((p) => p.status.phase !== "Bound")
    .map((p) => ({ namespace: p.metadata.namespace, name: p.metadata.name }));

  const eventList = await getJson<EventList>(
    cfg,
    "k8s.events",
    ["get", "events", "-A", "--field-selector", "type=Warning", "-o", "json"],
    probes,
  );
  // Collapse by reason: one FailedScheduling line is signal, four hundred is noise.
  const byReason = new Map<string, { namespace: string; reason: string; message: string; count: number }>();
  for (const e of eventList?.items ?? []) {
    const reason = e.reason ?? "Unknown";
    const key = `${e.metadata.namespace ?? ""}/${reason}`;
    const existing = byReason.get(key);
    if (existing) existing.count += e.count ?? 1;
    else
      byReason.set(key, {
        namespace: e.metadata.namespace ?? "",
        reason,
        message: (e.message ?? "").slice(0, 200),
        count: e.count ?? 1,
      });
  }
  const recentWarnings = [...byReason.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_WARNINGS);

  return { nodes, workloads: { unhealthyPods, pendingPvcs, recentWarnings }, probes };
}
