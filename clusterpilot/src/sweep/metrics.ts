// Metric-driven anomaly rules.
//
// Everything here is a fixed query with a fixed threshold. The model does not
// choose what to look at and does not decide what counts as abnormal, for the
// same reason it does not do version arithmetic in analyze.ts: these are
// comparisons, and comparisons should be code.
//
// Three ideas shape the rule set.
//
// 1. Levels are weak, slopes are strong. "62% full" is not actionable; "full in
//    nine days at the current rate" is. Anything that can fill gets a
//    projection as well as a level.
// 2. Counters that only ever increase deserve two readings. A lifetime total
//    tells you something happened once; the increase over the last day tells
//    you it is happening now. A drive with 4 uncorrected errors from a bad
//    cable two years ago is not the same as one accruing them this afternoon.
// 3. Expected noise is labelled, never hidden. This cluster permanently fires
//    three alerts because Talos binds those endpoints to localhost. They are
//    reported with the reason attached and excluded from the counts, so the day
//    a fourth appears it is visible instead of lost in a wall of known noise.

import type { Anomaly, Headroom, Sample } from "./types.ts";
import type { Prometheus } from "./promql.ts";

/** Capacity thresholds, as fraction used. */
const CAPACITY_WARN = 0.8;
const CAPACITY_CRITICAL = 0.9;

/** Projected-exhaustion thresholds, in days. */
const FILL_CRITICAL_DAYS = 7;
const FILL_WARN_DAYS = 30;

/** Drive temperature, in Celsius. Enterprise SAS spec is typically 60C. */
const TEMP_WARN_C = 55;
const TEMP_CRITICAL_C = 60;

/**
 * Alerts that fire forever on a healthy Talos cluster.
 *
 * Talos binds kube-proxy, kube-scheduler, and kube-controller-manager metrics
 * to localhost, so kube-prometheus can never scrape them. The honest fixes are
 * to stop scraping them or to rebind them via a machine config patch; until one
 * of those happens these fire continuously and mean nothing.
 */
const EXPECTED_ALERT_JOBS = ["kube-proxy", "kube-scheduler", "kube-controller-manager"];

const EXPECTED_ALERT_NAMES = [
  "KubeProxyInstanceUnreachable",
  "KubeSchedulerInstanceUnreachable",
  "KubeControllerManagerInstanceUnreachable",
  "KubeProxyDown",
  "KubeSchedulerDown",
  "KubeControllerManagerDown",
];

/**
 * Alerts kube-prometheus ships that are *supposed* to fire forever.
 *
 * Watchdog is a deadman's switch: it fires continuously so a receiver can tell
 * "no alerts" apart from "the alerting pipeline is dead". Reporting it as a
 * problem inverts its meaning -- the interesting day is the one where it stops.
 */
const ALWAYS_FIRING_ALERTS: Record<string, string> = {
  Watchdog:
    "A deadman's switch built into kube-prometheus. It fires continuously on purpose, so that a silent " +
    "Alertmanager can be told apart from a quiet cluster. Its firing is the healthy state.",
  InfoInhibitor:
    "A routing helper that suppresses info-level alerts while a warning is already firing. It is " +
    "permanently active by design and is not a condition.",
};

const TALOS_LOCALHOST_REASON =
  "Talos binds this component's metrics endpoint to localhost, so Prometheus cannot scrape it. " +
  "It fires continuously on a healthy cluster and says nothing about the component's actual health.";

function label(s: Sample, ...keys: string[]): string {
  for (const k of keys) {
    const v = s.labels[k];
    if (v) return v;
  }
  return "";
}

const pct = (f: number) => `${(f * 100).toFixed(1)}%`;

function capacitySeverity(fraction: number): "critical" | "warning" | undefined {
  if (fraction >= CAPACITY_CRITICAL) return "critical";
  if (fraction >= CAPACITY_WARN) return "warning";
  return undefined;
}

