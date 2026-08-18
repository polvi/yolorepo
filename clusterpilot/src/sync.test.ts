import { describe, expect, test } from "bun:test";
import { assertGit, GitNotAllowedError } from "./exec.ts";
import { buildState, renderState } from "./sync.ts";
import type { Inventory } from "./types.ts";

const inventory: Inventory = {
  collectedAt: "2026-08-18T00:00:00.000Z",
  kubeContext: "proc-proc-dev",
  talosNodes: [
    {
      name: "proc-0",
      version: "1.13.8",
      kernel: "6.18.42-talos",
      schematic: "e5348428",
      extensions: [
        { name: "zfs", version: "2.4.3-v1.13.8" },
        { name: "bnx2-bnx2x", version: "20260622" },
      ],
      disks: [],
      services: [],
    },
  ],
  kubeNodes: [
    {
      name: "proc-0",
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
      name: "kube-prometheus",
      namespace: "flux-system",
      chart: "kube-prometheus-stack",
      chartVersion: "88.1.5",
      appVersion: "v0.93.0",
      status: "deployed",
      userValues: "prometheus:\n  retention: 3y\n",
    },
  ],
  workloads: { unhealthyPods: [], pendingPvcs: [], recentWarnings: [] },
  probes: [],
};

describe("git gate", () => {
  test("permits only what sync needs", () => {
    for (const argv of [
      ["git", "-C", "/repo", "add", "--", "state.yaml"],
      ["git", "-C", "/repo", "commit", "-m", "msg"],
      ["git", "-C", "/repo", "status", "--porcelain"],
      ["git", "-C", "/repo", "rev-parse", "--show-toplevel"],
    ]) {
      expect(() => assertGit(argv)).not.toThrow();
    }
  });

  // The user asked for commit-without-push; push must be unreachable, not
  // merely unused.
  test("never pushes", () => {
    expect(() => assertGit(["git", "-C", "/repo", "push"])).toThrow(GitNotAllowedError);
    expect(() => assertGit(["git", "-C", "/repo", "push", "origin", "main"])).toThrow(
      GitNotAllowedError,
    );
  });

  test("refuses operations that can destroy uncommitted work", () => {
    for (const verb of ["reset", "clean", "checkout", "rebase", "merge", "pull"]) {
      expect(() => assertGit(["git", "-C", "/repo", verb])).toThrow(GitNotAllowedError);
    }
  });

  test("refuses non-git binaries", () => {
    expect(() => assertGit(["helm", "list"])).toThrow(GitNotAllowedError);
  });
});

describe("cluster state", () => {
  test("records versions, schematic, and extensions", () => {
    const state = buildState(inventory);
    expect(state.talos.nodes[0]!.version).toBe("1.13.8");
    expect(state.talos.nodes[0]!.schematic).toBe("e5348428");
    expect(state.talos.nodes[0]!.extensions.zfs).toBe("2.4.3-v1.13.8");
    expect(state.kubernetes.nodes[0]!.version).toBe("1.36.3");
    expect(state.helm["kube-prometheus"]!.chartVersion).toBe("88.1.5");
  });

  test("records the operator's supplied values, parsed", () => {
    const state = buildState(inventory);
    expect(state.helm["kube-prometheus"]!.values).toEqual({ prometheus: { retention: "3y" } });
  });

  // `helm get values` returns secrets in plaintext. This file gets committed
  // and pushed, so a leak here is unrecoverable. These are the exact shapes
  // found in the real gitea release on proc-proc-dev.
  test("redacts secrets out of values before they reach git", () => {
    const withSecrets: Inventory = {
      ...inventory,
      helmReleases: [
        {
          ...inventory.helmReleases[0]!,
          userValues: [
            "gitea:",
            "  admin:",
            "    username: polvi",
            "    password: 2ui$nUrcmwP4",
            "  config:",
            "    database:",
            "      PASSWD: k33pqRfux,iBEL",
            "      HOST: gitea-db-primary.default.svc:5432",
            "extra:",
            "  apiKey: abc123",
            "  private_key: xyz",
            "  url: postgres://user:hunter2@db:5432/app",
            "  harmless: keep-me",
          ].join("\n"),
        },
      ],
    };

    const text = renderState(buildState(withSecrets));

    for (const secret of ["2ui$nUrcmwP4", "k33pqRfux,iBEL", "abc123", "xyz", "hunter2"]) {
      expect(text).not.toContain(secret);
    }
    // Structure and non-secret values survive, so the record stays useful.
    expect(text).toContain("harmless: keep-me");
    expect(text).toContain("username: polvi");
    expect(text).toContain("gitea-db-primary.default.svc:5432");
  });

  test("a values change is still visible through the digest", () => {
    const a = buildState(inventory);
    const b = buildState({
      ...inventory,
      helmReleases: [{ ...inventory.helmReleases[0]!, userValues: "prometheus:\n  retention: 5y\n" }],
    });
    expect(a.helm["kube-prometheus"]!.valuesDigest).not.toBe(
      b.helm["kube-prometheus"]!.valuesDigest,
    );
  });

  test("marks the file as generated so nobody hand-edits it", () => {
    const text = renderState(buildState(inventory));
    expect(text).toContain("Generated by clusterpilot. Do not edit.");
    expect(text).toContain("what the cluster IS");
  });

  test("a release with no overrides records an empty object, not null", () => {
    const noValues: Inventory = {
      ...inventory,
      helmReleases: [{ ...inventory.helmReleases[0]!, userValues: "" }],
    };
    expect(buildState(noValues).helm["kube-prometheus"]!.values).toEqual({});
  });
});
