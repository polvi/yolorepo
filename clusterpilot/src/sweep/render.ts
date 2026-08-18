// Rendering the sweep, for a terminal and for the model.
//
// The two audiences want different things, so there are two renderers. The
// terminal wants the headline first and the reasoning available underneath.
// The model wants dense, unambiguous facts with the expected-noise already
// marked, so it spends its attention correlating rather than re-deriving what
// the rules already decided.

import type { Anomaly, Headroom, SweepReport } from "./types.ts";
import { realAnomalies } from "./index.ts";

const pct = (f: number) => `${(f * 100).toFixed(1)}%`;

const MARK: Record<string, string> = {
  critical: "CRIT",
  warning: "WARN",
  info: "info",
};

/** A fixed-width bar, so the headroom table scans as a shape rather than numbers. */
function bar(fraction: number, width = 24): string {
  const filled = Math.max(0, Math.min(width, Math.round(fraction * width)));
  return `${"#".repeat(filled)}${"-".repeat(width - filled)}`;
}

/**
 * Longest label before truncation. Generated PVC names run to 90 characters
 * ("prometheus-kube-prometheus-kube-prome-prometheus-db-prometheus-..."), and
 * one of them padding the whole column pushes every bar off the right of the
 * terminal. Truncating from the left keeps the distinguishing tail.
 */
const MAX_LABEL = 44;

function truncate(label: string): string {
  return label.length <= MAX_LABEL ? label : `...${label.slice(-(MAX_LABEL - 3))}`;
}

function headroomTable(rows: Headroom[]): string {
  if (rows.length === 0) return "  (no capacity metrics available)";

  const width = Math.max(...rows.map((r) => truncate(r.label).length));
  return rows
    .map((r) => {
      const trend =
        r.daysUntilFull === undefined
          ? ""
          : r.daysUntilFull < 365
            ? `  full in ~${r.daysUntilFull.toFixed(0)}d`
            : "";
      const detail = r.detail ? `  (${r.detail})` : "";
      return `  ${truncate(r.label).padEnd(width)}  ${bar(r.usedFraction)} ${pct(r.usedFraction).padStart(6)}${trend}${detail}`;
    })
    .join("\n");
}

function renderAnomaly(a: Anomaly, verbose: boolean): string {
  const lines = [`  [${MARK[a.severity]}] ${a.title}`];
  lines.push(`         ${a.detail}`);
  if (a.expected) lines.push(`         expected: ${a.expected}`);
  if (verbose) for (const e of a.evidence) lines.push(`         | ${e}`);
  return lines.join("\n");
}

export function renderSweep(report: SweepReport, verbose = false): string {
  const real = realAnomalies(report.anomalies);
  const expected = report.anomalies.filter((a) => a.expected);
  const informational = report.anomalies.filter((a) => !a.expected && a.severity === "info");

  const critical = real.filter((a) => a.severity === "critical").length;
  const warning = real.filter((a) => a.severity === "warning").length;

  const parts: string[] = [];

  parts.push(`Sweep of ${report.context} at ${report.collectedAt}`);
  parts.push(
    critical === 0 && warning === 0
      ? "Nothing abnormal found."
      : `${critical} critical, ${warning} warning.`,
  );

  parts.push("\n## Closest to full");
  parts.push(headroomTable(report.headroom));

  if (real.length > 0) {
    parts.push("\n## Anomalies");
    parts.push(real.map((a) => renderAnomaly(a, verbose)).join("\n\n"));
  }

  if (informational.length > 0) {
    parts.push("\n## Noted");
    parts.push(informational.map((a) => renderAnomaly(a, verbose)).join("\n\n"));
  }

  if (expected.length > 0) {
    // Shown, not hidden. These are the signals that fire forever on a healthy
    // cluster of this shape; the reason each one is expected travels with it,
    // so the day one of them stops being expected the note is already there.
    parts.push(`\n## Expected on this cluster (${expected.length}, excluded from the counts)`);
    parts.push(expected.map((a) => renderAnomaly(a, verbose)).join("\n\n"));
  }

  parts.push("\n## Sources");
  for (const s of report.sources) {
    parts.push(`  ${s.ok ? "ok  " : "FAIL"} ${s.id}${s.note ? ` — ${s.note}` : ""}`);
  }

  if (report.triage) {
    parts.push(`\n## Triage (${report.modelId ?? "model"})`);
    parts.push(report.triage.trim());
  }

  return parts.join("\n");
}

/** The dense form handed to the model. Evidence included; presentation stripped. */
export function renderSweepForModel(report: SweepReport): string {
  const parts: string[] = [`# Sweep of ${report.context} at ${report.collectedAt}`];

  parts.push("\n## Capacity (percent used, highest first)");
  for (const r of report.headroom) {
    const trend =
      r.daysUntilFull !== undefined && r.daysUntilFull < 365
        ? `, projected full in ${r.daysUntilFull.toFixed(0)} days`
        : "";
    parts.push(`- ${r.label}: ${pct(r.usedFraction)}${trend}${r.detail ? ` (${r.detail})` : ""}`);
  }

  const real = realAnomalies(report.anomalies);
  parts.push(`\n## Anomalies found by the rules (${real.length})`);
  if (real.length === 0) parts.push("- none");
  for (const a of real) {
    parts.push(`\n### [${a.severity}] ${a.title}`);
    parts.push(a.detail);
    for (const e of a.evidence) parts.push(`    ${e}`);
  }

  const expected = report.anomalies.filter((a) => a.expected);
  if (expected.length > 0) {
    parts.push(`\n## Already classified as expected (${expected.length}) — do not re-report these as problems`);
    for (const a of expected) parts.push(`- ${a.title} — ${a.expected}`);
  }

  parts.push("\n## Sources");
  for (const s of report.sources) {
    parts.push(`- ${s.id}: ${s.ok ? "ok" : "FAILED"}${s.note ? ` (${s.note})` : ""}`);
  }

  return parts.join("\n");
}