/**
 * Collects headroom rows and capacity anomalies.
 *
 * The memory rule is the one worth reading twice. On a ZFS host, the ARC counts
 * as used memory but is evicted under pressure, so the naive reading badly
 * overstates the problem: this box reports 32% used with the ARC counted and 4%
 * without. The ex-ARC number is the one that predicts whether the node is
 * actually about to run out, so it is the one that drives the alert; the raw
 * number is kept as context so the two are never confused.
 */
export async function checkCapacity(
  prom: Prometheus,
): Promise<{ anomalies: Anomaly[]; headroom: Headroom[] }> {
  const anomalies: Anomaly[] = [];
  const headroom: Headroom[] = [];

  const [cpu, memRaw, memExArc, filesystems, pvcs, podSlots, cpuRequests] = await Promise.all([
    prom.instant(`1 - avg(rate(node_cpu_seconds_total{mode="idle"}[10m]))`),
    prom.instant(`1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes`),
    prom.instant(
      `1 - (node_memory_MemAvailable_bytes + node_zfs_arc_size) / node_memory_MemTotal_bytes`,
    ),
    prom.instant(
      `1 - node_filesystem_avail_bytes{fstype!~"tmpfs|ramfs|overlay|squashfs|iso9660|rootfs"} / node_filesystem_size_bytes`,
    ),
    prom.instant(`kubelet_volume_stats_used_bytes / kubelet_volume_stats_capacity_bytes`),
    prom.instant(
      `count(kube_pod_info) / sum(kube_node_status_allocatable{resource="pods"})`,
    ),
    // Only Running pods. kube_pod_container_resource_requests keeps reporting
    // for Succeeded pods, so an unfiltered sum counts finished Jobs: two
    // 32-core build Jobs once read as 86% of this node committed while it sat idle.
    prom.instant(
      `sum(kube_pod_container_resource_requests{resource="cpu"} * on(pod, namespace) group_left ` +
        `(kube_pod_status_phase{phase="Running"} == 1)) / sum(kube_node_status_allocatable{resource="cpu"})`,
    ),
  ]);

  const simple: { id: string; label: string; samples: Sample[]; detail?: string }[] = [
    { id: "cpu", label: "CPU utilization", samples: cpu },
    {
      id: "memory",
      label: "Memory used (excluding ZFS ARC)",
      samples: memExArc,
      detail: memRaw[0]
        ? `${pct(memRaw[0].value)} counting the ARC, which is evicted on demand`
        : undefined,
    },
    { id: "pod-slots", label: "Pod slots", samples: podSlots },
    { id: "cpu-requests", label: "CPU committed by requests", samples: cpuRequests },
  ];

  for (const row of simple) {
    const sample = row.samples[0];
    if (!sample) continue;
    headroom.push({ id: row.id, label: row.label, usedFraction: sample.value, detail: row.detail });

    const severity = capacitySeverity(sample.value);
    if (severity) {
      anomalies.push({
        id: `capacity.${row.id}`,
        severity,
        category: "capacity",
        title: `${row.label} at ${pct(sample.value)}`,
        detail: row.detail ?? `${row.label} has crossed the ${pct(CAPACITY_WARN)} mark.`,
        evidence: [`${row.label}: ${pct(sample.value)}`],
      });
    }
  }

  const fsProjection = await projectDaysUntilFull(
    prom,
    `node_filesystem_avail_bytes{fstype!~"tmpfs|ramfs|overlay|squashfs|iso9660|rootfs"}`,
    ["mountpoint"],
  );
  for (const s of filesystems) {
    const mount = label(s, "mountpoint");
    if (!mount) continue;
    const days = fsProjection.get(mount);
    headroom.push({
      id: `fs:${mount}`,
      label: `Filesystem ${mount}`,
      usedFraction: s.value,
      daysUntilFull: days,
    });
    pushFillAnomaly(anomalies, `filesystem.${mount}`, "storage", `Filesystem ${mount}`, s.value, days);
  }

  const pvcProjection = await projectDaysUntilFull(prom, `kubelet_volume_stats_available_bytes`, [
    "persistentvolumeclaim",
    "namespace",
  ]);
  for (const s of pvcs) {
    const name = label(s, "persistentvolumeclaim");
    const ns = label(s, "namespace");
    if (!name) continue;
    const key = ns ? `${ns}/${name}` : name;
    const days = pvcProjection.get(key);
    headroom.push({
      id: `pvc:${key}`,
      label: `PVC ${key}`,
      usedFraction: s.value,
      daysUntilFull: days,
    });
    pushFillAnomaly(anomalies, `pvc.${key}`, "storage", `PVC ${key}`, s.value, days);
  }

  return { anomalies, headroom };
}

