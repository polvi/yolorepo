import { describe, expect, test } from "bun:test";
import { assertReadOnly, RefusedCommandError } from "./exec.ts";
import { REDACTED, redactText } from "./redact.ts";
import { realAnomalies, sortAnomalies } from "./sweep/index.ts";
import { parseDmesg, summarizeHits } from "./sweep/logs.ts";
import type { Anomaly } from "./sweep/types.ts";

const NOW = new Date("2026-08-18T03:00:00Z");
const DAY_AGO = new Date(NOW.getTime() - 24 * 3600_000);

function dmesg(at: string, message: string): string {
  return `199.68.201.82: kern:    info: [${at}]: ${message}`;
}

/** The real shape: smartctl walking a SAS backplane, one line per drive. */
function pollerNoise(devices: string[], perDevice: number): string {
  const lines: string[] = [];
  for (const device of devices) {
    for (let i = 0; i < perDevice; i++) {
      lines.push(
        dmesg(
          "2026-08-18T02:23:55.000000000Z",
          `sd 0:2:1:0: [${device}] tag#${i} Sense Key : Recovered Error [current]`,
        ),
      );
    }
  }
  return lines.join("\n");
}

describe("kernel log scanning", () => {
  test("drops lines older than the window instead of aging them", () => {
    const text = [
      dmesg("2026-08-12T00:30:10.000000000Z", "sd 0:2:1:0: [sda] Sense Key : Medium Error"),
      dmesg("2026-08-18T02:23:55.000000000Z", "sd 0:2:2:0: [sdb] Sense Key : Medium Error"),
    ].join("\n");

    const hits = parseDmesg(text, DAY_AGO);
    // A cable error from the boot six days ago is history, not an incident.
    expect(hits).toHaveLength(1);
    expect(hits[0]!.device).toBe("sdb");
  });

  test("ignores undated continuation fragments", () => {
    // Talos prints SUBSYSTEM=/DEVICE= as separate undated lines. Counting them
    // as current would let a stale record leak past the recency filter.
    const text = [
      dmesg("2026-08-18T02:23:55.000000000Z", "sd 0:2:2:0: [sdb] Sense Key : Medium Error"),
      " SUBSYSTEM=scsi",
      " DEVICE=+scsi:0:2:10:0",
    ].join("\n");

    expect(parseDmesg(text, DAY_AGO)).toHaveLength(1);
  });

  test("a medium error is never absorbed by the recovered-error pattern", () => {
    const text = dmesg(
      "2026-08-18T02:23:55.000000000Z",
      "sd 0:2:1:0: [sda] Sense Key : Medium Error [current]",
    );
    const [anomaly] = summarizeHits("proc-0", parseDmesg(text, DAY_AGO));

    expect(anomaly!.severity).toBe("critical");
    expect(anomaly!.expected).toBeUndefined();
    expect(anomaly!.id).toContain("medium-error");
  });

  test("a recovered error is reported but never counted as a problem", () => {
    const text = dmesg(
      "2026-08-18T02:23:55.000000000Z",
      "sd 0:2:1:0: [sda] Sense Key : Recovered Error [current]",
    );
    const [anomaly] = summarizeHits("proc-0", parseDmesg(text, DAY_AGO));

    // "Recovered" is the drive saying it fixed the problem. It matches every
    // naive /error/i scan and means the opposite of what that scan concludes.
    expect(anomaly!.severity).toBe("info");
    expect(anomaly!.expected).toBeTruthy();
    expect(realAnomalies([anomaly!])).toHaveLength(0);
  });

  // The bug this whole heuristic exists to prevent: on the live cluster all 16
  // drives log ~75 recovered errors a day because smartctl-exporter reads their
  // defect lists on a timer. Reported as 16 failing drives, the sweep is noise.
  test("a pattern spread evenly over every device reads as a poller, not a fault", () => {
    const devices = ["sda", "sdb", "sdc", "sdd", "sde", "sdf", "sdg", "sdh"];
    const text = pollerNoise(devices, 9);
    const [anomaly] = summarizeHits("proc-0", parseDmesg(text, DAY_AGO));

    expect(anomaly!.expected).toBeTruthy();
    expect(anomaly!.title).toContain("8 devices");
  });

  test("the same pattern on one device stays a real finding", () => {
    // Same signal, different shape: one drive misbehaving is exactly what the
    // uniformity test must not swallow.
    const text = [
      dmesg("2026-08-18T02:23:55.000000000Z", "sd 0:2:1:0: [sdb] tag#1 Sense Key : Aborted Command"),
      dmesg("2026-08-18T02:24:55.000000000Z", "sd 0:2:1:0: [sdb] tag#2 Sense Key : Aborted Command"),
      dmesg("2026-08-18T02:25:55.000000000Z", "sd 0:2:1:0: [sdb] tag#3 Sense Key : Aborted Command"),
    ].join("\n");
    const [anomaly] = summarizeHits("proc-0", parseDmesg(text, DAY_AGO));

    expect(anomaly!.expected).toBeUndefined();
    expect(anomaly!.severity).toBe("warning");
    expect(realAnomalies([anomaly!])).toHaveLength(1);
  });

  test("a lopsided spread across devices is still a fault, not a poller", () => {
    // One drive at 40 and three at 1 apiece is not something walking the bus
    // on a timer, even though four devices are involved.
    const lines = [
      dmesg("2026-08-18T02:23:55.000000000Z", "sd 0:2:1:0: [sdb] Sense Key : Aborted Command"),
    ];
    for (let i = 0; i < 39; i++) {
      lines.push(
        dmesg("2026-08-18T02:23:55.000000000Z", `sd 0:2:1:0: [sdb] tag#${i} Sense Key : Aborted Command`),
      );
    }
    for (const device of ["sdc", "sdd", "sde"]) {
      lines.push(
        dmesg("2026-08-18T02:23:55.000000000Z", `sd 0:2:1:0: [${device}] Sense Key : Aborted Command`),
      );
    }
    const [anomaly] = summarizeHits("proc-0", parseDmesg(lines.join("\n"), DAY_AGO));

    expect(anomaly!.expected).toBeUndefined();
    expect(realAnomalies([anomaly!])).toHaveLength(1);
  });

  test("carries sample lines and the most recent timestamp as evidence", () => {
    const text = dmesg("2026-08-18T02:23:55.000000000Z", "Kernel panic - not syncing: oh no");
    const [anomaly] = summarizeHits("proc-0", parseDmesg(text, DAY_AGO));

    expect(anomaly!.severity).toBe("critical");
    expect(anomaly!.evidence.join("\n")).toContain("2026-08-18T02:23:55");
    expect(anomaly!.evidence.join("\n")).toContain("Kernel panic");
  });
});

