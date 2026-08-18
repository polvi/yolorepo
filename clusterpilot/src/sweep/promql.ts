// Reading Prometheus without a port-forward.
//
// The cluster runs kube-prometheus with three years of retention, which makes
// it by far the best source for "is anything abnormal": it already scrapes
// node-exporter, kube-state-metrics, smartctl-exporter, and the kubelet, and it
// remembers yesterday, which is what turns a number into a trend.
//
// Getting at it read-only is the trick. `kubectl port-forward` is a mutating
// verb as far as the gate is concerned (it opens a tunnel into the cluster),
// and rightly so. But the API server will proxy a GET to a Service, and
// `kubectl get --raw` is an ordinary read. So the whole client is one allowed
// read-only command with a URL in it, and the gate stays exactly as tight as it
// was.
//
// Prometheus is optional. A cluster without it still sweeps -- it just loses
// the trends and falls back to what kubectl and talosctl report directly.

import type { Config } from "../config.ts";
import { run } from "../exec.ts";
import type { Sample } from "./types.ts";

/** Where kube-prometheus puts the query service, and what it is called. */
const DEFAULT_SERVICE = { namespace: "flux-system", service: "prometheus-operated", port: 9090 };

/** Service names worth trying when the default is not there. */
const CANDIDATE_SERVICES = [
  "prometheus-operated",
  "prometheus-k8s",
  "prometheus-server",
  "kube-prometheus-stack-prometheus",
];

export interface PromTarget {
  namespace: string;
  service: string;
  port: number;
}

interface PromResponse {
  status: string;
  error?: string;
  data?: { result?: { metric: Record<string, string>; value: [number, string] }[] };
}

interface AlertsResponse {
  status: string;
  data?: {
    alerts?: {
      labels: Record<string, string>;
      annotations?: Record<string, string>;
      state: string;
      activeAt?: string;
    }[];
  };
}

interface ServiceList {
  items: { metadata: { name: string; namespace: string }; spec?: { ports?: { port: number }[] } }[];
}

export class Prometheus {
  private constructor(
    private readonly cfg: Config,
    readonly target: PromTarget,
  ) {}

  /**
   * Finds a Prometheus to talk to, or returns undefined. Tries the configured
   * or conventional location first and only lists services if that misses,
   * because listing every service in the cluster to find something that is
   * almost always in the same place is a waste of a round trip.
   */
  static async discover(cfg: Config): Promise<Prometheus | undefined> {
    const configured = cfg.prometheus;
    const first = configured ?? DEFAULT_SERVICE;

    const candidate = new Prometheus(cfg, first);
    if (await candidate.reachable()) return candidate;

    // An explicitly configured target that does not answer is an error the
    // operator wants to see, not something to paper over by guessing.
    if (configured) return undefined;

    const list = await runJsonQuiet<ServiceList>(
      cfg,
      kubectl(cfg, "get", "svc", "-A", "-o", "json"),
    );
    for (const item of list?.items ?? []) {
      if (!CANDIDATE_SERVICES.includes(item.metadata.name)) continue;
      const port = item.spec?.ports?.find((p) => p.port === 9090)?.port ?? item.spec?.ports?.[0]?.port;
      if (!port) continue;
      const found = new Prometheus(cfg, {
        namespace: item.metadata.namespace,
        service: item.metadata.name,
        port,
      });
      if (await found.reachable()) return found;
    }
    return undefined;
  }

  private path(suffix: string): string {
    const { namespace, service, port } = this.target;
    return `/api/v1/namespaces/${namespace}/services/${service}:${port}/proxy/api/v1${suffix}`;
  }

  private async raw(suffix: string, timeoutMs: number): Promise<string | undefined> {
    const res = await run(kubectl(this.cfg, "get", "--raw", this.path(suffix)), { timeoutMs });
    return res.ok ? res.stdout : undefined;
  }

  async reachable(): Promise<boolean> {
    const body = await this.raw("/query?query=vector(1)", 15_000);
    return !!body && body.includes('"success"');
  }

  /** One instant query. Returns [] on any failure, so a bad query cannot abort a sweep. */
  async instant(query: string, timeoutMs = 30_000): Promise<Sample[]> {
    const body = await this.raw(`/query?query=${encodeURIComponent(query)}`, timeoutMs);
    if (!body) return [];

    let parsed: PromResponse;
    try {
      parsed = JSON.parse(body) as PromResponse;
    } catch {
      return [];
    }
    if (parsed.status !== "success") return [];

    return (parsed.data?.result ?? []).flatMap((r) => {
      const value = Number(r.value[1]);
      // NaN is what Prometheus returns for a division with no data. It is not
      // zero, and treating it as zero would read as "0% used" on a missing
      // metric -- the most dangerous possible wrong answer for a headroom check.
      return Number.isFinite(value) ? [{ labels: r.metric, value }] : [];
    });
  }

  /** Alerts currently firing, as Alertmanager would see them. */
  async firingAlerts(): Promise<{ name: string; severity: string; summary: string; labels: Record<string, string> }[]> {
    const body = await this.raw("/alerts", 30_000);
    if (!body) return [];

    let parsed: AlertsResponse;
    try {
      parsed = JSON.parse(body) as AlertsResponse;
    } catch {
      return [];
    }

    return (parsed.data?.alerts ?? [])
      .filter((a) => a.state === "firing")
      .map((a) => ({
        name: a.labels.alertname ?? "unknown",
        severity: a.labels.severity ?? "none",
        summary: a.annotations?.summary ?? a.annotations?.description ?? "",
        labels: a.labels,
      }));
  }
}

function kubectl(cfg: Config, ...args: string[]): string[] {
  const argv = [cfg.bin.kubectl];
  if (cfg.kubeContext) argv.push("--context", cfg.kubeContext);
  return [...argv, ...args];
}

async function runJsonQuiet<T>(cfg: Config, argv: string[]): Promise<T | undefined> {
  const res = await run(argv, { timeoutMs: cfg.timeoutMs });
  if (!res.ok || res.truncated) return undefined;
  try {
    return JSON.parse(res.stdout) as T;
  } catch {
    return undefined;
  }
}
