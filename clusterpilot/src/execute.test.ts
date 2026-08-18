import { describe, expect, test } from "bun:test";
import { assertMutation, assertReadOnly, MutationNotPlannedError, run } from "./exec.ts";
import { buildPlan } from "./plan.ts";
import type { Config } from "./config.ts";
import type { Inventory, UpstreamVersions } from "./types.ts";

const cfg: Config = {
  kubeContext: "test-ctx",
  talosNodes: ["node-a"],
  bin: { talosctl: "talosctl", kubectl: "kubectl", helm: "helm" },
  releases: { talos: "siderolabs/talos", kubernetes: "kubernetes/kubernetes" },
  helmRepos: { gitea: "https://dl.gitea.com/charts/" },
  helmValues: {},
  llamaBaseUrl: "http://127.0.0.1:8080/v1",
  plansDir: "plans",
  timeoutMs: 5000,
};

const inventory: Inventory = {
  collectedAt: "2026-08-18T00:00:00.000Z",
  kubeContext: "test-ctx",
  talosNodes: [
    {
      name: "node-a",
      version: "1.13.8",
      schematic: "abc123",
      extensions: [{ name: "zfs", version: "2.4.3" }],
      disks: [],
      services: [],
    },
  ],
  kubeNodes: [
    {
      name: "node-a",
      kubeletVersion: "1.36.3",
      roles: ["control-plane"],
      ready: true,
      osImage: "Talos (v1.13.8)",
      kernel: "6.18.42-talos",
      containerRuntime: "containerd://2.2.6",
      pressures: [],
    },
  ],
  helmReleases: [
    {
      name: "gitea",
      namespace: "default",
      chart: "gitea",
      chartVersion: "12.7.0",
      appVersion: "1.27.0",
      status: "deployed",
    },
  ],
  workloads: { unhealthyPods: [], pendingPvcs: [], recentWarnings: [] },
  probes: [],
};

const upstream: UpstreamVersions = {
  talos: ["1.14.1", "1.14.0", "1.13.9", "1.13.8"],
  kubernetes: ["1.37.1", "1.36.3"],
  charts: { gitea: ["12.8.0", "12.7.0"] },
  errors: [],
};

describe("mutation gate", () => {
  test("permits exactly the upgrade operations clusterpilot drives", () => {
    for (const argv of [
      ["talosctl", "-n", "node-a", "upgrade", "--image", "factory.talos.dev/installer/abc:v1.13.9"],
      ["talosctl", "-n", "node-a", "upgrade-k8s", "--to", "1.37.1"],
      ["talosctl", "-n", "node-a", "etcd", "snapshot", "backup.db"],
      ["helm", "-n", "default", "upgrade", "gitea", "gitea", "--version", "12.8.0"],
      ["kubectl", "rollout", "status", "deploy/x"],
    ]) {
      expect(() => assertMutation(argv)).not.toThrow();
    }
  });

  test("refuses destructive operations even through the mutation gate", () => {
    for (const argv of [
      ["talosctl", "-n", "node-a", "reset"],
      ["talosctl", "-n", "node-a", "wipe", "sda"],
      ["talosctl", "-n", "node-a", "apply-config", "-f", "c.yaml"],
      ["kubectl", "delete", "node", "node-a"],
      ["helm", "uninstall", "gitea"],
      ["talosctl", "-n", "node-a", "shutdown"],
    ]) {
      expect(() => assertMutation(argv)).toThrow(MutationNotPlannedError);
    }
  });

  test("narrows talosctl etcd to snapshot only", () => {
    expect(() => assertMutation(["talosctl", "etcd", "snapshot", "b.db"])).not.toThrow();
    // `etcd remove-member` would be a quorum-destroying operation.
    expect(() => assertMutation(["talosctl", "etcd", "remove-member", "node-a"])).toThrow(
      MutationNotPlannedError,
    );
  });

  test("refuses unknown binaries", () => {
    expect(() => assertMutation(["bash", "-c", "echo hi"])).toThrow(MutationNotPlannedError);
  });

  // The property that lets execution be offered at all.
  test("run() without mutating:true refuses a mutation, which is the model's path", async () => {
    await expect(
      run(["talosctl", "-n", "node-a", "upgrade", "--image", "x"]),
    ).rejects.toThrow();
  });
});

