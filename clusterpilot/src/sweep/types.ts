// Shapes for the sweep: an anomaly hunt across metrics, logs, and object state.
//
// The sweep answers a different question from `status`. Status asks "what is
// installed and what is out of date"; the sweep asks "is anything wrong right
// now, and is anything heading that way". Those need different inputs, so it
// reads time series and logs rather than versions.

import type { Severity } from "../types.ts";

export type AnomalyCategory =
  | "hardware"
  | "storage"
  | "capacity"
  | "workload"
  | "network"
  | "control-plane"
  | "logs";

export interface Anomaly {
  id: string;
  severity: Severity;
  category: AnomalyCategory;
  title: string;
  detail: string;
  /** Exactly what was observed, so a human can re-check it without trusting us. */
  evidence: string[];
  /**
   * Set when this signal is known to fire on a healthy cluster of this shape.
   * The text says why. Expected anomalies are still printed -- suppressing a
   * signal is how a real one gets missed the day it changes -- but they are
   * kept out of the headline counts so the counts stay meaningful.
   */
  expected?: string;
}

/** One thing that can run out, as a fraction used. */
export interface Headroom {
  id: string;
  label: string;
  /** 0..1. Percent used, so every row sorts against every other row. */
  usedFraction: number;
  detail?: string;
  /** Linear projection from recent slope. Absent when it is not filling. */
  daysUntilFull?: number;
}

/** A source the sweep tried to read, and whether it worked. */
export interface SweepSource {
  id: string;
  ok: boolean;
  note?: string;
}

export interface SweepReport {
  collectedAt: string;
  context: string;
  /** Newly interesting first: real anomalies by severity, then expected ones. */
  anomalies: Anomaly[];
  headroom: Headroom[];
  sources: SweepSource[];
  /** The model's correlation pass. Absent with --no-model. */
  triage?: string;
  modelId?: string;
}

/** Prometheus instant-query result, narrowed to what the checks use. */
export interface Sample {
  labels: Record<string, string>;
  value: number;
}
