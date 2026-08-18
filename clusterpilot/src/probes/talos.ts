// Talos probes. Everything goes through `talosctl get <resource> -o json`,
// which emits a stream of pretty-printed JSON documents back to back rather
// than a JSON array or JSONL, so we scan brace depth to split them.

import type { Config } from "../config.ts";
import { run } from "../exec.ts";
import type { ProbeResult, TalosDisk, TalosNode } from "../types.ts";

interface TalosResource<S> {
  metadata: { id: string | number; type: string; version: number };
  node: string;
  spec: S;
}

/**
 * Splits concatenated JSON documents. Tracks string state so a brace inside a
 * description field (Talos extension metadata is full of them) does not end a
 * document early.
 */
export function parseJsonStream<T>(text: string): T[] {
  const out: T[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') inString = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          out.push(JSON.parse(text.slice(start, i + 1)) as T);
        } catch {
          // Skip a malformed document rather than losing the whole stream.
        }
        start = -1;
      }
    }
  }
  return out;
}

async function getResource<S>(
  cfg: Config,
  node: string,
  resource: string,
  probes: ProbeResult[],
): Promise<TalosResource<S>[]> {
  const command = [cfg.bin.talosctl, "-n", node, "get", resource, "-o", "json"];
  const res = await run(command, { timeoutMs: cfg.timeoutMs });
  const id = `talos.${node}.${resource}`;

  if (!res.ok) {
    probes.push({
      id,
      command,
      ok: false,
      error: res.stderr.trim() || `exit ${res.code}`,
      durationMs: res.durationMs,
    });
    return [];
  }

  const parsed = parseJsonStream<TalosResource<S>>(res.stdout);
  probes.push({ id, command, ok: true, data: parsed.length, durationMs: res.durationMs });
  return parsed;
}

/** `talosctl version` prints a text block; the node's tag is under `Server:`. */
function parseServerVersion(stdout: string): string | undefined {
  const server = stdout.split(/Server:/)[1];
  if (!server) return undefined;
  return server.match(/Tag:\s*v?([\d.]+)/)?.[1];
}

export async function probeTalos(cfg: Config): Promise<{ nodes: TalosNode[]; probes: ProbeResult[] }> {
  const probes: ProbeResult[] = [];
  const nodes: TalosNode[] = [];

  for (const name of cfg.talosNodes) {
    const versionCmd = [cfg.bin.talosctl, "-n", name, "version"];
    const versionRes = await run(versionCmd, { timeoutMs: cfg.timeoutMs });
    const version = versionRes.ok ? parseServerVersion(versionRes.stdout) : undefined;
    probes.push({
      id: `talos.${name}.version`,
      command: versionCmd,
      ok: versionRes.ok && !!version,
      data: version,
      error: versionRes.ok ? undefined : versionRes.stderr.trim() || `exit ${versionRes.code}`,
      durationMs: versionRes.durationMs,
    });

    const extRes = await getResource<{ metadata: { name: string; version: string } }>(
      cfg,
      name,
      "extensions",
      probes,
    );
    const extensions = extRes
      .map((r) => ({ name: r.spec.metadata.name, version: r.spec.metadata.version }))
      // modules.dep is a synthetic entry that tracks the kernel, not an extension.
      .filter((e) => e.name !== "modules.dep");

    // The Image Factory records the schematic as a pseudo-extension. Upgrading
    // without it silently drops every other extension on the node.
    const schematic = extensions.find((e) => e.name === "schematic")?.version;
    const kernel = extRes.find((r) => r.spec.metadata.name === "modules.dep")?.spec.metadata.version;

    const diskRes = await getResource<{
      size?: number;
      pretty_size?: string;
      model?: string;
      wwid?: string;
      transport?: string;
      rotational?: boolean;
      readonly?: boolean;
      cdrom?: boolean;
    }>(cfg, name, "disks", probes);

    const disks: TalosDisk[] = diskRes
      // Loop devices are squashfs mounts for the system extensions, not hardware.
      .filter((r) => !String(r.metadata.id).startsWith("loop"))
      .filter((r) => !r.spec.readonly && !r.spec.cdrom)
      .map((r) => ({
        id: String(r.metadata.id),
        size: r.spec.pretty_size ?? (r.spec.size ? `${r.spec.size} bytes` : "unknown"),
        model: r.spec.model,
        // Talos reports wwid rather than a bare serial; it is what smartctl keys on.
        serial: r.spec.wwid,
        transport: r.spec.transport,
        rotational: r.spec.rotational ?? false,
      }));

    const svcRes = await getResource<{ healthy?: boolean; running?: boolean; unknown?: boolean }>(
      cfg,
      name,
      "services",
      probes,
    );
    const services = svcRes.map((r) => ({
      id: String(r.metadata.id),
      state: r.spec.running ? "Running" : "Stopped",
      health: r.spec.unknown ? "unknown" : r.spec.healthy ? "OK" : "unhealthy",
    }));

    nodes.push({
      name,
      version,
      kernel,
      schematic,
      extensions: extensions.filter((e) => e.name !== "schematic"),
      disks,
      services,
    });
  }

  return { nodes, probes };
}
