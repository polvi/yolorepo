// Resolves which values file each Helm upgrade should apply.
//
// Order of preference:
//
//   1. An authored file from config.helmValues. That file is a human input and
//      the source of the release's settings, so it wins.
//   2. The values currently supplied to the release, captured from
//      `helm get values` and written to the plans directory.
//
// Case 2 is not the same as `--reuse-values`. Replaying only the explicit
// overrides onto the new chart lets the chart's new defaults through, which is
// what "I want the latest" actually means. `--reuse-values` would layer the old
// values over the new chart and hide them.
//
// A release with neither gets no upgrade step at all: a bare `helm upgrade`
// resets a release to chart defaults, and silently discarding an operator's
// settings is worse than skipping the upgrade.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { releaseKey } from "./plan.ts";
import type { Inventory } from "./types.ts";

export interface ResolvedValues {
  /** "namespace/release" -> path of the values file to apply. */
  paths: Record<string, string>;
  /** Human-readable note per release, for the plan output. */
  notes: string[];
  /** Releases we refuse to upgrade because we have no values to apply. */
  skipped: string[];
}

export async function materializeValues(cfg: Config, inv: Inventory): Promise<ResolvedValues> {
  const paths: Record<string, string> = {};
  const notes: string[] = [];
  const skipped: string[] = [];
  const dir = join(cfg.plansDir, "values");
  let madeDir = false;

  for (const rel of inv.helmReleases) {
    const key = releaseKey(rel.namespace, rel.name);
    const authored = cfg.helmValues[key] ?? cfg.helmValues[rel.name];

    if (authored) {
      paths[key] = authored;
      notes.push(`${key}: applying authored ${authored}`);
      continue;
    }

    if (rel.userValues === undefined) {
      skipped.push(`${key}: could not read its current values`);
      continue;
    }

    if (rel.userValues === "") {
      // Installed with no overrides, so chart defaults are already correct and
      // an empty file is a faithful, non-destructive thing to apply.
      notes.push(`${key}: no overrides set; upgrading on chart defaults`);
    } else {
      notes.push(`${key}: replaying its current values (no authored file configured)`);
    }

    if (!madeDir) {
      await mkdir(dir, { recursive: true });
      madeDir = true;
    }
    const path = join(dir, `${rel.namespace}-${rel.name}.yaml`);
    await writeFile(path, rel.userValues === "" ? "{}\n" : `${rel.userValues}\n`);
    paths[key] = path;
  }

  return { paths, notes, skipped };
}