/**
 * Days until a shrinking "available bytes" series reaches zero, per series.
 *
 * Deliberately linear and deliberately over a whole day. A shorter window turns
 * one log rotation into "full in six hours", and a smarter model would need
 * more confidence than a slope deserves. Series that are flat or shrinking in
 * use produce no entry rather than a negative or infinite one.
 */
async function projectDaysUntilFull(
  prom: Prometheus,
  availableMetric: string,
  keyLabels: string[],
): Promise<Map<string, number>> {
  const samples = await prom.instant(
    `${availableMetric} / -deriv(${availableMetric}[24h]) / 86400 > 0`,
  );
  const out = new Map<string, number>();
  for (const s of samples) {
    const key = keyLabels
      .map((l) => s.labels[l])
      .filter(Boolean)
      .reverse()
      .join("/");
    if (key) out.set(key, s.value);
  }
  return out;
}

function pushFillAnomaly(
  into: Anomaly[],
  id: string,
  category: "storage",
  label: string,
  fraction: number,
  days: number | undefined,
): void {
  const bySize = capacitySeverity(fraction);
  const byTrend =
    days === undefined
      ? undefined
      : days <= FILL_CRITICAL_DAYS
        ? "critical"
        : days <= FILL_WARN_DAYS
          ? "warning"
          : undefined;

  if (!bySize && !byTrend) return;

  const severity = bySize === "critical" || byTrend === "critical" ? "critical" : "warning";
  const trend =
    days === undefined
      ? "It is not currently growing, so this is a level rather than a trend."
      : `At the last 24 hours' rate it fills in about ${days.toFixed(0)} day${days < 1.5 ? "" : "s"}.`;

  into.push({
    id: `fill.${id}`,
    severity,
    category,
    title: `${label} is ${pct(fraction)} full`,
    detail: trend,
    evidence: [
      `${label}: ${pct(fraction)} used`,
      days === undefined ? "trend: flat or shrinking" : `projected full in ${days.toFixed(1)} days`,
    ],
  });
}

/**
 * Hardware. These are the checks worth running on a box you cannot see, and
 * every one of them is a counter that a healthy machine leaves alone.
 */
