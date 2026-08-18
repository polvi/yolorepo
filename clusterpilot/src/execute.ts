// The executor.
//
// Runs an ExecutionPlan step by step: preflight, confirm, execute, watch,
// verify, journal. The rules it enforces, in order of how much they matter:
//
//   1. Dry-run is the default. Nothing mutates without an explicit opt-in.
//   2. Preflight runs against freshly collected state, not the plan's snapshot.
//   3. A failed step aborts the run. There is no automatic retry of a mutating
//      command, because "run it again" after a half-finished node upgrade is
//      how you turn one problem into two.
//   4. The troubleshooter diagnoses; it never remediates.
//   5. Every command, verdict, and diagnosis lands in the journal as it happens.

import { Journal, now } from "./journal.ts";
import type { Config } from "./config.ts";
import { run } from "./exec.ts";
import { runPreflight } from "./preflight.ts";
import { diagnose, gather } from "./troubleshoot.ts";
import type { ExecutionPlan, Step, StepOutcome } from "./types.ts";
import { watch } from "./watch.ts";

export interface ExecuteOptions {
  cfg: Config;
  plan: ExecutionPlan;
  journal: Journal;
  /** False is the default everywhere; true actually changes the cluster. */
  apply: boolean;
  /** Skip the per-step prompt. Only meaningful with apply. */
  assumeYes: boolean;
  /** Asks the operator to approve one step. Returns false to stop the run. */
  confirm: (step: Step, preflightLines: string[]) => Promise<boolean>;
  log: (line: string) => void;
}

export interface ExecuteResult {
  outcomes: StepOutcome[];
  status: "completed" | "aborted" | "failed";
}

/** Long operations need their own ceiling; a node upgrade can run for many minutes. */
function timeoutFor(step: Step): number {
  switch (step.kind) {
    case "talos-upgrade":
      return 45 * 60_000;
    case "k8s-upgrade":
      return 30 * 60_000;
    case "helm-upgrade":
      // Must exceed helm's own --wait, or we kill it mid-flight and leave the
      // release in a state helm never got to finish reconciling.
      return 25 * 60_000;
    default:
      return 5 * 60_000;
  }
}

