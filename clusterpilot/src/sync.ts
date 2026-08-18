// Writes what the cluster actually is into a file in git, and commits it.
//
// This inverts GitOps rather than implementing it. Under GitOps, git says what
// should be and a reconciler drives the cluster toward it. Here the cluster is
// the source of truth -- upgrades move it to the latest, and this records the
// result so git is the history of what has actually run.
//
// Consequences worth being clear about, since they are the cost of the model:
//
//   - The state file is an output. Editing it changes nothing; the next sync
//     overwrites it. Authored inputs (Helm values files) stay separate and are
//     never written by clusterpilot.
//   - Git no longer tells you what the cluster should be, only what it was at
//     each sync. Recovery means reading the last good commit and acting on it
//     yourself, not re-applying the repo.
//   - A drift between file and cluster means the file is stale, not that the
//     cluster is wrong.

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, relative } from "node:path";
import { parse, stringify } from "yaml";
import type { Config } from "./config.ts";
import { run } from "./exec.ts";
import type { Inventory } from "./types.ts";

export interface ClusterState {
  /** Written by clusterpilot; hand edits are overwritten on the next sync. */
  generated: string;
  context: string;
  talos: {
    nodes: {
      name: string;
      version?: string;
      kernel?: string;
      schematic?: string;
      extensions: Record<string, string>;
    }[];
  };
  kubernetes: { nodes: { name: string; version: string; roles: string[] }[] };
  helm: Record<
    string,
    {
      namespace: string;
      chart: string;
      chartVersion: string;
      appVersion: string;
      /**
       * The operator's supplied values, parsed and redacted. Chart defaults
       * excluded. Secret-shaped keys are replaced, so this is a record of
       * configuration shape rather than a restorable copy.
       */
      values: unknown;
      /**
       * sha256 of the unredacted values. Redaction hides whether a password
       * changed; this makes the change visible without revealing it.
       */
      valuesDigest: string;
    }
  >;
}

export function buildState(inv: Inventory): ClusterState {
  const helm: ClusterState["helm"] = {};
  for (const rel of inv.helmReleases) {
    const raw = rel.userValues ? parseYamlSafe(rel.userValues) : {};
    helm[rel.name] = {
      namespace: rel.namespace,
      chart: rel.chart,
      chartVersion: rel.chartVersion,
      appVersion: rel.appVersion,
      values: redact(raw),
      valuesDigest: createHash("sha256")
        .update(rel.userValues ?? "")
        .digest("hex")
        .slice(0, 16),
    };
  }

  return {
    generated: inv.collectedAt,
    context: inv.kubeContext,
    talos: {
      nodes: inv.talosNodes.map((n) => ({
        name: n.name,
        version: n.version,
        kernel: n.kernel,
        schematic: n.schematic,
        extensions: Object.fromEntries(n.extensions.map((e) => [e.name, e.version])),
      })),
    },
    kubernetes: {
      nodes: inv.kubeNodes.map((n) => ({
        name: n.name,
        version: n.kubeletVersion,
        roles: n.roles,
      })),
    },
    helm,
  };
}

function parseYamlSafe(text: string): unknown {
  try {
    return parse(text) ?? {};
  } catch {
    return {};
  }
}

/**
 * Key-name patterns whose values never go into a git-tracked file.
 *
 * `helm get values` returns everything the operator supplied, and for a real
 * release that includes database passwords and admin credentials in plaintext.
 * The state file is committed and eventually pushed, so those have to be
 * stripped on the way in.
 *
 * The list errs toward over-redaction. A state file that hides one harmless
 * setting is a small loss; one that leaks a Postgres password to a git remote
 * is not, and the leak is unrecoverable once pushed.
 */
const SECRET_KEY_PATTERNS = [
  "password",
  "passwd",
  "passphrase",
  "secret",
  "token",
  "apikey",
  "api_key",
  "accesskey",
  "access_key",
  "privatekey",
  "private_key",
  "credential",
  "bearer",
  "salt",
  "dsn",
  "connectionstring",
  "webhook",
  "license",
];

export const REDACTED = "<redacted by clusterpilot>";

function looksSecret(key: string): boolean {
  const k = key.toLowerCase().replace(/[-_]/g, "");
  return SECRET_KEY_PATTERNS.some((p) => k.includes(p.replace(/[-_]/g, "")));
}

/** Credentials embedded in a URL, e.g. postgres://user:pw@host. */
const URL_CREDENTIALS = /^([a-z][a-z0-9+.-]*:\/\/[^:/@\s]+):[^@/\s]+@/i;

/** Recursively replaces secret-shaped values. Structure is preserved. */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);

  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = looksSecret(k) ? REDACTED : redact(v);
    }
    return out;
  }

  if (typeof value === "string" && URL_CREDENTIALS.test(value)) {
    return value.replace(URL_CREDENTIALS, "$1:" + REDACTED + "@");
  }

  return value;
}

