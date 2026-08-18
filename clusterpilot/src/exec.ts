// The single choke point for every external command clusterpilot runs.
//
// Clusterpilot only ever looks. It plans upgrades, it never performs them, and
// nothing downstream of here (including the model, which can call `probe`) is
// able to reach a mutating verb. The allowlist below is the enforcement: a
// command must name a known binary AND a known read-only subcommand, and must
// not contain a denied verb anywhere in its arguments.

import { spawn } from "node:child_process";

/** Read-only subcommands, per binary. Anything not listed is refused. */
const ALLOWED: Record<string, Set<string>> = {
  talosctl: new Set([
    "version",
    "get",
    "list",
    "read",
    "services",
    "service",
    "health",
    "dmesg",
    "disks",
    "memory",
    "containers",
    "stats",
    "config",
    "time",
  ]),
  kubectl: new Set([
    "get",
    "describe",
    "version",
    "top",
    "logs",
    "api-resources",
    "api-versions",
    "cluster-info",
    "explain",
    "config",
    "auth",
  ]),
  // `repo` only ever touches the local chart cache, never the cluster.
  helm: new Set([
    "list",
    "ls",
    "get",
    "history",
    "status",
    "search",
    "show",
    "repo",
    "version",
    "env",
  ]),
};

/**
 * Verbs that mutate. Checked against every argument, not just the subcommand,
 * so a mutating verb buried in a longer argv has nowhere to hide. `update` is
 * absent from the list on purpose: the only command that reaches it is
 * `helm repo update`, which refreshes the local chart cache.
 */
const DENIED = new Set([
  "apply",
  "create",
  "delete",
  "edit",
  "patch",
  "replace",
  "scale",
  "drain",
  "cordon",
  "uncordon",
  "taint",
  "annotate",
  "label",
  "exec",
  "attach",
  "cp",
  "port-forward",
  "proxy",
  "run",
  "expose",
  "rollout",
  "upgrade",
  "upgrade-k8s",
  "install",
  "uninstall",
  "rollback",
  "reset",
  "reboot",
  "shutdown",
  "apply-config",
  "bootstrap",
  "etcd",
  "push",
  "wipe",
  "gen",
]);

/**
 * Global flags that take a separate value. Without these, `talosctl -n proc-0
 * get disks` reads `proc-0` as the subcommand and gets refused.
 */
const VALUE_FLAGS = new Set([
  "-n",
  "--nodes",
  "--namespace",
  "-e",
  "--endpoints",
  "--context",
  "--kube-context",
  "--kubeconfig",
  "--talosconfig",
  "-o",
  "--output",
  "--as",
  "--field-selector",
  "-l",
  "--selector",
  "--since",
  "--tail",
]);

/**
 * The subcommand is the first bare word that is neither a flag nor the value of
 * one. `--flag=value` carries its own value, so it never consumes the next arg.
 */
export function findSubcommand(argv: string[]): string | undefined {
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("-")) {
      if (VALUE_FLAGS.has(arg)) i++;
      continue;
    }
    return arg;
  }
  return undefined;
}

export class RefusedCommandError extends Error {}

export interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
  durationMs: number;
  /** True when stdout hit maxBytes. Truncated JSON must never be parsed as if whole. */
  truncated: boolean;
}

export interface RunOptions {
  timeoutMs?: number;
  /**
   * Cap on stdout. The default is generous because `kubectl get pods -A -o json`
   * on a modest cluster is already past a megabyte, and a cap that silently
   * clipped it would turn into a confusing JSON parse error downstream.
   */
  maxBytes?: number;
}

/** Throws RefusedCommandError unless argv is a read-only command we recognize. */
export function assertReadOnly(argv: string[]): void {
  if (argv.length === 0) throw new RefusedCommandError("empty command");

  const bin = argv[0]!.split("/").pop()!;
  const allowedSubs = ALLOWED[bin];
  if (!allowedSubs) {
    throw new RefusedCommandError(
      `binary '${bin}' is not allowed; clusterpilot only runs ${Object.keys(ALLOWED).join(", ")}`,
    );
  }

  for (const arg of argv.slice(1)) {
    if (DENIED.has(arg)) {
      throw new RefusedCommandError(
        `'${arg}' is a mutating verb; clusterpilot is read-only and plans upgrades rather than applying them`,
      );
    }
  }

  const sub = findSubcommand(argv);
  if (!sub) throw new RefusedCommandError(`'${bin}' needs a subcommand`);
  if (!allowedSubs.has(sub)) {
    throw new RefusedCommandError(
      `'${bin} ${sub}' is not on the read-only allowlist (allowed: ${[...allowedSubs].join(", ")})`,
    );
  }
}

export async function run(argv: string[], opts: RunOptions = {}): Promise<RunResult> {
  assertReadOnly(argv);

  const timeoutMs = opts.timeoutMs ?? 45_000;
  const maxBytes = opts.maxBytes ?? 32 * 1024 * 1024;
  const started = Date.now();

  return await new Promise<RunResult>((resolve) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let truncated = false;

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null, `timed out after ${timeoutMs}ms`);
    }, timeoutMs);

    const finish = (code: number | null, extraErr?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        stdout,
        stderr: extraErr ? `${stderr}${extraErr}` : stderr,
        code,
        durationMs: Date.now() - started,
        truncated,
      });
    };

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < maxBytes) stdout += chunk.toString("utf8");
      else truncated = true;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < maxBytes) stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => finish(null, err.message));
    child.on("close", (code) => finish(code));
  });
}

/** Runs a command and parses stdout as JSON, returning undefined on any failure. */
export async function runJson<T>(argv: string[], opts?: RunOptions): Promise<T | undefined> {
  const res = await run(argv, opts);
  if (!res.ok) return undefined;
  try {
    return JSON.parse(res.stdout) as T;
  } catch {
    return undefined;
  }
}
