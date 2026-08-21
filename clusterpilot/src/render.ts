// Two renderers: a compact digest that goes into the model's prompt, and the
// final plan document written to disk.
//
// The digest is deliberately small. A 30B-class local model plans well over a
// tight, well-ordered brief and badly over a raw JSON dump, so the full
// inventory stays on disk and only the decision-relevant facts go in.

import type { Finding, Inventory } from "./types.ts";

function bullet(lines: string[]): string {
  return lines.map((l) => `- ${l}`).join("\n");
}

export function renderDigest(inv: Inventory, findings: Finding[]): string {
  const parts: string[] = [];

  parts.push(`# Cluster: ${inv.kubeContext}`);
  parts.push(`Collected ${inv.collectedAt}`);

  parts.push("\n## Nodes");
  parts.push(
    bullet(
      inv.kubeNodes.map((n) => {
        const talos = inv.talosNodes.find((t) => t.name === n.name);
        const bits = [
          `${n.name} (${n.roles.join("/")})`,
          `Talos ${talos?.version ?? "unknown"}`,
          `Kubernetes ${n.kubeletVersion}`,
          `kernel ${n.kernel}`,
          n.ready ? "Ready" : "**NOT READY**",
        ];
        if (n.pressures.length > 0) bits.push(`pressure: ${n.pressures.join(",")}`);
        return bits.join(", ");
      }),
    ) || "- none found",
  );

  for (const t of inv.talosNodes) {
    const ext = t.extensions.map((e) => `${e.name} ${e.version}`).join(", ") || "none";
    parts.push(`\n### ${t.name} Talos detail`);
    parts.push(
      bullet([
        `system extensions: ${ext}`,
        `Image Factory schematic: ${t.schematic ?? "none (stock installer)"}`,
        `disks: ${t.disks.map((d) => `${d.id} ${d.size}${d.model ? ` ${d.model}` : ""}`).join("; ") || "none"}`,
        `unhealthy services: ${
          t.services.filter((s) => s.health === "unhealthy" || s.state !== "Running").map((s) => s.id).join(", ") ||
          "none"
        }`,
      ]),
    );
  }

  parts.push("\n## Helm releases");
  parts.push(
    bullet(
      inv.helmReleases.map(
        (r) => `${r.name} in ${r.namespace}: chart ${r.chart} ${r.chartVersion}, app ${r.appVersion}, ${r.status}`,
      ),
    ) || "- none",
  );

  parts.push("\n## Workload health");
  parts.push(
    bullet([
      `unhealthy pods: ${
        inv.workloads.unhealthyPods.map((p) => `${p.namespace}/${p.name} ${p.phase} ${p.reason}`).join("; ") || "none"
      }`,
      `unbound PVCs: ${inv.workloads.pendingPvcs.map((p) => `${p.namespace}/${p.name}`).join(", ") || "none"}`,
      `top warning events: ${
        inv.workloads.recentWarnings.slice(0, 5).map((w) => `${w.reason} x${w.count}`).join(", ") || "none"
      }`,
    ]),
  );

  parts.push("\n## Findings (computed, already verified -- do not recompute version math)");
  for (const f of findings) {
    parts.push(`\n### [${f.severity}] ${f.title}`);
    if (f.current || f.latest) parts.push(`current: ${f.current ?? "?"} -> latest: ${f.latest ?? "?"}`);
    parts.push(f.detail);
    if (f.suggested?.length) {
      parts.push("commands:");
      parts.push(f.suggested.map((c) => `    ${c}`).join("\n"));
    }
  }

  return parts.join("\n");
}

/** Wraps the model's plan with the deterministic evidence it was derived from. */
export function renderPlanDocument(
  inv: Inventory,
  findings: Finding[],
  plan: string,
  modelId: string,
): string {
  const counts = {
    critical: findings.filter((f) => f.severity === "critical").length,
    warning: findings.filter((f) => f.severity === "warning").length,
    info: findings.filter((f) => f.severity === "info").length,
  };

  return [
    `# Upgrade plan: ${inv.kubeContext}`,
    "",
    `Generated ${new Date().toISOString()} by clusterpilot, reasoning with \`${modelId}\`.`,
    `Findings: ${counts.critical} critical, ${counts.warning} warning, ${counts.info} info.`,
    "",
    "> Clusterpilot is read-only. Every command below is a suggestion for a human to run and review; nothing here has been applied to the cluster.",
    "",
    "---",
    "",
    plan.trim(),
    "",
    "---",
    "",
    "## Appendix: computed findings",
    "",
    "These come from version comparison in code, not from the model.",
    "",
    ...findings.flatMap((f) => [
      `### [${f.severity}] ${f.title}`,
      "",
      f.current || f.latest ? `\`${f.current ?? "?"}\` → \`${f.latest ?? "?"}\`` : "",
      "",
      f.detail,
      "",
      ...(f.suggested?.length ? ["```bash", ...f.suggested, "```", ""] : []),
    ]),
    "## Appendix: probes",
    "",
    ...inv.probes.map(
      (p) => `- ${p.ok ? "ok " : "FAIL"} \`${p.command.join(" ")}\` (${p.durationMs}ms)${p.error ? ` — ${p.error}` : ""}`,
    ),
    "",
  ].join("\n");
}