export function renderState(state: ClusterState): string {
  return [
    "# Generated by clusterpilot. Do not edit.",
    "#",
    "# This records what the cluster IS, not what it should be. Upgrades move",
    "# the cluster and this file follows; editing it changes nothing.",
    "#",
    "# Helm values are redacted: secret-shaped keys are replaced, so this is a",
    "# record of configuration shape, not a restorable copy. valuesDigest is a",
    "# hash of the real values, so a change still shows up here.",
    "",
    stringify(state, { lineWidth: 100 }),
  ].join("\n");
}

export interface SyncResult {
  path: string;
  changed: boolean;
  committed: boolean;
  /** Summary of what moved since the last sync, for the commit message. */
  summary: string[];
  message?: string;
}

async function git(repo: string, args: string[]) {
  return await run(["git", "-C", repo, ...args], { git: true, timeoutMs: 30_000 });
}

/** Compares the new state against whatever is committed, for the message. */
function diffSummary(previous: ClusterState | undefined, next: ClusterState): string[] {
  if (!previous) return ["initial sync"];
  const out: string[] = [];

  for (const node of next.talos.nodes) {
    const before = previous.talos.nodes.find((n) => n.name === node.name);
    if (before?.version !== node.version) {
      out.push(`talos ${node.name}: ${before?.version ?? "?"} -> ${node.version ?? "?"}`);
    }
  }
  for (const node of next.kubernetes.nodes) {
    const before = previous.kubernetes.nodes.find((n) => n.name === node.name);
    if (before?.version !== node.version) {
      out.push(`kubernetes ${node.name}: ${before?.version ?? "?"} -> ${node.version}`);
    }
  }
  for (const [name, rel] of Object.entries(next.helm)) {
    const before = previous.helm[name];
    if (!before) out.push(`helm ${name}: new at ${rel.chartVersion}`);
    else if (before.chartVersion !== rel.chartVersion) {
      out.push(`helm ${name}: ${before.chartVersion} -> ${rel.chartVersion}`);
    } else if (before.valuesDigest !== rel.valuesDigest) {
      // Redaction hides which value moved; the digest still says one did.
      out.push(`helm ${name}: values changed (${rel.chartVersion} unchanged)`);
    }
  }
  for (const name of Object.keys(previous.helm)) {
    if (!next.helm[name]) out.push(`helm ${name}: gone`);
  }

  return out.length > 0 ? out : ["no version changes"];
}

export interface SyncOptions {
  cfg: Config;
  inventory: Inventory;
  /** Overrides cfg.syncPath. */
  outPath?: string;
  /** Write the file but leave git alone. */
  noCommit?: boolean;
  log?: (line: string) => void;
}

export async function sync(opts: SyncOptions): Promise<SyncResult> {
  const { cfg, inventory } = opts;
  const log = opts.log ?? (() => {});
  const path = opts.outPath ?? cfg.syncPath;

  if (!path) {
    throw new Error(
      "No sync path configured. Set syncPath in clusterpilot.config.json, CLUSTERPILOT_SYNC_PATH, or pass --out.",
    );
  }

  const state = buildState(inventory);

  // Read the committed version first so the commit message can say what moved.
  let previous: ClusterState | undefined;
  try {
    const file = await Bun.file(path).text();
    previous = parseYamlSafe(file) as ClusterState;
  } catch {
    previous = undefined;
  }

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, renderState(state));
  log(`wrote ${path}`);

  const summary = diffSummary(previous, state);
  const result: SyncResult = { path, changed: true, committed: false, summary };

  if (opts.noCommit) return result;

  const repo = dirname(path);
  const top = await git(repo, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) {
    log(`${repo} is not a git repository; wrote the file without committing`);
    return result;
  }
  const root = top.stdout.trim();

  // Nothing to commit is the normal case when the cluster has not moved.
  const status = await git(root, ["status", "--porcelain", "--", path]);
  if (status.ok && status.stdout.trim() === "") {
    log("no change since the last sync; nothing to commit");
    return { ...result, changed: false };
  }

  const added = await git(root, ["add", "--", path]);
  if (!added.ok) {
    log(`git add failed: ${added.stderr.trim()}`);
    return result;
  }

  const rel = relative(root, path) || path;
  const message = [
    `cluster-state: ${summary[0]}`,
    "",
    ...summary.map((s) => `- ${s}`),
    "",
    `Synced from ${inventory.kubeContext} at ${state.generated}.`,
    `Generated by clusterpilot into ${rel}; the cluster is the source of truth.`,
  ].join("\n");

  const committed = await git(root, ["commit", "-m", message, "--", path]);
  if (!committed.ok) {
    log(`git commit failed: ${committed.stderr.trim()}`);
    return { ...result, message };
  }

  log(`committed to ${root} (not pushed)`);
  return { ...result, committed: true, message };
}
