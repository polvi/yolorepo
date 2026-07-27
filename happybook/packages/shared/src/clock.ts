/**
 * Lamport-bumped wall clock: timestamps are wall-clock time, but never
 * less than one past anything already observed, which bounds the damage
 * a device with a skewed clock can do.
 */
export function nextTimestamp(lastClockSeen: number, now: number): number {
  return Math.max(now, lastClockSeen + 1);
}

export function observeTimestamp(lastClockSeen: number, seen: number): number {
  return Math.max(lastClockSeen, seen);
}
