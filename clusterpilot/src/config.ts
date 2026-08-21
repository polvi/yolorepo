// Configuration, with everything optional. The defaults discover the cluster
// from the ambient kubeconfig and talosconfig, so clusterpilot runs against
// whatever you are already pointed at without a config file.

import { readFile } from "node:fs/promises";
import { run } from "./exec.ts";

export interface Config {
  /** kubectl context name. Defaults to the current context. */
  kubeContext: string;
  /**
   * Talos nodes to query. Defaults to the Kubernetes node names, which is
   * right for Omni-managed clusters where node name resolves through the proxy.
   */
  talosNodes: string[];
  /** Binary paths, so a non-PATH install still works. */
  bin: { talosctl: string; kubectl: string; helm: string };
  /** GitHub repos used for upstream release lookups. */
  releases: { talos: string; kubernetes: string };
  /**
   * Helm chart name -> repo index URL. Charts not listed here are reported as
   * "no upstream configured" rather than silently skipped.
   */
  helmRepos: Record<string, string>;
  /** OpenAI-compatible base URL of the local llama.cpp server, used when no explicit model is set. */
  llamaBaseUrl: string;
  /**
   * Model to use: "provider/model" or a model id, resolved against modelsJson.
   * When unset, clusterpilot follows pi's own default provider and model, and
   * falls back to whatever the local server has loaded.
   */
  model?: string;
  /**
   * models.json to read providers from. Defaults to the one pi itself uses
   * (~/.pi/agent/models.json).
   */
  modelsJson?: string;
  /**
   * settings.json to read pi's default provider and model from. Defaults to
   * the one pi itself uses (~/.pi/agent/settings.json).
   */
  settingsJson?: string;
  /**
   * Authored values files, keyed by release name or "namespace/release".
   * When a release has one, upgrades apply it with -f so your file stays the
   * source of its settings. Releases without one get their current supplied
   * values replayed instead, captured at plan time.
   */
  helmValues: Record<string, string>;
  /**
   * Where `sync` writes the generated cluster-state file. The cluster is the
   * source of truth and this records it, so the file is machine-written and
   * should not be hand-edited.
   */
  syncPath?: string;
  /**
   * Where the sweep finds Prometheus, reached read-only through the API server
   * proxy rather than a port-forward. Left unset, clusterpilot looks in the
   * conventional place and then searches for a service by name; set it to skip
   * the search or to point at a Prometheus somewhere unusual.
   */
  prometheus?: { namespace: string; service: string; port: number };
  /** Where written plans land. */
  plansDir: string;
  /** Per-command timeout. Talos calls over Omni can be slow. */
  timeoutMs: number;
}

const DEFAULT_HELM_REPOS: Record<string, string> = {
  "kube-prometheus-stack": "https://prometheus-community.github.io/helm-charts",
  "tailscale-operator": "https://pkgs.tailscale.com/helmcharts",
  "caddy-ingress-controller": "https://caddyserver.github.io/ingress/",
  gitea: "https://dl.gitea.com/charts/",
  "zfs-localpv": "https://openebs.github.io/zfs-localpv",
};

async function currentKubeContext(kubectl: string): Promise<string> {
  const res = await run([kubectl, "config", "current-context"], { timeoutMs: 10_000 });
  return res.ok ? res.stdout.trim() : "";
}

async function discoverNodes(kubectl: string, context: string): Promise<string[]> {
  const args = [kubectl, "get", "nodes", "-o", "jsonpath={range .items[*]}{.metadata.name}{'\\n'}{end}"];
  if (context) args.splice(1, 0, "--context", context);
  const res = await run(args, { timeoutMs: 30_000 });
  if (!res.ok) return [];
  return res.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

/**
 * Loads clusterpilot.config.json if present, fills the gaps by asking the
 * cluster, and returns a fully-resolved config.
 */
export async function loadConfig(path = "clusterpilot.config.json"): Promise<Config> {
  let file: Partial<Config> = {};
  try {
    file = JSON.parse(await readFile(path, "utf8")) as Partial<Config>;
  } catch {
    // No config file is the normal case.
  }

  const bin = {
    talosctl: process.env.TALOSCTL ?? file.bin?.talosctl ?? "talosctl",
    kubectl: process.env.KUBECTL ?? file.bin?.kubectl ?? "kubectl",
    helm: process.env.HELM ?? file.bin?.helm ?? "helm",
  };

  const kubeContext =
    process.env.CLUSTERPILOT_CONTEXT ?? file.kubeContext ?? (await currentKubeContext(bin.kubectl));

  const talosNodes =
    file.talosNodes && file.talosNodes.length > 0
      ? file.talosNodes
      : await discoverNodes(bin.kubectl, kubeContext);

  return {
    kubeContext,
    talosNodes,
    bin,
    releases: {
      talos: file.releases?.talos ?? "siderolabs/talos",
      kubernetes: file.releases?.kubernetes ?? "kubernetes/kubernetes",
    },
    helmRepos: { ...DEFAULT_HELM_REPOS, ...(file.helmRepos ?? {}) },
    helmValues: file.helmValues ?? {},
    syncPath: process.env.CLUSTERPILOT_SYNC_PATH ?? file.syncPath,
    llamaBaseUrl: process.env.LLAMA_BASE_URL ?? file.llamaBaseUrl ?? "http://127.0.0.1:8080/v1",
    model: process.env.CLUSTERPILOT_MODEL ?? file.model,
    modelsJson: process.env.CLUSTERPILOT_MODELS_JSON ?? file.modelsJson,
    settingsJson: process.env.CLUSTERPILOT_SETTINGS_JSON ?? file.settingsJson,
    prometheus: file.prometheus,
    plansDir: file.plansDir ?? "plans",
    timeoutMs: file.timeoutMs ?? 45_000,
  };
}
