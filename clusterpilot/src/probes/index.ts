import type { Config } from "../config.ts";
import type { Inventory } from "../types.ts";
import { probeHelm } from "./helm.ts";
import { probeKubernetes } from "./kubernetes.ts";
import { probeTalos } from "./talos.ts";

/**
 * Runs every probe and assembles the inventory. Talos and Kubernetes are
 * independent, so they run concurrently; a failure in one leaves its section
 * empty and records the reason in `probes` rather than aborting collection.
 */
export async function collect(cfg: Config): Promise<Inventory> {
  const [talos, kube, helm] = await Promise.all([
    probeTalos(cfg),
    probeKubernetes(cfg),
    probeHelm(cfg),
  ]);

  return {
    collectedAt: new Date().toISOString(),
    kubeContext: cfg.kubeContext,
    talosNodes: talos.nodes,
    kubeNodes: kube.nodes,
    helmReleases: helm.releases,
    workloads: kube.workloads,
    probes: [...talos.probes, ...kube.probes, ...helm.probes],
  };
}

export { probeHelm, probeKubernetes, probeTalos };