export async function execute(opts: ExecuteOptions): Promise<ExecuteResult> {
  const { cfg, plan, journal, apply, log } = opts;
  const outcomes: StepOutcome[] = [];

  journal.write({
    t: "run-start",
    at: now(),
    context: plan.context,
    steps: plan.steps.length,
    mode: apply ? "apply" : "dry-run",
  });

  let status: ExecuteResult["status"] = "completed";

  try {
    for (const [index, step] of plan.steps.entries()) {
      const position = `[${index + 1}/${plan.steps.length}]`;
      log(`\n${position} ${step.title}`);
      log(`      ${step.effect}`);
      log(`      downtime: ${step.downtime}`);
      log(`      $ ${step.argv.join(" ")}`);

      journal.write({
        t: "step-start",
        at: now(),
        stepId: step.id,
        title: step.title,
        argv: step.argv,
      });

      const outcome: StepOutcome = {
        stepId: step.id,
        status: "pending",
        startedAt: now(),
      };

      // --- preflight -------------------------------------------------------
      let preflightLines: string[] = [];
      if (step.preflight.length > 0) {
        log("      preflight:");
        const pre = await runPreflight(cfg, step.preflight);
        preflightLines = pre.lines;
        for (const line of pre.lines) log(`        ${line}`);
        journal.write({
          t: "preflight",
          at: now(),
          stepId: step.id,
          ok: pre.ok,
          lines: pre.lines,
        });

        if (!pre.ok) {
          outcome.status = "failed";
          outcome.error = `preflight failed: ${pre.failures.join("; ")}`;
          outcome.finishedAt = now();
          outcomes.push(outcome);
          journal.write({
            t: "step-end",
            at: now(),
            stepId: step.id,
            status: "failed",
            error: outcome.error,
          });
          log(`      ABORT: ${outcome.error}`);
          status = "failed";
          break;
        }
      }

      // --- dry run ---------------------------------------------------------
      if (!apply) {
        outcome.status = "skipped";
        outcome.finishedAt = now();
        outcomes.push(outcome);
        journal.write({
          t: "step-end",
          at: now(),
          stepId: step.id,
          status: "skipped",
        });
        log("      dry run: not executed");
        continue;
      }

      // --- confirm ---------------------------------------------------------
      if (!opts.assumeYes) {
        const approved = await opts.confirm(step, preflightLines);
        if (!approved) {
          outcome.status = "aborted";
          outcome.finishedAt = now();
          outcomes.push(outcome);
          journal.write({
            t: "step-end",
            at: now(),
            stepId: step.id,
            status: "aborted",
          });
          log("      stopped at your request");
          status = "aborted";
          break;
        }
      }

      // --- execute ---------------------------------------------------------
      outcome.status = "running";
      let output = "";
      let failure: string | undefined;

      try {
        // A `verify` step only reads, so it goes through the read-only gate. The
        // mutation gate would refuse it, which is correct of the gate and wrong
        // of the caller: routing every step through it once turned a healthy
        // finish into a crash after the upgrade had already succeeded.
        const mutating = step.kind !== "verify";
        const res = await run(step.argv, {
          mutating,
          timeoutMs: timeoutFor(step),
          onOutput: (chunk) => {
            output += chunk;
            process.stderr.write(chunk);
          },
        });

        journal.write({
          t: "command",
          at: now(),
          stepId: step.id,
          argv: step.argv,
          code: res.code,
          durationMs: res.durationMs,
        });

        if (!res.ok)
          failure = `command exited ${res.code}: ${res.stderr.trim().slice(0, 500)}`;
      } catch (err) {
        // A gate refusal or a spawn error arrives as a throw. Treat it as a
        // failed step so the run still journals and diagnoses, rather than
        // killing the process and losing the record of what already ran.
        failure = `could not run the command: ${(err as Error).message}`;
      }

      outcome.output = output.slice(-8000);

      // --- watch -----------------------------------------------------------
      if (!failure && step.watch) {
        log(`      watching: ${step.watch.kind}`);
        const w = await watch(cfg, step.watch, (m) => log(`        ${m}`));
        journal.write({
          t: "watch",
          at: now(),
          stepId: step.id,
          ok: w.ok,
          detail: w.detail,
          elapsedMs: w.elapsedMs,
        });
        log(`        ${w.ok ? "ok" : "FAILED"}: ${w.detail}`);
        if (!w.ok) failure = `rollout did not converge: ${w.detail}`;
      }

      // --- verify ----------------------------------------------------------
      if (!failure) {
        for (const argv of step.verify) {
          try {
            const v = await run(argv, { timeoutMs: 60_000 });
            log(
              `      verify $ ${argv.join(" ")} -> ${v.ok ? "ok" : `exit ${v.code}`}`,
            );
            if (!v.ok)
              failure = `verification command failed: ${argv.join(" ")}`;
          } catch (err) {
            failure = `verification command could not run: ${argv.join(" ")} (${(err as Error).message})`;
          }
        }
      }

      // --- troubleshoot on failure ----------------------------------------
      if (failure) {
        outcome.status = "failed";
        outcome.error = failure;
        log(`      FAILED: ${failure}`);
        log("      gathering diagnostics...");

        const evidence = await gather(cfg, step);
        const diagnosis = await diagnose(cfg, step, failure, evidence);
        outcome.diagnosis = diagnosis;

        journal.write({
          t: "diagnosis",
          at: now(),
          stepId: step.id,
          summary: diagnosis.summary,
          recommendations: diagnosis.recommendations,
        });

        log(`\n      diagnosis: ${diagnosis.summary}`);
        log(`      likely cause: ${diagnosis.likelyCause}`);
        log(
          `      cluster believed stable: ${diagnosis.clusterStable ? "yes" : "no"}`,
        );
        if (diagnosis.recommendations.length > 0) {
          log("      recommended next steps for you:");
          for (const r of diagnosis.recommendations) log(`        - ${r}`);
        }

        outcome.finishedAt = now();
        outcomes.push(outcome);
        journal.write({
          t: "step-end",
          at: now(),
          stepId: step.id,
          status: "failed",
          error: failure,
        });
        status = "failed";
        break;
      }

      outcome.status = "succeeded";
      outcome.finishedAt = now();
      outcomes.push(outcome);
      journal.write({
        t: "step-end",
        at: now(),
        stepId: step.id,
        status: "succeeded",
      });
      log("      done");
    }
  } catch (err) {
    // Nothing above should throw any more, but a run that dies without a
    // run-end record leaves no way to tell what had already executed.
    status = "failed";
    log(`\n      unexpected error: ${(err as Error).message}`);
  } finally {
    journal.write({
      t: "run-end",
      at: now(),
      status,
      completed: outcomes.filter((o) => o.status === "succeeded").length,
      total: plan.steps.length,
    });
  }

  return { outcomes, status };
}
