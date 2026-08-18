// Just enough semver for upgrade planning. Version comparison decides real
// upgrade ordering, so it is code rather than something the model is asked to
// eyeball.

export interface Version {
  major: number;
  minor: number;
  patch: number;
  /** Prerelease tag, e.g. "beta.1"; empty for stable releases. */
  pre: string;
}

export function parse(input: string): Version | undefined {
  const match = input.trim().replace(/^v/, "").match(/^(\d+)\.(\d+)(?:\.(\d+))?(?:[-+](.+))?$/);
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3] ?? 0),
    pre: match[4] ?? "",
  };
}

export function isStable(input: string): boolean {
  const v = parse(input);
  return !!v && v.pre === "";
}

/** Returns <0, 0, or >0. A prerelease sorts below its own release. */
export function compare(a: Version, b: Version): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (a.pre === b.pre) return 0;
  if (a.pre === "") return 1;
  if (b.pre === "") return -1;
  return a.pre < b.pre ? -1 : 1;
}

export function compareStrings(a: string, b: string): number {
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return 0;
  return compare(pa, pb);
}

/** Newest first. Anything unparseable is dropped. */
export function sortDesc(versions: string[]): string[] {
  return versions
    .filter((v) => parse(v))
    .sort((a, b) => compareStrings(b, a));
}

/**
 * Newest stable first. Upgrade targets always come from here: chart repos
 * publish `-develop` and `-prerelease` builds alongside releases, and openebs
 * in particular publishes them with a *higher* version than the newest stable,
 * so taking the top of an unfiltered list recommends a prerelease.
 */
export function sortStableDesc(versions: string[]): string[] {
  return sortDesc(versions.filter(isStable));
}

export function minorSeries(input: string): string | undefined {
  const v = parse(input);
  return v ? `${v.major}.${v.minor}` : undefined;
}

/** How far apart two versions are, for severity and for skew checks. */
export function gap(current: string, latest: string): "none" | "patch" | "minor" | "major" {
  const c = parse(current);
  const l = parse(latest);
  if (!c || !l) return "none";
  if (compare(l, c) <= 0) return "none";
  if (l.major > c.major) return "major";
  if (l.minor > c.minor) return "minor";
  return "patch";
}

/** Number of minor releases between two versions within the same major. */
export function minorDistance(current: string, latest: string): number {
  const c = parse(current);
  const l = parse(latest);
  if (!c || !l || c.major !== l.major) return 0;
  return l.minor - c.minor;
}

/**
 * The highest patch available in each minor series at or above `current`,
 * newest last. This is the actual upgrade path: Talos and Kubernetes both
 * require stepping one minor at a time, landing on the latest patch of each.
 */
export function upgradePath(current: string, available: string[]): string[] {
  const c = parse(current);
  if (!c) return [];

  const bySeries = new Map<string, string>();
  for (const v of available) {
    const p = parse(v);
    if (!p || p.pre !== "") continue;
    if (compare(p, c) <= 0) continue;
    // Only walk forward within the same major; a major bump needs a human.
    if (p.major !== c.major) continue;
    const key = `${p.major}.${p.minor}`;
    const best = bySeries.get(key);
    if (!best || compareStrings(v, best) > 0) bySeries.set(key, v);
  }

  return [...bySeries.values()].sort(compareStrings);
}
