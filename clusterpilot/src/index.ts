#!/usr/bin/env bun
// clusterpilot CLI.
//
//   clusterpilot status   collect and print the state, no model involved
//   clusterpilot plan     collect, analyze, then have the local model write the upgrade plan
//   clusterpilot ask      one-off question against the live cluster

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { runAgent } from "./agent.ts";
import { analyze } from "./analyze.ts";
import { loadConfig } from "./config.ts";
import { detectLoadedModel } from "./model.ts";
import { collect } from "./probes/index.ts";
import { buildPrompt } from "./prompt.ts";
import { renderDigest, renderPlanDocument } from "./render.ts";
import { fetchUpstream } from "./upstream/index.ts";

const USAGE = `clusterpilot — read-only Talos/Kubernetes upgrade planner

  clusterpilot status [--json]   Collect cluster state and computed findings. No model.
  clusterpilot plan [--out FILE] Collect, analyze, and write an upgrade plan with the local model.
  clusterpilot ask "<question>"  Ask the model one question; it can probe the cluster to answer.

Options
  --json          Machine-readable output (status only)
  --out FILE      Where to write the plan (default: plans/<context>-<date>.md)
  --no-stream     Do not stream model output to stdout
  --thinking L    off | minimal | low | medium | high (default: medium)

Environment
  LLAMA_BASE_URL        OpenAI-compatible endpoint (default http://127.0.0.1:8080/v1)
  CLUSTERPILOT_CONTEXT  Override the kubectl context
  GITHUB_TOKEN          Raises the GitHub API rate limit for release lookups

Clusterpilot never mutates the cluster. Mutating commands are refused at the
process level, including any the model tries to run.`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function gather() {
  const cfg = await loadConfig();
  if (!cfg.kubeContext) {
    throw new Error("No kubectl context found. Set one, or set CLUSTERPILOT_CONTEXT.");
  }
  process.stderr.write(`collecting from ${cfg.kubeContext}...\n`);

  const inventory = await collect(cfg);
  const charts = [...new Set(inventory.helmReleases.map((r) => r.chart))];
  const upstream = await fetchUpstream(cfg, charts);
  const findings = analyze(inventory, upstream);

  return { cfg, inventory, upstream, findings };
}

async function cmdStatus(args: string[]) {
  const { inventory, upstream, findings } = await gather();

  if (args.includes("--json")) {
    console.log(JSON.stringify({ inventory, upstream, findings }, null, 2));
    return;
  }

  console.log(renderDigest(inventory, findings));
}

async function cmdPlan(args: string[]) {
  const { cfg, inventory, findings } = await gather();

  const stream = !args.includes("--no-stream");
  const thinking = (flag(args, "--thinking") ?? "medium") as "off" | "low" | "medium" | "high";

  const digest = renderDigest(inventory, findings);
  process.stderr.write(`planning with the local model...\n\n`);

  const outcome = await runAgent({
    cfg,
    prompt: buildPrompt(digest),
    stream,
    thinkingLevel: thinking,
  });

  if (!outcome.text.trim()) {
    throw new Error("The model returned nothing. Check that the llama.cpp server is healthy.");
  }

  const doc = renderPlanDocument(inventory, findings, outcome.text, outcome.modelId);
  const date = inventory.collectedAt.slice(0, 10);
  const out = flag(args, "--out") ?? join(cfg.plansDir, `${cfg.kubeContext}-${date}.md`);

  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, doc);
  process.stderr.write(`\n\nplan written to ${out}\n`);
}

async function cmdAsk(args: string[]) {
  const question = args.find((a) => !a.startsWith("--"));
  if (!question) throw new Error('ask needs a question, e.g. clusterpilot ask "is etcd healthy?"');

  const cfg = await loadConfig();
  const outcome = await runAgent({
    cfg,
    prompt: `${question}\n\nUse the probe tool to check the live cluster before answering. Be brief.`,
    stream: !args.includes("--no-stream"),
    thinkingLevel: "low",
  });

  if (!args.includes("--no-stream")) process.stdout.write("\n");
  else console.log(outcome.text);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case "status":
      await cmdStatus(args);
      break;
    case "plan":
      await cmdPlan(args);
      break;
    case "ask":
      await cmdAsk(args);
      break;
    case "model": {
      const cfg = await loadConfig();
      const loaded = await detectLoadedModel(cfg.llamaBaseUrl);
      console.log(`${loaded.id} (context ${loaded.contextWindow}) at ${cfg.llamaBaseUrl}`);
      break;
    }
    default:
      console.log(USAGE);
      process.exitCode = command ? 1 : 0;
  }
}

main().catch((err: Error) => {
  process.stderr.write(`\nclusterpilot: ${err.message}\n`);
  process.exitCode = 1;
});
