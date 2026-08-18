import { describe, expect, test } from "bun:test";
import { assertReadOnly, RefusedCommandError } from "./exec.ts";
import { installerImage } from "./analyze.ts";
import { splitChart } from "./probes/helm.ts";
import { parseJsonStream } from "./probes/talos.ts";
import * as semver from "./semver.ts";
import { extractChartVersions } from "./upstream/index.ts";

describe("read-only allowlist", () => {
  test("permits the probes clusterpilot actually runs", () => {
    expect(() => assertReadOnly(["kubectl", "get", "nodes", "-o", "json"])).not.toThrow();
    expect(() => assertReadOnly(["talosctl", "-n", "proc-0", "get", "disks"])).not.toThrow();
    expect(() => assertReadOnly(["helm", "list", "-A", "-o", "json"])).not.toThrow();
    expect(() => assertReadOnly(["/opt/homebrew/bin/helm", "repo", "update"])).not.toThrow();
  });

  test("refuses every mutating verb, wherever it appears in the argv", () => {
    for (const argv of [
      ["kubectl", "delete", "pod", "x"],
      ["kubectl", "apply", "-f", "x.yaml"],
      ["talosctl", "upgrade", "--nodes", "proc-0"],
      ["talosctl", "reset"],
      ["helm", "uninstall", "gitea"],
      ["talosctl", "-n", "proc-0", "upgrade-k8s", "--to", "1.37.0"],
      // Buried past the subcommand, not just in first position.
      ["kubectl", "get", "pods", "--as", "delete"],
    ]) {
      expect(() => assertReadOnly(argv)).toThrow(RefusedCommandError);
    }
  });

  test("refuses binaries that are not cluster tools", () => {
    expect(() => assertReadOnly(["bash", "-c", "rm -rf /"])).toThrow(RefusedCommandError);
    expect(() => assertReadOnly(["curl", "https://example.com"])).toThrow(RefusedCommandError);
  });

  test("refuses read-shaped subcommands that are not allowlisted", () => {
    expect(() => assertReadOnly(["kubectl", "debug", "node/proc-0"])).toThrow(RefusedCommandError);
  });
});

describe("semver", () => {
  test("orders releases newest first", () => {
    expect(semver.sortDesc(["1.9.0", "1.13.8", "1.10.2", "1.13.10"])).toEqual([
      "1.13.10",
      "1.13.8",
      "1.10.2",
      "1.9.0",
    ]);
  });

  test("classifies the gap", () => {
    expect(semver.gap("1.13.8", "1.13.8")).toBe("none");
    expect(semver.gap("1.13.8", "1.13.9")).toBe("patch");
    expect(semver.gap("1.13.8", "1.14.0")).toBe("minor");
    expect(semver.gap("1.13.8", "2.0.0")).toBe("major");
    // Never suggest going backwards.
    expect(semver.gap("1.14.0", "1.13.8")).toBe("none");
  });

  test("upgradePath lands on the newest patch of each minor, in order", () => {
    const available = ["1.15.0", "1.14.3", "1.14.0", "1.13.9", "1.13.8", "1.12.1"];
    expect(semver.upgradePath("1.13.8", available)).toEqual(["1.13.9", "1.14.3", "1.15.0"]);
  });

  test("upgradePath is empty when already newest", () => {
    expect(semver.upgradePath("1.15.0", ["1.15.0", "1.14.3"])).toEqual([]);
  });

  test("upgradePath skips prereleases and other majors", () => {
    const available = ["2.0.0", "1.14.0-beta.1", "1.14.0", "1.13.9"];
    expect(semver.upgradePath("1.13.8", available)).toEqual(["1.13.9", "1.14.0"]);
  });
});

describe("talos JSON stream", () => {
  test("splits concatenated pretty-printed documents", () => {
    const text = `{
  "metadata": { "id": "a" },
  "spec": { "n": 1 }
}
{
  "metadata": { "id": "b" },
  "spec": { "n": 2 }
}`;
    const docs = parseJsonStream<{ metadata: { id: string } }>(text);
    expect(docs.map((d) => d.metadata.id)).toEqual(["a", "b"]);
  });

  test("is not fooled by braces inside strings", () => {
    // Talos extension descriptions really do contain braces and escapes.
    const text = `{"spec":{"desc":"a } brace and a \\" quote"}}{"spec":{"desc":"second"}}`;
    const docs = parseJsonStream<{ spec: { desc: string } }>(text);
    expect(docs).toHaveLength(2);
    expect(docs[0]!.spec.desc).toBe('a } brace and a " quote');
  });
});

describe("helm chart parsing", () => {
  test("splits a chart name that contains dashes", () => {
    expect(splitChart("kube-prometheus-stack-88.1.5")).toEqual({
      name: "kube-prometheus-stack",
      version: "88.1.5",
    });
    expect(splitChart("gitea-12.7.0")).toEqual({ name: "gitea", version: "12.7.0" });
    expect(splitChart("caddy-ingress-controller-1.3.0")).toEqual({
      name: "caddy-ingress-controller",
      version: "1.3.0",
    });
  });

  // Indentation here matches what helm actually publishes: entry names and
  // their list items both at two spaces, release fields at four.
  const INDEX = `apiVersion: v1
entries:
  actions:
  - apiVersion: v2
    version: 1.2.3
  gitea:
  - apiVersion: v2
    appVersion: 1.27.0
    version: 12.8.0
    dependencies:
    - name: postgresql
      version: 16.5.2
  - apiVersion: v2
    appVersion: 1.27.0
    version: 12.7.0
  other-chart:
  - apiVersion: v2
    version: 99.0.0
`;

  test("extracts one chart's versions and stops at the next entry", () => {
    expect(extractChartVersions(INDEX, "gitea")).toEqual(["12.8.0", "12.7.0"]);
    expect(extractChartVersions(INDEX, "actions")).toEqual(["1.2.3"]);
    expect(extractChartVersions(INDEX, "missing")).toEqual([]);
  });

  test("does not mistake a dependency's version for the chart's", () => {
    expect(extractChartVersions(INDEX, "gitea")).not.toContain("16.5.2");
  });

  // openebs publishes -develop and -prerelease builds numbered *above* the
  // newest stable, so an unfiltered list recommends a prerelease as "latest".
  test("drops prerelease builds so they can never become an upgrade target", () => {
    const index = `apiVersion: v1
entries:
  zfs-localpv:
  - apiVersion: v1
    version: 2.12.0-develop
  - apiVersion: v1
    version: 2.11.0-prerelease
  - apiVersion: v1
    version: 2.10.1
`;
    expect(extractChartVersions(index, "zfs-localpv")).toEqual(["2.10.1"]);
  });
});

describe("installer image", () => {
  test("uses the node's Image Factory schematic when it has one", () => {
    expect(installerImage("1.14.0", "e5348428")).toBe("factory.talos.dev/installer/e5348428:v1.14.0");
  });

  test("falls back to the stock installer only when there is no schematic", () => {
    expect(installerImage("1.14.0")).toBe("ghcr.io/siderolabs/installer:v1.14.0");
  });
});
