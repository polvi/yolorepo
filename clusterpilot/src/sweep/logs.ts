// Log sweeping: kernel ring buffer, Talos service logs, and the logs of
// containers that died.
//
// Scanning logs for scary words is easy and mostly produces noise, so the value
// here is in what gets *rejected*. Three filters do that work:
//
//   recency     A kernel log covers the whole uptime. A cable error from the
//               boot six days ago is history, not an incident, and mixing the
//               two is how a sweep cries wolf. Talos timestamps every dmesg
//               line, so lines outside the window are dropped rather than aged.
//
//   severity    "Recovered Error" is the drive telling you it fixed the
//               problem. It matches every naive /error/i scan and means the
//               opposite of what that scan concludes.
//
//   uniformity  A fault hits one device. A poller hits all of them. When a
//               device-scoped pattern appears on nearly every device at nearly
//               the same count, it is something walking the bus on a timer --
//               on this cluster, smartctl-exporter reading defect lists off a
//               SAS backplane, which produces ~75 "Recovered Error" lines per
//               drive per day across all 16 and means nothing at all.
//
// Without the third filter a healthy box reports sixteen failing drives, and a
// sweep that does that once gets ignored forever after.

import type { Config } from "../config.ts";
import { run } from "../exec.ts";
import { redactText } from "../redact.ts";
import type { Severity } from "../types.ts";
import type { Anomaly, AnomalyCategory } from "./types.ts";

/** How far back a log line still counts as current. */
const DEFAULT_WINDOW_HOURS = 24;

/** Per-source caps, so one chatty node cannot blow up the report or the prompt. */
const MAX_SAMPLE_LINES = 3;
const MAX_LOG_BYTES = 8 * 1024 * 1024;
const CONTAINER_LOG_TAIL = 60;

/** Devices needed before "everything is affected" outweighs "something failed". */
const UNIFORM_MIN_DEVICES = 4;
/** How close the per-device counts must be to read as a poller rather than a fault. */
const UNIFORM_RATIO = 0.5;

interface Pattern {
  id: string;
  re: RegExp;
  severity: Severity;
  category: AnomalyCategory;
  /** What it means, in the report. Written for someone who did not grep for it. */
  meaning: string;
  /** Always benign; reported as context rather than as a problem. */
  benign?: string;
}

/**
 * Kernel log patterns, ordered most severe first. A line is attributed to the
 * first pattern it matches, so `Medium Error` never falls through to the
 * generic recovered-error bucket.
 */
