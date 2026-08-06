// Shared vocabulary for posts: kinds, statuses, and small formatting helpers.

export type Kind = "finding" | "question" | "guide" | "idea" | "bug";
export type Status = "open" | "accepted" | "declined" | "done";

// Notes are field reports that need no lifecycle; tracker kinds carry a status.
export const NOTE_KINDS: Kind[] = ["finding", "question", "guide"];
export const TRACKER_KINDS: Kind[] = ["idea", "bug"];

export function isTrackerKind(kind: string): boolean {
  return TRACKER_KINDS.includes(kind as Kind);
}

export function relTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const s = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.round(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.round(mo / 12)}y ago`;
}

export function fullDate(iso: string): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "";
  return then.toISOString().slice(0, 10);
}
