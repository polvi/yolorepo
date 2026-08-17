#!/usr/bin/env bun
// Run the same task suite against each local model and score it.
//
// Every task is verified by inspecting the filesystem or the final text, so a
// pass means the model actually did the work rather than described it. Speed
// comes from pi's own usage accounting plus wall clock.
//
//   bun bench/eval.ts                    # every model in MODELS
//   bun bench/eval.ts qwen3-coder-next   # just these aliases
//   bun bench/eval.ts --keep             # leave workspaces on disk

import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const PI = join(process.env.HOME!, ".bun/bin/pi");
const UP = join(import.meta.dir, "..", "bin", "pi-llama-up");
const DOWN = join(import.meta.dir, "..", "bin", "pi-llama-down");

type Model = {
  alias: string;
  repo: string;
  quant: string;
  /** MoE models are non-reasoning or reasoning; drives the --thinking flag. */
  thinking: "off" | "medium";
};

const MODELS: Model[] = [
  {
    alias: "qwen3.8-27b",
    repo: "unsloth/Qwen3.8-27B-GGUF",
    quant: "UD-Q6_K_XL",
    thinking: "medium",
  },
  {
    alias: "qwen3.6-35b-a3b",
    repo: "unsloth/Qwen3.6-35B-A3B-GGUF",
    quant: "UD-Q4_K_XL",
    thinking: "medium",
  },
  // Qwen3-Coder-Next 80B-A3B was measured and rejected (see MODELS.md): bigger,
  // slower, and the only model to fail async-concurrency. Its weights have been
  // deleted. To re-measure it, fetch the GGUF and put this entry back:
  //
  //   pi-llama-fetch unsloth/Qwen3-Coder-Next-GGUF Qwen3-Coder-Next-UD-IQ4_XS.gguf
  //   { alias: "qwen3-coder-next", repo: "unsloth/Qwen3-Coder-Next-GGUF",
  //     quant: "UD-IQ4_XS", thinking: "off" }
  //
  // It also needs a matching entry in config/models.json with reasoning: false.
];

type Task = {
  name: string;
  /** Lay down fixtures; return the prompt to send. */
  setup: (dir: string) => string;
  /** Extra argv (e.g. @file) appended before the prompt. */
  argv?: (dir: string) => string[];
  verify: (dir: string, finalText: string) => boolean;
  /** Rough token count of the prompt, for reporting prefill cost. */
  note?: string;
};

const FILLER_LINE =
  "The build system compiles each module in isolation and caches the result by content hash.";