const KERNEL_PATTERNS: Pattern[] = [
  {
    id: "panic",
    re: /Kernel panic|BUG: unable to handle|general protection fault/i,
    severity: "critical",
    category: "logs",
    meaning: "The kernel hit a fatal fault. If the node is up, it rebooted to get there.",
  },
  {
    id: "mce",
    re: /Machine Check Exception|mce: \[Hardware Error\]|Hardware Error.*CPU/i,
    severity: "critical",
    category: "hardware",
    meaning: "The CPU reported a machine check. This is a hardware fault, usually memory or the CPU itself.",
  },
  {
    id: "oom",
    re: /Out of memory: Killed process|oom-kill:|invoked oom-killer/i,
    severity: "critical",
    category: "workload",
    meaning:
      "The kernel killed a process to reclaim memory. This is node-level pressure, which is more serious than a container hitting its own limit.",
  },
  {
    id: "fs-readonly",
    re: /Remounting filesystem read-only|EXT4-fs error|XFS \(.*\): (corrupt|Corruption)/i,
    severity: "critical",
    category: "storage",
    meaning:
      "A filesystem hit an error and protected itself. Anything writing to it is now failing, whether or not it has noticed.",
  },
  {
    id: "zfs-fault",
    re: /ZFS:.*(suspended|I\/O failure|pool is (degraded|faulted))|zio (error|pool)/i,
    severity: "critical",
    category: "storage",
    meaning: "ZFS reported a pool-level fault. Every PVC on this cluster sits on that pool.",
  },
  {
    id: "io-error",
    re: /blk_update_request: (critical )?(I\/O|medium) error|Buffer I\/O error|critical medium error/i,
    severity: "critical",
    category: "storage",
    meaning: "A block device failed a request outright. Data was not read or not written.",
  },
  {
    id: "medium-error",
    re: /Sense Key : Medium Error/i,
    severity: "critical",
    category: "hardware",
    meaning: "The drive could not read or write the media itself. This is the classic bad-sector signature.",
  },
  {
    id: "hardware-sense",
    re: /Sense Key : Hardware Error/i,
    severity: "critical",
    category: "hardware",
    meaning: "The drive reported an internal hardware failure.",
  },
  {
    id: "soft-lockup",
    re: /soft lockup|rcu_sched detected stalls|watchdog: BUG/i,
    severity: "critical",
    category: "logs",
    meaning: "A CPU stopped making progress long enough for the watchdog to notice.",
  },
  {
    id: "ata-reset",
    re: /hard resetting link|COMRESET failed|link is slow to respond/i,
    severity: "warning",
    category: "hardware",
    meaning: "A storage link was reset. Repeated resets on one device usually mean a cable, backplane slot, or dying drive.",
  },
  {
    id: "aborted-command",
    re: /Sense Key : Aborted Command/i,
    severity: "warning",
    category: "hardware",
    meaning: "A command was aborted in transit, which points at the path to the drive more than the drive.",
  },
  {
    id: "hung-task",
    re: /hung_task|blocked for more than \d+ seconds/i,
    severity: "warning",
    category: "logs",
    meaning: "A task was stuck in uninterruptible sleep, nearly always waiting on I/O that never returned.",
  },
  {
    id: "nic",
    re: /NETDEV WATCHDOG|transmit queue \d+ timed out|Link is Down/i,
    severity: "warning",
    category: "network",
    meaning: "The network interface reset or dropped its link.",
  },
  {
    id: "thermal",
    re: /Core temperature above threshold|thermal.*(throttl|critical)/i,
    severity: "warning",
    category: "hardware",
    meaning: "The CPU throttled itself to shed heat. Check airflow before blaming performance on software.",
  },
  {
    id: "pcie-aer",
    re: /AER: .*(Uncorrected|Fatal)/i,
    severity: "warning",
    category: "hardware",
    meaning: "A PCIe device reported an uncorrected error.",
  },
  {
    id: "call-trace",
    re: /Call Trace:/i,
    severity: "warning",
    category: "logs",
    meaning: "A kernel stack trace was printed. On its own it is a symptom; read the line above it for the cause.",
  },
  {
    id: "recovered-error",
    re: /Sense Key : Recovered Error/i,
    severity: "info",
    category: "hardware",
    benign:
      "A recovered error is the drive reporting that it detected a problem and corrected it. It matches any " +
      "naive search for /error/ and means the opposite of what that search concludes.",
    meaning: "The drive corrected the problem itself.",
  },
  {
    id: "old-microcode",
    re: /Running old microcode/i,
    severity: "info",
    category: "hardware",
    benign: "A BIOS-level note printed at every boot. It is a standing condition, not an event.",
    meaning: "The CPU is running microcode older than the kernel knows about.",
  },
];

/** `199.68.201.82: kern:  notice: [2026-08-12T00:30:10.494269304Z]: message` */
const DMESG_LINE = /^(\S+):\s+(\w+):\s+(\w+):\s+\[([0-9T:.\-Z]+)\]:\s*(.*)$/;

/** SCSI device token, e.g. `[sdj]`, used to tell one drive's fault from all drives' noise. */
const DEVICE_TOKEN = /\[(sd[a-z]+|nvme\d+n\d+|dm-\d+)\]/;

interface Hit {
  pattern: Pattern;
  device?: string;
  line: string;
  at?: Date;
}

export function parseDmesg(text: string, since: Date): Hit[] {
  const hits: Hit[] = [];

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;

    const parsed = DMESG_LINE.exec(line);
    const message = parsed?.[5] ?? line;
    const at = parsed?.[4] ? new Date(parsed[4]) : undefined;

    // Undated lines are continuation fragments of the previous record
    // (Talos prints SUBSYSTEM=/DEVICE= that way). Dropping them loses nothing
    // and keeps a stale fragment from being counted as current.
    if (!at || Number.isNaN(at.getTime())) continue;
    if (at < since) continue;

    const pattern = KERNEL_PATTERNS.find((p) => p.re.test(message));
    if (!pattern) continue;

    hits.push({
      pattern,
      device: DEVICE_TOKEN.exec(message)?.[1],
      line: redactText(line),
      at,
    });
  }

  return hits;
}

/**
 * Turns raw hits into anomalies, one per pattern, collapsing repeats.
 *
 * The uniformity test lives here because it can only be made once every device
 * has been counted: it is a statement about the shape of the whole set, not
 * about any single line.
 */
