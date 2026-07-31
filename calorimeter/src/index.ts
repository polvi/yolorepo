#!/usr/bin/env bun
// calorimeter: measure the energy cost of local LLM inference on Apple Silicon
// and report it in food calories (kcal) per 1M tokens, the same denominator
// providers use for pricing.
//
// Usage:
//   bun src/index.ts run <model...> [--tokens N] [--interval MS] [--baseline S] [--json FILE]
//
// Requires: `sudo -v` beforehand (powermetrics needs root), Ollama running.

import { PowerSampler } from "./powermetrics";
import { generate, listModels, pull, unload } from "./ollama";

const KCAL_PER_JOULE = 1 / 4184;
const APPLE_KCAL = 95; // one medium apple
const BRAIN_WATTS = 20; // resting human brain

const PROMPT =
  "Write a very long, detailed, meandering essay on the history of computing, " +
  "from the abacus to the present day. Include as much detail as possible.";

interface RunResult {
  model: string;
  outputTokens: number;
  promptTokens: number;
  tokensPerSec: number;
  wallSec: number;
  avgWatts: number; // above baseline
  joules: number; // above baseline
  kcalPer1MTokens: number;
  samples: number;
}

function parseArgs(argv: string[]) {
  const args = { models: [] as string[], tokens: 256, interval: 200, baseline: 8, json: "" };
  let i = 0;
  if (argv[i] === "run") i++;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--tokens") args.tokens = parseInt(argv[++i], 10);
    else if (a === "--interval") args.interval = parseInt(argv[++i], 10);
    else if (a === "--baseline") args.baseline = parseFloat(argv[++i]);
    else if (a === "--json") args.json = argv[++i];
    else if (a.startsWith("--")) throw new Error(`unknown flag ${a}`);
    else args.models.push(a);
  }
  if (args.models.length === 0) {
    console.error(
      "usage: calorimeter run <model...> [--tokens N] [--interval MS] [--baseline S] [--json FILE]",
    );
    process.exit(1);
  }
  return args;
}

function fmt(n: number, digits = 1): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: digits });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const installed = await listModels();
  for (const m of args.models) {
    if (!installed.some((name) => name === m || name.startsWith(`${m}:`))) {
      console.log(`pulling ${m}...`);
      await pull(m);
    }
  }

  const sampler = new PowerSampler(args.interval);
  await sampler.start();

  console.log(`measuring idle baseline (${args.baseline}s)...`);
  const b0 = Date.now();
  await Bun.sleep(args.baseline * 1000);
  const baselineMw = sampler.averageMw(b0, Date.now());
  console.log(`baseline: ${fmt(baselineMw / 1000, 2)} W\n`);

  const results: RunResult[] = [];
  for (const model of args.models) {
    console.log(`[${model}] warmup (loads model)...`);
    await generate(model, "hi", 8);
    await Bun.sleep(2000); // let power settle back toward idle

    console.log(`[${model}] generating ${args.tokens} tokens...`);
    const t0 = Date.now();
    const stats = await generate(model, PROMPT, args.tokens);
    const t1 = Date.now();

    // TLC-checked bound (specs/Calorimeter.tla): a window shorter than
    // 2×interval can contain <2 samples, making integration silently yield 0.
    const windowSamples = sampler.sampleCountIn(t0, t1);
    if (windowSamples < 2) {
      console.warn(
        `[${model}] UNMEASURABLE: only ${windowSamples} power sample(s) in a ` +
          `${t1 - t0}ms window. Increase --tokens or lower --interval ` +
          `(window must exceed 2x interval). Skipping.\n`,
      );
      await unload(model);
      continue;
    }
    const joules = sampler.energyJoules(t0, t1, baselineMw);
    const wallSec = (t1 - t0) / 1000;
    const avgWatts = joules / wallSec;
    const kcalPerTok = (joules / stats.eval_count) * KCAL_PER_JOULE;
    const r: RunResult = {
      model,
      outputTokens: stats.eval_count,
      promptTokens: stats.prompt_eval_count,
      tokensPerSec: stats.eval_count / (stats.eval_duration / 1e9),
      wallSec,
      avgWatts,
      joules,
      kcalPer1MTokens: kcalPerTok * 1e6,
      samples: sampler.sampleCountIn(t0, t1),
    };
    results.push(r);
    console.log(
      `[${model}] ${r.outputTokens} tok in ${fmt(wallSec)}s, ` +
        `${fmt(r.tokensPerSec)} tok/s, ${fmt(avgWatts)} W above baseline, ${fmt(joules)} J\n`,
    );
    await unload(model);
    await Bun.sleep(1500);
  }
  sampler.stop();

  // Report
  const rows = results.map((r) => ({
    model: r.model,
    "tok/s": fmt(r.tokensPerSec),
    watts: fmt(r.avgWatts),
    "kcal/1M tok": fmt(r.kcalPer1MTokens, 2),
    "tok per apple": fmt((APPLE_KCAL / r.kcalPer1MTokens) * 1e6, 0),
    "samples": String(r.samples),
  }));
  console.log("results (energy above idle baseline, SoC power only):\n");
  console.table(rows);

  for (const r of results) {
    const brainSec = r.joules / BRAIN_WATTS;
    console.log(
      `${r.model}: 1M tokens ≈ ${fmt(r.kcalPer1MTokens, 2)} kcal. ` +
        `This run used the same energy as ${fmt(brainSec)}s of a human brain.`,
    );
  }

  if (args.json) {
    await Bun.write(args.json, JSON.stringify({ baselineMw, results }, null, 2));
    console.log(`\nwrote ${args.json}`);
  }
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
