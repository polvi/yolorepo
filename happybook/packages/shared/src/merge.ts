/**
 * LWW merge used identically on client and server. A record version is the
 * tuple (updatedAt, writeId); writeId is a per-write UUID acting purely as a
 * deterministic tie-breaker. Tombstones follow the same rule as edits, so a
 * delete can never be silently resurrected by an older write.
 */
export interface Versioned {
  updatedAt: number;
  writeId: string;
}

export function compareVersions(a: Versioned, b: Versioned): -1 | 0 | 1 {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? -1 : 1;
  if (a.writeId !== b.writeId) return a.writeId < b.writeId ? -1 : 1;
  return 0;
}

export function incomingWins(incoming: Versioned, current: Versioned | null | undefined): boolean {
  if (current == null) return true;
  return compareVersions(incoming, current) > 0;
}
