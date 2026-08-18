// Append-only run journal.
//
// Written with a synchronous append per record, on purpose. A run that takes a
// node down can be interrupted by the thing it is operating on -- laptop
// sleeps, VPN drops, someone hits Ctrl-C during a reboot -- and the record of
// what had already executed is exactly what you need afterwards. Buffering it
// would lose the last and most important lines.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type JournalRecord =
  | { t: "run-start"; at: string; context: string; steps: number; mode: "dry-run" | "apply" }
  | { t: "step-start"; at: string; stepId: string; title: string; argv: string[] }
  | { t: "preflight"; at: string; stepId: string; ok: boolean; lines: string[] }
  | { t: "command"; at: string; stepId: string; argv: string[]; code: number | null; durationMs: number }
  | { t: "watch"; at: string; stepId: string; ok: boolean; detail: string; elapsedMs: number }
  | { t: "step-end"; at: string; stepId: string; status: string; error?: string }
  | { t: "diagnosis"; at: string; stepId: string; summary: string; recommendations: string[] }
  | { t: "run-end"; at: string; status: string; completed: number; total: number };

export class Journal {
  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  write(record: JournalRecord): void {
    appendFileSync(this.path, `${JSON.stringify(record)}\n`, "utf8");
  }
}

export const now = () => new Date().toISOString();
