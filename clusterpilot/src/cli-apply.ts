// The `apply` command: build a plan, show it, and optionally carry it out.

import { createInterface } from "node:readline/promises";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { execute } from "./execute.ts";
import { Journal } from "./journal.ts";
import { buildPlan, type PlanOptions } from "./plan.ts";
import { collect } from "./probes/index.ts";
import { sync } from "./sync.ts";
import { materializeValues } from "./values.ts";
import type { ExecutionPlan, Inventory, Step, UpstreamVersions } from "./types.ts";

function renderPlan(plan: ExecutionPlan): string {
  if (plan.steps.length === 0) {
    return "Nothing to do: everything is already at its newest stable version.";
  }

  const lines = [`Execution plan for ${plan.context} — ${plan.steps.length} step(s)`, ""];
  for (const [i, step] of plan.steps.entries()) {
    lines.push(`${i + 1}. ${step.title}`);
    lines.push(`   $ ${step.argv.join(" ")}`);
    lines.push(`   ${step.effect}`);
    lines.push(`   downtime: ${step.downtime}`);
    if (step.preflight.length > 0) {
      lines.push(`   gates: ${step.preflight.map((p) => p.kind).join(", ")}`);
    }
    if (step.watch) lines.push(`   watch: ${step.watch.kind}`);
    lines.push("");
  }
  return lines.join("\n");
}

/** Asks once per step. Anything but an explicit yes stops the run. */
async function confirmStep(step: Step): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const warning =
      step.downtime === "full-outage"
        ? "\n      THIS TAKES THE WHOLE CLUSTER DOWN UNTIL THE NODE COMES BACK."
        : "";
    const answer = await rl.question(`      run this step? [y/N]${warning}\n      > `);
    return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
  } finally {
    rl.close();
  }
}

export interface ApplyDeps {
  cfg: Config;
  inventory: Inventory;
  upstream: UpstreamVersions;
}

export async function cmdApply(args: string[], deps: ApplyDeps): Promise<void> {
  const { cfg, inventory, upstream } = deps;

  const flagValue = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };

  const resolved = await materializeValues(cfg, inventory);
  for (const note of resolved.notes) console.log(`values: ${note}`);
  for (const skip of resolved.skipped) console.log(`skipping: ${skip}`);
  if (resolved.notes.length > 0 || resolved.skipped.length > 0) console.log("");

  const planOpts: PlanOptions = {
    snapshotPath: flagValue("--snapshot"),
    talosOnly: args.includes("--talos-only"),
    skipHelm: args.includes("--skip-helm"),
    valuesPaths: resolved.paths,
  };

  const plan = buildPlan(cfg, inventory, upstream, planOpts);
  console.log(renderPlan(plan));

  if (plan.steps.length === 0) return;

  const apply = args.includes("--apply");
  const assumeYes = args.includes("--yes");

  if (!apply) {
    console.log(
      "This was a dry run. Preflight gates still run so you can see what would block.\n" +
        "Add --apply to execute, and --yes to skip the per-step prompt.\n",
    );
  }

  const journalPath = join(cfg.plansDir, `run-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
  const journal = new Journal(journalPath);
  console.log(`journal: ${journalPath}\n`);

  const result = await execute({
    cfg,
    plan,
    journal,
    apply,
    assumeYes,
    confirm: confirmStep,
    log: (line) => console.log(line),
  });

  const done = result.outcomes.filter((o) => o.status === "succeeded").length;
  console.log(`\n${result.status}: ${done}/${plan.steps.length} step(s) completed.`);
  console.log(`full record: ${journalPath}`);

  // Record the result. Worth doing even on a failed run: a partially-applied
  // upgrade is exactly the state you most want written down, and a sync that
  // only ran on success would leave git describing a cluster that no longer
  // exists. Re-collect first, because the inventory above predates the run.
  if (apply && done > 0 && (cfg.syncPath || args.includes("--sync"))) {
    console.log("\nsyncing state to git...");
    try {
      const fresh = await collect(cfg);
      const synced = await sync({ cfg, inventory: fresh, log: (l) => console.log(`  ${l}`) });
      for (const line of synced.summary) console.log(`  ${line}`);
      if (synced.committed) console.log("  review and push when you are ready");
    } catch (err) {
      console.log(`  sync failed: ${(err as Error).message}`);
    }
  }

  if (result.status !== "completed") process.exitCode = 1;
}
