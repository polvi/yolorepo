// Shared shapes for the inventory the probes collect, the upstream versions we
// look up, and the findings the deterministic analyzer derives from the two.

export type Severity = "critical" | "warning" | "info";

/** One read-only command we ran, kept so the plan can cite its evidence. */
export interface ProbeResult {
  /** Stable key, e.g. "talos.version" or "k8s.nodes". */
  id: string;
  /** The exact argv we ran, so a human can reproduce it. */
  command: string[];
  ok: boolean;
  /** Parsed value when ok, otherwise undefined. */
  data?: unknown;
  /** Populated when the command failed or the parse did. */
  error?: string;
  durationMs: number;
}

export interface TalosDisk {
  id: string;
  size: string;
  model?: string;
  serial?: string;
  transport?: string;
  rotational: boolean;
}

export interface TalosNode {
  name: string;
  /** e.g. "1.13.8", absent if the version call failed. */
  version?: string;
  kernel?: string;
  /** Image Factory schematic ID; the upgrade image must be built from this. */
  schematic?: string;
  extensions: { name: string; version: string }[];
  /** Real block devices; loop devices are filtered out. */
  disks: TalosDisk[];
  services: { id: string; state: string; health: string }[];
}

export interface KubeNode {
  name: string;
  /** kubelet version without the leading v, e.g. "1.36.3". */
  kubeletVersion: string;
  roles: string[];
  ready: boolean;
  osImage: string;
  kernel: string;
  containerRuntime: string;
  /** Conditions in a bad state (DiskPressure=True etc). */
  pressures: string[];
}

export interface HelmRelease {
  name: string;
  namespace: string;
  /** Chart name without the version suffix, e.g. "kube-prometheus-stack". */
  chart: string;
  chartVersion: string;
  appVersion: string;
  status: string;
}

export interface WorkloadHealth {
  /** Pods not Running/Succeeded, capped so the model prompt stays small. */
  unhealthyPods: {
    namespace: string;
    name: string;
    phase: string;
    reason: string;
    restarts: number;
  }[];
  pendingPvcs: { namespace: string; name: string }[];
  /** Warning-type events, deduplicated by reason. */
  recentWarnings: { namespace: string; reason: string; message: string; count: number }[];
}

export interface Inventory {
  collectedAt: string;
  kubeContext: string;
  talosNodes: TalosNode[];
  kubeNodes: KubeNode[];
  helmReleases: HelmRelease[];
  workloads: WorkloadHealth;
  probes: ProbeResult[];
}

export interface UpstreamVersions {
  /** Stable Talos releases, newest first, e.g. ["1.14.1", "1.14.0", ...]. */
  talos: string[];
  /** Stable Kubernetes releases, newest first. */
  kubernetes: string[];
  /** Chart name -> available versions, newest first. */
  charts: Record<string, string[]>;
  errors: string[];
}

export interface Finding {
  id: string;
  severity: Severity;
  category: "talos" | "kubernetes" | "helm" | "hardware" | "workload" | "topology";
  title: string;
  detail: string;
  current?: string;
  latest?: string;
  /** Concrete commands a human would run. Never executed by this tool. */
  suggested?: string[];
}