export function summarizeHits(node: string, hits: Hit[]): Anomaly[] {
  const byPattern = new Map<string, Hit[]>();
  for (const hit of hits) {
    const list = byPattern.get(hit.pattern.id);
    if (list) list.push(hit);
    else byPattern.set(hit.pattern.id, [hit]);
  }

  const out: Anomaly[] = [];

  for (const [id, group] of byPattern) {
    const pattern = group[0]!.pattern;
    const devices = [...new Set(group.map((h) => h.device).filter(Boolean) as string[])];

    const perDevice = devices.map(
      (d) => group.filter((h) => h.device === d).length,
    );
    const uniform =
      devices.length >= UNIFORM_MIN_DEVICES &&
      Math.min(...perDevice) >= Math.max(...perDevice) * UNIFORM_RATIO;

    const expected =
      pattern.benign ??
      (uniform
        ? `Seen on all ${devices.length} devices at a similar rate (${Math.min(...perDevice)}-${Math.max(...perDevice)} each). ` +
          "A failing device produces this on one device; something polling every device on a timer produces it on all of them evenly. " +
          "This is the second shape."
        : undefined);

    const latest = group.reduce((a, b) => ((a.at?.getTime() ?? 0) > (b.at?.getTime() ?? 0) ? a : b));

    out.push({
      id: `log.${node}.${id}`,
      severity: expected ? "info" : pattern.severity,
      category: pattern.category,
      title:
        `${node}: ${group.length} kernel log line${group.length === 1 ? "" : "s"} matching ${id}` +
        (devices.length > 0 ? ` on ${devices.length} device${devices.length === 1 ? "" : "s"}` : ""),
      detail: pattern.meaning,
      evidence: [
        `most recent: ${latest.at?.toISOString() ?? "unknown"}`,
        ...(devices.length > 0 ? [`devices: ${devices.sort().join(", ")}`] : []),
        ...group.slice(-MAX_SAMPLE_LINES).map((h) => h.line),
      ],
      expected,
    });
  }

  return out;
}

function kubectl(cfg: Config, ...args: string[]): string[] {
  const argv = [cfg.bin.kubectl];
  if (cfg.kubeContext) argv.push("--context", cfg.kubeContext);
  return [...argv, ...args];
}

/** Scans every node's kernel ring buffer. */
export async function sweepKernelLogs(
  cfg: Config,
  windowHours = DEFAULT_WINDOW_HOURS,
): Promise<{ anomalies: Anomaly[]; ok: boolean; note?: string }> {
  const since = new Date(Date.now() - windowHours * 3600_000);
  const anomalies: Anomaly[] = [];
  let anyOk = false;
  const failures: string[] = [];

  for (const node of cfg.talosNodes) {
    const res = await run([cfg.bin.talosctl, "-n", node, "dmesg"], {
      timeoutMs: Math.max(cfg.timeoutMs, 60_000),
      maxBytes: MAX_LOG_BYTES,
    });
    if (!res.ok) {
      failures.push(`${node}: ${res.stderr.trim().slice(0, 200) || `exit ${res.code}`}`);
      continue;
    }
    anyOk = true;
    anomalies.push(...summarizeHits(node, parseDmesg(res.stdout, since)));
  }

  return {
    anomalies,
    ok: anyOk,
    note: failures.length > 0 ? failures.join("; ") : undefined,
  };
}

/**
 * Pulls the previous container's logs for pods that have been restarting.
 *
 * `--previous` is the point: the current container is the one that came back,
 * and it is usually healthy and boring. The one that died is the one that
 * explains why, and its logs disappear on the next restart.
 */
export async function collectCrashLogs(
  cfg: Config,
  pods: { namespace: string; name: string; container?: string }[],
): Promise<{ ref: string; text: string }[]> {
  const out: { ref: string; text: string }[] = [];

  for (const pod of pods) {
    const argv = kubectl(
      cfg,
      "-n",
      pod.namespace,
      "logs",
      pod.name,
      "--previous",
      "--tail",
      String(CONTAINER_LOG_TAIL),
    );
    if (pod.container) argv.push("-c", pod.container);

    const res = await run(argv, { timeoutMs: 30_000, maxBytes: 1024 * 1024 });
    // A pod that has never restarted has no previous container, and kubectl
    // exits non-zero saying so. That is the expected case, not an error.
    if (!res.ok) continue;
    const text = redactText(res.stdout.trim());
    if (text) out.push({ ref: `${pod.namespace}/${pod.name}`, text });
  }

  return out;
}