describe("secret redaction", () => {
  // Found live: the Talos kernel command line carries the Omni siderolink join
  // token, so a raw dmesg dump is credential-bearing and the sweep both prints
  // it and feeds it to the model.
  test("strips the siderolink join token from the kernel command line", () => {
    const line =
      "Command line: BOOT_IMAGE=/A/vmlinuz talos.platform=metal " +
      "siderolink.api=https://proc.siderolink.omni.siderolabs.io?jointoken=Tc7JycffeBf6USURcKchi3vE1DrjKn11ZwexDg9cDoQC " +
      "talos.events.sink=[fdae:41e4:649b:9303::1]:8090";

    const out = redactText(line);
    expect(out).not.toContain("Tc7JycffeBf6USURcKchi3vE1DrjKn11ZwexDg9cDoQC");
    expect(out).toContain(REDACTED);
    // Everything that is not a secret survives, or the log stops being useful.
    expect(out).toContain("BOOT_IMAGE=/A/vmlinuz");
    expect(out).toContain("talos.platform=metal");
  });

  test("strips credentials embedded in URLs and auth headers", () => {
    expect(redactText("postgres://gitea:hunter2@db:5432/gitea")).not.toContain("hunter2");
    expect(redactText("Authorization: Bearer abc.def.ghi")).not.toContain("abc.def.ghi");
  });

  test("redacts assignments regardless of separator or quoting", () => {
    for (const input of [
      "password=hunter2",
      "api_key: hunter2",
      'ADMIN_TOKEN="hunter2"',
      "clientSecret=hunter2",
    ]) {
      expect(redactText(input)).not.toContain("hunter2");
    }
  });

  test("leaves ordinary log text alone", () => {
    const line = "sd 0:2:10:0: [sdj] tag#4694 Add. Sense: Defect list not found";
    expect(redactText(line)).toBe(line);
  });
});

describe("anomaly ranking", () => {
  const make = (id: string, severity: Anomaly["severity"], expected?: string): Anomaly => ({
    id,
    severity,
    category: "hardware",
    title: id,
    detail: "",
    evidence: [],
    expected,
  });

  test("real problems outrank expected noise regardless of severity", () => {
    const sorted = sortAnomalies([
      make("expected-critical", "critical", "fires forever on Talos"),
      make("real-warning", "warning"),
      make("real-critical", "critical"),
    ]);

    expect(sorted.map((a) => a.id)).toEqual([
      "real-critical",
      "real-warning",
      "expected-critical",
    ]);
  });

  test("the headline count ignores expected and informational findings", () => {
    const real = realAnomalies([
      make("a", "critical"),
      make("b", "info"),
      make("c", "critical", "expected"),
    ]);
    expect(real.map((a) => a.id)).toEqual(["a"]);
  });
});

describe("the sweep stays inside the read-only gate", () => {
  test("reaching Prometheus through the API server proxy is an ordinary read", () => {
    // The sweep needs Prometheus but must not open a tunnel: `port-forward` is
    // a denied verb, and rightly so. A proxied GET keeps the gate as tight as
    // it was while still reading the time series.
    const argv = [
      "kubectl",
      "--context",
      "proc-proc-dev",
      "get",
      "--raw",
      "/api/v1/namespaces/flux-system/services/prometheus-operated:9090/proxy/api/v1/query?query=up",
    ];
    expect(() => assertReadOnly(argv)).not.toThrow();
  });

  test("port-forward is still refused, so there is no second way in", () => {
    expect(() =>
      assertReadOnly(["kubectl", "port-forward", "-n", "flux-system", "svc/prometheus-operated", "9090"]),
    ).toThrow(RefusedCommandError);
  });

  test("every command the sweep issues passes the read-only gate", () => {
    for (const argv of [
      ["talosctl", "-n", "proc-0", "dmesg"],
      ["talosctl", "-n", "proc-0", "services"],
      ["talosctl", "-n", "proc-0", "logs", "kubelet"],
      ["kubectl", "--context", "c", "get", "pods", "-A", "-o", "json"],
      ["kubectl", "--context", "c", "-n", "default", "logs", "web-0", "--previous", "--tail", "60"],
      ["kubectl", "--context", "c", "get", "svc", "-A", "-o", "json"],
    ]) {
      expect(() => assertReadOnly(argv)).not.toThrow();
    }
  });
});