export async function checkHardware(prom: Prometheus): Promise<Anomaly[]> {
  const anomalies: Anomaly[] = [];

  const [pools, smartFailing, uncorrectedRead, uncorrectedWrite, recentUncorrected, ecc, eccRecent, temps] =
    await Promise.all([
      // node_zfs_zpool_state is one-hot: there is a series per possible state
      // and the live one is 1. Testing `!= 0` matches the healthy `online`
      // series and reports every pool as broken, which is the wrong direction
      // for a check whose whole job is to be trusted when it stays quiet.
      prom.instant(`node_zfs_zpool_state{state!="online"} == 1`),
      prom.instant(`smartctl_device_smart_status == 0`),
      prom.instant(`smartctl_read_total_uncorrected_errors > 0`),
      prom.instant(`smartctl_write_total_uncorrected_errors > 0`),
      prom.instant(
        `increase(smartctl_read_total_uncorrected_errors[24h]) + increase(smartctl_write_total_uncorrected_errors[24h]) > 0`,
      ),
      prom.instant(`node_edac_uncorrectable_errors_total > 0 or node_edac_correctable_errors_total > 0`),
      prom.instant(
        `increase(node_edac_correctable_errors_total[24h]) + increase(node_edac_uncorrectable_errors_total[24h]) > 0`,
      ),
      prom.instant(`smartctl_device_temperature{temperature_type="current"} >= ${TEMP_WARN_C}`),
    ]);

  for (const s of pools) {
    anomalies.push({
      id: `zpool.${label(s, "zpool")}`,
      severity: "critical",
      category: "storage",
      title: `ZFS pool ${label(s, "zpool")} is ${label(s, "state")}, not online`,
      detail:
        "Every PVC on this cluster is backed by this pool. A pool that is not online is the most serious thing " +
        "the sweep can find: check `zpool status` on the node before doing anything else, and do not start an upgrade.",
      evidence: [`node_zfs_zpool_state{zpool="${label(s, "zpool")}",state="${label(s, "state")}"} = 1`],
    });
  }

  for (const s of smartFailing) {
    anomalies.push({
      id: `smart.${label(s, "device")}`,
      severity: "critical",
      category: "hardware",
      title: `Drive ${label(s, "device")} reports SMART status FAILING`,
      detail:
        "The drive's own firmware predicts imminent failure. Replace it. If it is a ZFS pool member, the pool " +
        "is running without the redundancy you think it has until it is replaced and resilvered.",
      evidence: [`smartctl_device_smart_status{device="${label(s, "device")}"} = 0`],
    });
  }

  const recentDevices = new Set(recentUncorrected.map((s) => label(s, "device")));
  for (const s of [...uncorrectedRead, ...uncorrectedWrite]) {
    const device = label(s, "device");
    const active = recentDevices.has(device);
    anomalies.push({
      id: `smart.uncorrected.${device}`,
      severity: active ? "critical" : "warning",
      category: "hardware",
      title: `Drive ${device} has ${s.value} uncorrected error${s.value === 1 ? "" : "s"}${active ? ", still accruing" : ""}`,
      detail: active
        ? "The count went up in the last 24 hours, so this is happening now rather than a historical scar. Plan a replacement."
        : "The count is not moving. This is most likely an old event; worth knowing, not worth acting on tonight.",
      evidence: [`uncorrected errors on ${device}: ${s.value}`, `increased in last 24h: ${active}`],
    });
  }

  const eccRecentInstances = new Set(eccRecent.map((s) => label(s, "instance")));
  for (const s of ecc) {
    const instance = label(s, "instance");
    const active = eccRecentInstances.has(instance);
    anomalies.push({
      id: `ecc.${instance}`,
      severity: active ? "critical" : "warning",
      category: "hardware",
      title: `ECC memory errors recorded (${s.value})${active ? ", still accruing" : ""}`,
      detail: active
        ? "Correctable ECC errors that keep climbing usually precede an uncorrectable one. Identify the DIMM and plan a swap."
        : "The counter is not moving, so this is a historical count rather than an active fault.",
      evidence: [`EDAC error total: ${s.value}`, `increased in last 24h: ${active}`],
    });
  }

  for (const s of temps) {
    const device = label(s, "device");
    anomalies.push({
      id: `temp.${device}`,
      severity: s.value >= TEMP_CRITICAL_C ? "critical" : "warning",
      category: "hardware",
      title: `Drive ${device} is at ${s.value}C`,
      detail: `Sustained temperatures above ${TEMP_CRITICAL_C}C shorten drive life sharply. Check airflow and fan speeds.`,
      evidence: [`smartctl_device_temperature{device="${device}"} = ${s.value}`],
    });
  }

  return anomalies;
}

