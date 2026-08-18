// Troubleshooting after a failed step.
//
// Two halves, deliberately split. Gathering is deterministic: a fixed battery
// of read-only commands chosen by the kind of step that failed, so the evidence
// does not depend on the model asking the right question. Diagnosis is the
// model's job, and its output is advice for a human -- clusterpilot never acts
// on a diagnosis. Auto-remediation on a cluster that has just failed an upgrade
// is how a recoverable problem becomes an unrecoverable one.

import { runAgent } from "./agent.ts";
import type { Config } from "./config.ts";
import { run } from "./exec.ts";
import { TROUBLESHOOT_PROMPT } from "./prompt.ts";
import type { Diagnosis, Step } from "./types.ts";

/** Per-command cap; the whole bundle has to fit in a 64K context alongside the prompt. */
const MAX_CHARS_PER_COMMAND = 3000;

function kubectl(cfg: Config, ...args: string[]): string[] {
  const argv = [cfg.bin.kubectl];
  if (cfg.kubeContext) argv.push("--context", cfg.kubeContext);
  return [...argv, ...args];
}

/** Read-only commands worth running when a step of this kind fails. */
function diagnosticsFor(cfg: Config, step: Step): string[][] {
  const node = cfg.talosNodes[0] ?? "";
  const common = [
    kubectl(cfg, "get", "nodes", "-o", "wide"),
    kubectl(cfg, "get", "pods", "-A", "--field-selector", "status.phase!=Running"),
    kubectl(cfg, "get", "events", "-A", "--field-selector", "type=Warning"),
  ];

  switch (step.kind) {
    case "talos-upgrade":
      return [
        [cfg.bin.talosctl, "-n", node, "version"],
        [cfg.bin.talosctl, "-n", node, "get", "machinestatus"],
        [cfg.bin.talosctl, "-n", node, "get", "services"],
        // The upgrade writes its story to the kernel log.
        [cfg.bin.talosctl, "-n", node, "dmesg"],
        [cfg.bin.talosctl, "-n", node, "get", "extensions"],
        ...common,
      ];
    case "k8s-upgrade":
      return [
        [cfg.bin.talosctl, "-n", node, "get", "services"],
        kubectl(cfg, "-n", "kube-system", "get", "pods"),
        ...common,
      ];
    case "helm-upgrade":
      return [
        [
          cfg.bin.helm,
          ...(cfg.kubeContext ? ["--kube-context", cfg.kubeContext] : []),
          "list",
          "-A",
          "-o",
          "json",
        ],
        ...common,
      ];
    case "snapshot":
      return [[cfg.bin.talosctl, "-n", node, "get", "services"], ...common];
    case "verify":
      return common;
  }
}

export interface Evidence {
  command: string;
  ok: boolean;
  output: string;
}

/** Runs the diagnostic battery. Every command is read-only. */
export async function gather(cfg: Config, step: Step): Promise<Evidence[]> {
  const out: Evidence[] = [];

  for (const argv of diagnosticsFor(cfg, step)) {
    try {
      const res = await run(argv, { timeoutMs: 30_000, maxBytes: 1024 * 1024 });
      const body = (res.ok ? res.stdout : res.stderr).trim();
      out.push({
        command: argv.join(" "),
        ok: res.ok,
        output:
          body.length > MAX_CHARS_PER_COMMAND
            ? `${body.slice(0, MAX_CHARS_PER_COMMAND)}\n…[truncated]`
            : body || "(no output)",
      });
    } catch (err) {
      out.push({ command: argv.join(" "), ok: false, output: (err as Error).message });
    }
  }

  return out;
}

/** Pulls the first JSON object out of the model's reply. */
function parseDiagnosis(text: string): Diagnosis | undefined {
  const fenced = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  const bare = text.match(/\{[\s\S]*\}/);
  const candidate = fenced?.[1] ?? bare?.[0];
  if (!candidate) return undefined;

  try {
    const parsed = JSON.parse(candidate) as Partial<Diagnosis>;
    if (typeof parsed.summary !== "string") return undefined;
    return {
      summary: parsed.summary,
      likelyCause: parsed.likelyCause ?? "unknown",
      // Absent means unknown, and unknown must not read as stable.
      clusterStable: parsed.clusterStable === true,
      recommendations: Array.isArray(parsed.recommendations) ? parsed.recommendations : [],
    };
  } catch {
    return undefined;
  }
}

export async function diagnose(
  cfg: Config,
  step: Step,
  failure: string,
  evidence: Evidence[],
): Promise<Diagnosis> {
  const bundle = evidence
    .map((e) => `$ ${e.command}${e.ok ? "" : "   (command failed)"}\n${e.output}`)
    .join("\n\n");

  const prompt = `A step in an upgrade run failed.

## The step
${step.title}
kind: ${step.kind}
command: ${step.argv.join(" ")}
effect: ${step.effect}

## How it failed
${failure}

## Evidence collected after the failure
${bundle}

Diagnose it and reply with a single JSON object, nothing else:

{
  "summary": "one or two sentences on what happened",
  "likelyCause": "the most probable cause",
  "clusterStable": true or false,
  "recommendations": ["concrete next actions for a human"]
}`;

  try {
    const outcome = await runAgent({
      cfg,
      prompt,
      systemPrompt: TROUBLESHOOT_PROMPT,
      stream: false,
      thinkingLevel: "medium",
    });

    const parsed = parseDiagnosis(outcome.text);
    if (parsed) return parsed;

    // Better to hand back the model's prose than to discard it over formatting.
    return {
      summary: outcome.text.trim().slice(0, 1000) || "The model returned no diagnosis.",
      likelyCause: "unknown (the model did not return structured output)",
      clusterStable: false,
      recommendations: ["Review the evidence in the journal by hand."],
    };
  } catch (err) {
    return {
      summary: `The troubleshooter could not run: ${(err as Error).message}`,
      likelyCause: "unknown",
      clusterStable: false,
      recommendations: [
        "Inspect the cluster by hand; clusterpilot stopped without diagnosing.",
        `Re-run the failed command manually: ${step.argv.join(" ")}`,
      ],
    };
  }
}
