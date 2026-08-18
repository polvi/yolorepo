// The one tool the model gets.
//
// The brief already carries the facts, so `probe` exists for drill-down: the
// model asking a specific follow-up question it could not answer from the
// digest. It routes through the same allowlist as everything else, so the
// worst a confused model can do is get a refusal back.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Config } from "./config.ts";
import { RefusedCommandError, run } from "./exec.ts";

/** Trimmed so one chatty command cannot swamp a 64K context. */
const MAX_OUTPUT_CHARS = 8000;

interface ProbeDetails {
  ok: boolean;
  durationMs: number;
  /** True when the allowlist rejected the command rather than the cluster failing it. */
  refused: boolean;
}

export function makeProbeExtension(cfg: Config) {
  return (pi: ExtensionAPI) => {
    pi.registerTool({
      name: "probe",
      label: "Probe cluster",
      description:
        "Run one read-only talosctl, kubectl, or helm command against the cluster to answer a specific question. " +
        "Mutating commands (apply, delete, upgrade, reset, ...) are refused. " +
        "Pass the command as an argument array, e.g. [\"kubectl\",\"get\",\"pods\",\"-n\",\"kube-system\"]. " +
        "Context flags are added automatically when you omit them.",
      parameters: Type.Object({
        command: Type.Array(Type.String(), {
          description: "Argument vector, starting with talosctl, kubectl, or helm.",
          minItems: 1,
        }),
        reason: Type.String({
          description: "What you are trying to find out. One short sentence.",
        }),
      }),
      execute: async (
        _toolCallId,
        params: { command: string[]; reason: string },
      ): Promise<{ content: { type: "text"; text: string }[]; details: ProbeDetails }> => {
        const argv = [...params.command];

        // Let the model write the natural command and fill in the plumbing.
        const bin = argv[0]?.split("/").pop();
        if (bin === "kubectl" && cfg.kubeContext && !argv.includes("--context")) {
          argv.splice(1, 0, "--context", cfg.kubeContext);
        }
        if (bin === "helm" && cfg.kubeContext && !argv.includes("--kube-context")) {
          argv.splice(1, 0, "--kube-context", cfg.kubeContext);
        }
        if (bin === "talosctl" && !argv.includes("-n") && !argv.includes("--nodes")) {
          const node = cfg.talosNodes[0];
          if (node) argv.splice(1, 0, "-n", node);
        }

        try {
          // Only the first few KB ever reach the model, so there is no reason
          // to buffer a multi-megabyte `-o json` dump on its behalf.
          const res = await run(argv, { timeoutMs: cfg.timeoutMs, maxBytes: 1024 * 1024 });
          const body = res.ok
            ? res.stdout.trim() || "(no output)"
            : `command failed (exit ${res.code})\n${res.stderr.trim()}`;
          const text = body.length > MAX_OUTPUT_CHARS
            ? `${body.slice(0, MAX_OUTPUT_CHARS)}\n...[truncated, ${body.length - MAX_OUTPUT_CHARS} more chars]`
            : body;

          return {
            content: [{ type: "text" as const, text: `$ ${argv.join(" ")}\n\n${text}` }],
            details: { ok: res.ok, durationMs: res.durationMs, refused: false },
          };
        } catch (err) {
          if (err instanceof RefusedCommandError) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Refused: ${err.message}\n\nClusterpilot only reads. Put the command in the plan for a human to run instead.`,
                },
              ],
              details: { ok: false, durationMs: 0, refused: true },
            };
          }
          throw err;
        }
      },
    });
  };
}