/** Workload-level trouble: restarts, OOM kills, and pods that are not running. */
export async function checkWorkloads(prom: Prometheus): Promise<Anomaly[]> {
  const anomalies: Anomaly[] = [];

  const [restarts, oomKilled, notRunning, networkErrors] = await Promise.all([
    prom.instant(`increase(kube_pod_container_status_restarts_total[24h]) > 0`),
    prom.instant(`kube_pod_container_status_last_terminated_reason{reason="OOMKilled"} == 1`),
    prom.instant(`kube_pod_status_phase{phase=~"Failed|Unknown|Pending"} == 1`),
    prom.instant(
      `increase(node_network_receive_errs_total[24h]) + increase(node_network_transmit_errs_total[24h]) > 0`,
    ),
  ]);

  for (const s of restarts) {
    const pod = `${label(s, "namespace")}/${label(s, "pod")}`;
    const container = label(s, "container");
    // A handful of restarts is a bad day; a hundred is a crash loop, and the
    // difference matters more than the fact of restarting at all.
    const severity = s.value >= 10 ? "critical" : s.value >= 3 ? "warning" : "info";
    anomalies.push({
      id: `restarts.${pod}.${container}`,
      severity,
      category: "workload",
      title: `${pod} (${container}) restarted ${Math.round(s.value)}x in 24h`,
      detail:
        severity === "info"
          ? "A small number of restarts, which can be routine. Worth a glance at the previous container's logs."
          : "Sustained restarting. The previous container's logs are collected below where available.",
      evidence: [`restarts in 24h: ${s.value.toFixed(0)}`],
    });
  }

  for (const s of oomKilled) {
    const pod = `${label(s, "namespace")}/${label(s, "pod")}`;
    anomalies.push({
      id: `oom.${pod}.${label(s, "container")}`,
      severity: "warning",
      category: "workload",
      title: `${pod} (${label(s, "container")}) was OOMKilled`,
      detail:
        "The container hit its memory limit and was killed. Either the limit is too low or something is leaking; " +
        "the restart count tells you which, since a leak restarts on a schedule.",
      evidence: [`last terminated reason: OOMKilled`],
    });
  }

  for (const s of notRunning) {
    const pod = `${label(s, "namespace")}/${label(s, "pod")}`;
    anomalies.push({
      id: `phase.${pod}`,
      severity: label(s, "phase") === "Pending" ? "warning" : "critical",
      category: "workload",
      title: `${pod} is ${label(s, "phase")}`,
      detail:
        label(s, "phase") === "Pending"
          ? "Pending usually means unschedulable: no node with the requested resources, or an unbound volume."
          : "The pod is not running and not succeeding. Check its events and previous logs.",
      evidence: [`phase: ${label(s, "phase")}`],
    });
  }

  for (const s of networkErrors) {
    anomalies.push({
      id: `net.${label(s, "device", "instance")}`,
      severity: "warning",
      category: "network",
      title: `NIC ${label(s, "device")} logged ${s.value.toFixed(0)} errors in 24h`,
      detail: "Interface-level errors point at cabling, a transceiver, or a switch port rather than software.",
      evidence: [`errors in 24h: ${s.value.toFixed(0)}`],
    });
  }

  return anomalies;
}

/** Firing alerts, and scrape targets that are down. */
export async function checkAlerts(prom: Prometheus): Promise<Anomaly[]> {
  const anomalies: Anomaly[] = [];

  for (const alert of await prom.firingAlerts()) {
    const job = alert.labels.job ?? "";
    const expected =
      ALWAYS_FIRING_ALERTS[alert.name] ??
      (EXPECTED_ALERT_NAMES.includes(alert.name) || EXPECTED_ALERT_JOBS.includes(job)
        ? TALOS_LOCALHOST_REASON
        : undefined);

    anomalies.push({
      id: `alert.${alert.name}.${job || alert.labels.instance || ""}`,
      severity: expected ? "info" : alert.severity === "critical" ? "critical" : "warning",
      category: "control-plane",
      title: `Alert firing: ${alert.name}${job ? ` (${job})` : ""}`,
      detail: alert.summary || "No summary on the alert rule.",
      evidence: [`labels: ${JSON.stringify(alert.labels)}`],
      expected,
    });
  }

  const down = await prom.instant(`up == 0`);
  for (const s of down) {
    const job = label(s, "job");
    const expected = EXPECTED_ALERT_JOBS.includes(job) ? TALOS_LOCALHOST_REASON : undefined;
    anomalies.push({
      id: `scrape.${job}.${label(s, "instance")}`,
      severity: expected ? "info" : "warning",
      category: "control-plane",
      title: `Prometheus cannot scrape ${job || "a target"} at ${label(s, "instance")}`,
      detail: expected
        ? "Expected on Talos."
        : "A metrics target is down. Until it comes back, every other check that relies on it is blind rather than clean.",
      evidence: [`up{job="${job}",instance="${label(s, "instance")}"} = 0`],
      expected,
    });
  }

  return anomalies;
}