const TASKS: Task[] = [
  {
    name: "tool-chain",
    note: "multi-step: read, compute, write",
    setup: (dir) => {
      const lines = Array.from({ length: 137 }, (_, i) => `line ${i + 1}`);
      writeFileSync(join(dir, "input.txt"), lines.join("\n") + "\n");
      return (
        "Read the file input.txt in the current directory, count how many lines it has, " +
        "and write that number (digits only, nothing else) to a file named answer.txt " +
        "in the current directory."
      );
    },
    verify: (dir) => {
      const p = join(dir, "answer.txt");
      if (!existsSync(p)) return false;
      return readFileSync(p, "utf8").trim() === "137";
    },
  },
  {
    name: "code-repair",
    note: "fix a failing test until bun test passes",
    setup: (dir) => {
      writeFileSync(
        join(dir, "slug.ts"),
        `export function slugify(s: string): string {\n` +
          `  return s.toLowerCase().replace(/ /g, "-");\n` +
          `}\n`,
      );
      writeFileSync(
        join(dir, "slug.test.ts"),
        `import { test, expect } from "bun:test";\n` +
          `import { slugify } from "./slug";\n\n` +
          `test("basic", () => { expect(slugify("Hello World")).toBe("hello-world"); });\n` +
          `test("punctuation", () => { expect(slugify("Hello, World!")).toBe("hello-world"); });\n` +
          `test("collapses", () => { expect(slugify("a   b")).toBe("a-b"); });\n` +
          `test("trims", () => { expect(slugify("  pad  ")).toBe("pad"); });\n`,
      );
      return (
        "The test suite in this directory fails. Run `bun test` to see the failures, " +
        "then edit slug.ts (do not edit slug.test.ts) until every test passes. " +
        "Verify by running `bun test` again before you finish."
      );
    },
    verify: (dir) => {
      const r = Bun.spawnSync(["bun", "test"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
      const out = new TextDecoder().decode(r.stderr) + new TextDecoder().decode(r.stdout);
      // the test file must be untouched, and all four tests must pass
      const testSrc = readFileSync(join(dir, "slug.test.ts"), "utf8");
      if (!testSrc.includes('expect(slugify("  pad  ")).toBe("pad")')) return false;
      return /4 pass/.test(out) && /0 fail/.test(out);
    },
  },
  {
    name: "long-context",
    note: "~16K token prompt, needle retrieval",
    setup: (dir) => {
      const lines: string[] = [];
      for (let i = 0; i < 1400; i++) {
        lines.push(`${i}: ${FILLER_LINE}`);
        if (i === 700) lines.push("700b: The deploy passphrase is ORCHID-SEVENTEEN-BASALT.");
      }
      writeFileSync(join(dir, "haystack.txt"), lines.join("\n") + "\n");
      return (
        "The attached file contains one line stating a deploy passphrase. " +
        "Reply with the passphrase only, in capitals, and nothing else."
      );
    },
    argv: (dir) => [`@${join(dir, "haystack.txt")}`],
    verify: (_dir, text) => text.toUpperCase().includes("ORCHID-SEVENTEEN-BASALT"),
  },
  {
    name: "hidden-tests",
    note: "write code judged by a suite the model never sees",
    setup: (dir) => {
      writeFileSync(join(dir, "NOTES.md"), "Intervals are inclusive on both ends.\n");
      return (
        "Create a file named interval.ts in the current directory that exports:\n" +
        "  export function mergeIntervals(input: [number, number][]): [number, number][]\n" +
        "It merges overlapping intervals AND intervals that merely touch (for example " +
        "[1,2] and [2,3] become [1,3]). Input may be unsorted and may contain negative " +
        "numbers, intervals fully contained in others, and duplicates. Return the merged " +
        "intervals sorted ascending by start. Empty input returns an empty array. " +
        "Write only the file; do not create tests."
      );
    },
    verify: (dir) => {
      if (!existsSync(join(dir, "interval.ts"))) return false;
      // A suite the model never saw, so it cannot be gamed by editing tests.
      writeFileSync(
        join(dir, "hidden.test.ts"),
        `import { test, expect } from "bun:test";\n` +
          `import { mergeIntervals as m } from "./interval";\n` +
          `test("empty", () => expect(m([])).toEqual([]));\n` +
          `test("touching", () => expect(m([[1,2],[2,3]])).toEqual([[1,3]]));\n` +
          `test("unsorted", () => expect(m([[5,6],[1,3]])).toEqual([[1,3],[5,6]]));\n` +
          `test("contained", () => expect(m([[1,10],[2,3]])).toEqual([[1,10]]));\n` +
          `test("disjoint", () => expect(m([[1,2],[4,5]])).toEqual([[1,2],[4,5]]));\n` +
          `test("negative", () => expect(m([[-5,-3],[-4,0]])).toEqual([[-5,0]]));\n` +
          `test("dupes", () => expect(m([[1,2],[1,2]])).toEqual([[1,2]]));\n`,
      );
      const r = Bun.spawnSync(["bun", "test", "hidden.test.ts"], {
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = new TextDecoder().decode(r.stderr) + new TextDecoder().decode(r.stdout);
      return /7 pass/.test(out) && /0 fail/.test(out);
    },
  },
  {
    name: "async-concurrency",
    note: "hard: correct concurrency limiting, hidden suite",
    setup: (dir) => {
      return (
        "Create a file named pool.ts in the current directory that exports:\n" +
        "  export async function runWithConcurrency<T>(\n" +
        "    tasks: (() => Promise<T>)[], limit: number\n" +
        "  ): Promise<T[]>\n" +
        "Requirements:\n" +
        "- runs the tasks with at most `limit` of them in flight at any moment\n" +
        "- starts a new task as soon as any running task settles, not in fixed batches\n" +
        "- resolves to the results in the ORIGINAL task order, not completion order\n" +
        "- an empty task list resolves to []\n" +
        "- a limit larger than the task count is fine\n" +
        "Write only the file; do not create tests."
      );
    },
    verify: (dir) => {
      if (!existsSync(join(dir, "pool.ts"))) return false;
      writeFileSync(
        join(dir, "hidden.test.ts"),
        `import { test, expect } from "bun:test";\n` +
          `import { runWithConcurrency as run } from "./pool";\n` +
          `function mk(n: number, limitBox: { cur: number; max: number }) {\n` +
          `  return Array.from({ length: n }, (_, i) => async () => {\n` +
          `    limitBox.cur++; limitBox.max = Math.max(limitBox.max, limitBox.cur);\n` +
          `    await new Promise((r) => setTimeout(r, (n - i) * 4));\n` +
          `    limitBox.cur--; return i;\n` +
          `  });\n` +
          `}\n` +
          `test("empty", async () => expect(await run([], 3)).toEqual([]));\n` +
          `test("order", async () => {\n` +
          `  const b = { cur: 0, max: 0 };\n` +
          `  expect(await run(mk(8, b), 3)).toEqual([0,1,2,3,4,5,6,7]);\n` +
          `});\n` +
          `test("respects limit", async () => {\n` +
          `  const b = { cur: 0, max: 0 };\n` +
          `  await run(mk(9, b), 2); expect(b.max).toBeLessThanOrEqual(2);\n` +
          `});\n` +
          `test("saturates limit", async () => {\n` +
          `  const b = { cur: 0, max: 0 };\n` +
          `  await run(mk(9, b), 3); expect(b.max).toBe(3);\n` +
          `});\n` +
          `test("limit exceeds count", async () => {\n` +
          `  const b = { cur: 0, max: 0 };\n` +
          `  expect(await run(mk(2, b), 50)).toEqual([0,1]);\n` +
          `});\n` +
          // Deterministic batching check: with controlled promises, a fixed-batch
          // implementation cannot start task 2 until BOTH 0 and 1 have settled.
          `test("starts next as soon as one settles", async () => {\n` +
          `  const started: number[] = [];\n` +
          `  const res: ((v: number) => void)[] = [];\n` +
          `  const tasks = Array.from({ length: 4 }, (_, i) => () =>\n` +
          `    new Promise<number>((r) => { started.push(i); res[i] = r; }));\n` +
          `  const p = run(tasks, 2);\n` +
          `  const tick = () => new Promise((r) => setTimeout(r, 25));\n` +
          `  await tick();\n` +
          `  expect(started).toEqual([0, 1]);\n` +
          `  res[0](0);\n` +
          `  await tick();\n` +
          `  expect(started).toEqual([0, 1, 2]);\n` +
          `  res[1](1); await tick(); res[2](2); await tick(); res[3](3);\n` +
          `  expect(await p).toEqual([0, 1, 2, 3]);\n` +
          `});\n`,
      );
      const r = Bun.spawnSync(["bun", "test", "hidden.test.ts"], {
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = new TextDecoder().decode(r.stderr) + new TextDecoder().decode(r.stdout);
      return /6 pass/.test(out) && /0 fail/.test(out);
    },
  },
  {
    name: "instruction",
    note: "exact-format adherence",
    setup: () =>
      "Output exactly three lines, each a single lowercase word, in this order: alpha, beta, gamma. " +
      "No punctuation, no numbering, no preamble, no code fences, no explanation.",
    verify: (_dir, text) => {
      const lines = text.trim().split("\n").map((l) => l.trim()).filter(Boolean);
      return lines.length === 3 && lines[0] === "alpha" && lines[1] === "beta" && lines[2] === "gamma";
    },
  },
];

type Result = {
  model: string;
  task: string;
  pass: boolean;
  seconds: number;
  input: number;
  output: number;
  cacheRead: number;
  genTps: number | null;
  error?: string;
};

function runPi(model: Model, task: Task, dir: string, prompt: string) {
  const argv = [
    "-p",
    "--mode",
    "json",
    "--provider",
    "llama-cpp",
    "--model",
    model.alias,
    "--no-session",
    "--no-context-files",
    "--thinking",
    model.thinking,
    ...(task.argv ? task.argv(dir) : []),
    prompt,
  ];

  const started = Date.now();
  const proc = Bun.spawnSync([PI, ...argv], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
  const seconds = (Date.now() - started) / 1000;
  const stdout = new TextDecoder().decode(proc.stdout);

  let usage = { input: 0, output: 0, cacheRead: 0 };
  let finalText = "";
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.usage) {
      usage = {
        input: ev.usage.input ?? 0,
        output: ev.usage.output ?? 0,
        cacheRead: ev.usage.cacheRead ?? 0,
      };
    }
    if (ev.type === "agent_end" && Array.isArray(ev.messages)) {
      for (let i = ev.messages.length - 1; i >= 0; i--) {
        const m = ev.messages[i];
        if (m.role !== "assistant") continue;
        const text = (m.content ?? [])
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text)
          .join("");
        if (text) {
          finalText = text;
          break;
        }
      }
    }
  }

  return { seconds, usage, finalText, stderr: new TextDecoder().decode(proc.stderr) };
}

function sh(cmd: string[], env: Record<string, string> = {}) {
  return Bun.spawnSync(cmd, {
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, ...env },
  });
}

const args = process.argv.slice(2);
const keep = args.includes("--keep");
const onlyTask = args.find((a) => a.startsWith("--task="))?.slice("--task=".length);
const wanted = args.filter((a) => !a.startsWith("--"));
const models = wanted.length ? MODELS.filter((m) => wanted.includes(m.alias)) : MODELS;
const tasks = onlyTask ? TASKS.filter((t) => t.name === onlyTask) : TASKS;

if (!models.length) {
  console.error(`no matching models. known: ${MODELS.map((m) => m.alias).join(", ")}`);
  process.exit(2);
}

const results: Result[] = [];

for (const model of models) {
  console.log(`\n=== ${model.alias} (${model.quant}) ===`);
  sh([DOWN]);
  const up = sh([UP], {
    PI_LLAMA_REPO: model.repo,
    PI_LLAMA_QUANT: model.quant,
    PI_LLAMA_ALIAS: model.alias,
  });
  if (up.exitCode !== 0) {
    console.error(`  server failed to start, skipping ${model.alias}`);
    continue;
  }

  for (const task of tasks) {
    const dir = join(tmpdir(), `pi-eval-${model.alias}-${task.name}`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });

    const prompt = task.setup(dir);
    let r: Result;
    try {
      const { seconds, usage, finalText } = runPi(model, task, dir, prompt);
      const pass = task.verify(dir, finalText);
      r = {
        model: model.alias,
        task: task.name,
        pass,
        seconds,
        input: usage.input,
        output: usage.output,
        cacheRead: usage.cacheRead,
        genTps: seconds > 0 ? usage.output / seconds : null,
      };
    } catch (e) {
      r = {
        model: model.alias,
        task: task.name,
        pass: false,
        seconds: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        genTps: null,
        error: String(e),
      };
    }
    results.push(r);
    console.log(
      `  ${r.pass ? "PASS" : "FAIL"}  ${task.name.padEnd(14)} ${r.seconds.toFixed(1)}s  ` +
        `in=${r.input} out=${r.output} cached=${r.cacheRead}`,
    );
    if (!keep) rmSync(dir, { recursive: true, force: true });
  }
}

sh([DOWN]);

console.log("\n\n| model | task | result | wall | prompt tok | out tok |");
console.log("|---|---|---|---|---|---|");
for (const r of results) {
  console.log(
    `| ${r.model} | ${r.task} | ${r.pass ? "pass" : "fail"} | ${r.seconds.toFixed(1)}s | ${r.input} | ${r.output} |`,
  );
}

console.log("\n| model | passed | total wall |");
console.log("|---|---|---|");
for (const model of models) {
  const rs = results.filter((r) => r.model === model.alias);
  if (!rs.length) continue;
  const passed = rs.filter((r) => r.pass).length;
  const wall = rs.reduce((a, r) => a + r.seconds, 0);
  console.log(`| ${model.alias} | ${passed}/${rs.length} | ${wall.toFixed(1)}s |`);
}

// Merge with any previous run so evaluating one model does not discard the rest.
const resultsPath = join(import.meta.dir, "results.json");
let previous: Result[] = [];
if (existsSync(resultsPath)) {
  try {
    previous = JSON.parse(readFileSync(resultsPath, "utf8")).results ?? [];
  } catch {
    previous = [];
  }
}
const touched = new Set(results.map((r) => `${r.model}/${r.task}`));
const merged = previous.filter((r) => !touched.has(`${r.model}/${r.task}`)).concat(results);
writeFileSync(resultsPath, JSON.stringify({ results: merged }, null, 2) + "\n");
console.log(`\nwrote bench/results.json (${merged.length} rows)`);
