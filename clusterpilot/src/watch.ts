// Rollout watching.
//
// The hard part is that during a Talos upgrade the thing we are querying goes
// away: the node reboots, so talosctl and kubectl both start failing, and they
// fail in the ordinary way (connection refused, timeout, TLS error) rather than
// in a way that distinguishes "rebooting as planned" from "bricked".
//
// So the watchers treat *every* error as "not there yet" and keep polling until
// the deadline. Failure is only ever declared by the timeout. That means a
// genuinely dead node costs a full timeout before we notice, which is the right
// trade: calling a healthy reboot a failure would send the troubleshooter (and
// possibly a human) after a problem that does not exist.

import type { Config } from "./config.ts";
import { run } from "./exec.ts";
import { probeTalos } from "./probes/talos.ts";
import type { WatchSpec } from "./types.ts";

const POLL_INTERVAL_MS = 10_000;

export interface WatchProgress {
  (message: string): void;
}

export interface WatchResult {
  ok: boolean;
  detail: string;
  /** How long we waited, for the journal. */
  elapsedMs: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** kubelet version for a node, or undefined if the API is unreachable. */
async function kubeletVersion(cfg: Config, node?: string): Promise<string | undefined> {
  const argv = [cfg.bin.kubectl];
  if (cfg.kubeContext) argv.push("--context", cfg.kubeContext);
  argv.push("get", "nodes", "-o", "json");

  const res = await run(argv, { timeoutMs: 20_000 });
  if (!res.ok) return undefined;

  try {
    const parsed = JSON.parse(res.stdout) as {
      items: { metadata: { name: string }; status: { nodeInfo: { kubeletVersion: string } } }[];
    };
    const item = node ? parsed.items.find((i) => i.metadata.name === node) : parsed.items[0];
    return item?.status.nodeInfo.kubeletVersion.replace(/^v/, "");
  } catch {
    return undefined;
  }
}

async function nodeReady(cfg: Config, node: string): Promise<boolean> {
  const argv = [cfg.bin.kubectl];
  if (cfg.kubeContext) argv.push("--context", cfg.kubeContext);
  argv.push("get", "node", node, "-o", "json");

  const res = await run(argv, { timeoutMs: 20_000 });
  if (!res.ok) return false;
  try {
    const parsed = JSON.parse(res.stdout) as {
      status: { conditions: { type: string; status: string }[] };
    };
    return parsed.status.conditions.some((c) => c.type === "Ready" && c.status === "True");
  } catch {
    return false;
  }
}

/**
 * Waits for a node to come back on the expected Talos version and report Ready.
 *
 * Both conditions matter: the Talos API answers well before the kubelet has
 * rejoined, so version-only would call the upgrade done while the cluster was
 * still unusable.
 */
async function watchNodeReboot(
  cfg: Config,
  node: string,
  expectVersion: string,
  deadline: number,
  progress: WatchProgress,
): Promise<{ ok: boolean; detail: string }> {
  let sawUnreachable = false;

  while (Date.now() < deadline) {
    const single = { ...cfg, talosNodes: [node] };
    const { nodes } = await probeTalos(single);
    const version = nodes[0]?.version;

    if (!version) {
      if (!sawUnreachable) {
        progress(`${node} is unreachable — expected while it reboots`);
        sawUnreachable = true;
      }
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    if (version !== expectVersion) {
      progress(`${node} answering on ${version}, waiting for ${expectVersion}`);
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    const ready = await nodeReady(cfg, node);
    if (!ready) {
      progress(`${node} is on ${version}; waiting for the kubelet to report Ready`);
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    return { ok: true, detail: `${node} is on Talos ${version} and Ready` };
  }

  return {
    ok: false,
    detail: `${node} did not reach Talos ${expectVersion} and Ready before the timeout`,
  };
}

async function watchK8sVersion(
  cfg: Config,
  expectVersion: string,
  deadline: number,
  progress: WatchProgress,
): Promise<{ ok: boolean; detail: string }> {
  while (Date.now() < deadline) {
    const version = await kubeletVersion(cfg);
    if (version === expectVersion) {
      return { ok: true, detail: `kubelet is on ${version}` };
    }
    progress(version ? `kubelet on ${version}, waiting for ${expectVersion}` : "API unreachable");
    await sleep(POLL_INTERVAL_MS);
  }
  return { ok: false, detail: `Kubernetes did not reach ${expectVersion} before the timeout` };
}

async function watchHelmRelease(
  cfg: Config,
  release: string,
  namespace: string,
  expectChartVersion: string,
  deadline: number,
  progress: WatchProgress,
): Promise<{ ok: boolean; detail: string }> {
  while (Date.now() < deadline) {
    const argv = [cfg.bin.helm];
    if (cfg.kubeContext) argv.push("--kube-context", cfg.kubeContext);
    argv.push("-n", namespace, "list", "-o", "json");

    const res = await run(argv, { timeoutMs: 30_000 });
    if (res.ok) {
      try {
        const list = JSON.parse(res.stdout) as { name: string; chart: string; status: string }[];
        const found = list.find((r) => r.name === release);
        if (found?.chart.endsWith(`-${expectChartVersion}`) && found.status === "deployed") {
          return { ok: true, detail: `${release} is deployed at ${found.chart}` };
        }
        if (found) progress(`${release} is ${found.status} at ${found.chart}`);
      } catch {
        // fall through and retry
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return { ok: false, detail: `${release} did not reach ${expectChartVersion}/deployed in time` };
}

/**
 * Waits for workloads to stop churning: three consecutive clean polls, so a
 * single lucky moment mid-restart does not read as settled.
 */
async function watchSettle(
  cfg: Config,
  deadline: number,
  progress: WatchProgress,
): Promise<{ ok: boolean; detail: string }> {
  const REQUIRED_CLEAN_POLLS = 3;
  let clean = 0;

  while (Date.now() < deadline) {
    const argv = [cfg.bin.kubectl];
    if (cfg.kubeContext) argv.push("--context", cfg.kubeContext);
    argv.push("get", "pods", "-A", "-o", "json");

    const res = await run(argv, { timeoutMs: 30_000 });
    if (res.ok) {
      try {
        const parsed = JSON.parse(res.stdout) as {
          items: { metadata: { name: string; namespace: string }; status: { phase: string } }[];
        };
        const bad = parsed.items.filter(
          (p) => p.status.phase !== "Running" && p.status.phase !== "Succeeded",
        );
        if (bad.length === 0) {
          clean++;
          if (clean >= REQUIRED_CLEAN_POLLS) {
            return { ok: true, detail: "all pods Running or Succeeded across three polls" };
          }
          progress(`clean poll ${clean}/${REQUIRED_CLEAN_POLLS}`);
        } else {
          clean = 0;
          progress(
            `${bad.length} pod(s) not settled: ${bad
              .slice(0, 3)
              .map((p) => `${p.metadata.namespace}/${p.metadata.name}`)
              .join(", ")}`,
          );
        }
      } catch {
        clean = 0;
      }
    } else {
      clean = 0;
      progress("API unreachable");
    }
    await sleep(POLL_INTERVAL_MS);
  }

  return { ok: false, detail: "workloads did not settle before the timeout" };
}

export async function watch(
  cfg: Config,
  spec: WatchSpec,
  progress: WatchProgress = () => {},
): Promise<WatchResult> {
  const started = Date.now();
  const deadline = started + spec.timeoutMs;

  let result: { ok: boolean; detail: string };
  switch (spec.kind) {
    case "node-reboot":
      result = await watchNodeReboot(cfg, spec.node, spec.expectTalosVersion, deadline, progress);
      break;
    case "k8s-version":
      result = await watchK8sVersion(cfg, spec.expectVersion, deadline, progress);
      break;
    case "helm-release":
      result = await watchHelmRelease(
        cfg,
        spec.release,
        spec.namespace,
        spec.expectChartVersion,
        deadline,
        progress,
      );
      break;
    case "settle":
      result = await watchSettle(cfg, deadline, progress);
      break;
  }

  return { ...result, elapsedMs: Date.now() - started };
}