describe("plan compiler", () => {
  test("orders snapshot before any control-plane change", () => {
    const plan = buildPlan(cfg, inventory, upstream);
    expect(plan.steps[0]!.kind).toBe("snapshot");
  });

  test("steps Talos one minor at a time and never emits --preserve", () => {
    const plan = buildPlan(cfg, inventory, upstream);
    const talos = plan.steps.filter((s) => s.kind === "talos-upgrade");
    expect(talos.map((s) => s.title)).toEqual([
      "Upgrade Talos on node-a to 1.13.9",
      "Upgrade Talos on node-a to 1.14.1",
    ]);
    for (const step of talos) {
      // Deprecated since 1.13; it selects the legacy upgrade path.
      expect(step.argv).not.toContain("--preserve");
    }
  });

  test("builds the installer image from the node's schematic", () => {
    const plan = buildPlan(cfg, inventory, upstream);
    const first = plan.steps.find((s) => s.kind === "talos-upgrade")!;
    const image = first.argv[first.argv.indexOf("--image") + 1];
    expect(image).toBe("factory.talos.dev/installer/abc123:v1.13.9");
  });

  test("gates every Talos upgrade on the schematic and a snapshot", () => {
    const plan = buildPlan(cfg, inventory, upstream);
    for (const step of plan.steps.filter((s) => s.kind === "talos-upgrade")) {
      const kinds = step.preflight.map((p) => p.kind);
      expect(kinds).toContain("schematic-matches");
      expect(kinds).toContain("snapshot-exists");
      expect(kinds).toContain("cluster-healthy");
    }
  });

  test("marks single-node Talos upgrades as a full outage", () => {
    const plan = buildPlan(cfg, inventory, upstream);
    const talos = plan.steps.find((s) => s.kind === "talos-upgrade")!;
    expect(talos.downtime).toBe("full-outage");
  });

  // Regression: the executor routed every step through the mutation gate,
  // including the read-only final verify. The gate refused `kubectl get`, the
  // throw escaped, and a run whose upgrade had already succeeded died without
  // a run-end record or a state sync. Verify steps must use the read-only gate.
  test("the verify step is read-only and would be refused as a mutation", () => {
    const plan = buildPlan(cfg, inventory, upstream, withValues);
    const verify = plan.steps.find((s) => s.kind === "verify")!;
    expect(() => assertReadOnly(verify.argv)).not.toThrow();
    expect(() => assertMutation(verify.argv)).toThrow(MutationNotPlannedError);
  });

  test("every generated command passes the mutation gate", () => {
    const plan = buildPlan(cfg, inventory, upstream, {
      valuesPaths: { "default/gitea": "/tmp/gitea-values.yaml" },
    });
    expect(plan.steps.some((s) => s.kind === "helm-upgrade")).toBe(true);
    for (const step of plan.steps) {
      if (step.kind === "verify") continue;
      expect(() => assertMutation(step.argv)).not.toThrow();
    }
  });

  const withValues = { valuesPaths: { "default/gitea": "/tmp/gitea-values.yaml" } };

  test("applies the values file with -f rather than --reuse-values", () => {
    const plan = buildPlan(cfg, inventory, upstream, withValues);
    const helm = plan.steps.find((s) => s.kind === "helm-upgrade")!;
    expect(helm.argv).toContain("-f");
    expect(helm.argv[helm.argv.indexOf("-f") + 1]).toBe("/tmp/gitea-values.yaml");
    // --reuse-values layers old values over the new chart and suppresses its
    // new defaults, which defeats upgrading to latest.
    expect(helm.argv).not.toContain("--reuse-values");
  });

  // A bare `helm upgrade` resets a release to chart defaults. Emitting no step
  // is the safe failure; emitting a destructive one is not.
  // The wall-clock budget must outlast helm's own --wait; killing helm
  // mid-reconcile leaves the release in a state it never finished.
  test("gives helm more wall clock than its own --wait", () => {
    const plan = buildPlan(cfg, inventory, upstream, withValues);
    const helm = plan.steps.find((s) => s.kind === "helm-upgrade")!;
    const wait = helm.argv[helm.argv.indexOf("--timeout") + 1];
    expect(wait).toBe("15m");
    expect(helm.watch!.timeoutMs).toBeGreaterThan(15 * 60_000);
  });

  test("emits no helm step when there are no values to apply", () => {
    const plan = buildPlan(cfg, inventory, upstream, { valuesPaths: {} });
    expect(plan.steps.some((s) => s.kind === "helm-upgrade")).toBe(false);
  });

  test("respects --talos-only and --skip-helm", () => {
    expect(buildPlan(cfg, inventory, upstream, { talosOnly: true }).steps.some((s) => s.kind === "helm-upgrade")).toBe(
      false,
    );
    expect(buildPlan(cfg, inventory, upstream, { skipHelm: true }).steps.some((s) => s.kind === "helm-upgrade")).toBe(
      false,
    );
  });

  test("produces no steps when everything is current", () => {
    const current: UpstreamVersions = {
      talos: ["1.13.8"],
      kubernetes: ["1.36.3"],
      charts: { gitea: ["12.7.0"] },
      errors: [],
    };
    expect(buildPlan(cfg, inventory, current).steps).toEqual([]);
  });

  test("skips a chart upgrade when no repo is configured rather than guessing the ref", () => {
    const noRepo = { ...cfg, helmRepos: {} };
    const plan = buildPlan(noRepo, inventory, upstream);
    expect(plan.steps.some((s) => s.kind === "helm-upgrade")).toBe(false);
  });
});
