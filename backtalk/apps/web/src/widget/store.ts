// localStorage memory of what this browser submitted, so the widget can
// show "your submissions" with live statuses — the closed loop.

export type StoredSub = { id: string; t: number; kind: string; msg: string };

const storageKey = (projectKey: string) => `bt:${projectKey}:subs`;

export function storedSubmissions(projectKey: string): StoredSub[] {
  try {
    const raw = localStorage.getItem(storageKey(projectKey));
    return raw ? (JSON.parse(raw) as StoredSub[]) : [];
  } catch {
    return [];
  }
}

export function rememberSubmission(projectKey: string, sub: StoredSub): void {
  try {
    const all = [sub, ...storedSubmissions(projectKey)].slice(0, 50);
    localStorage.setItem(storageKey(projectKey), JSON.stringify(all));
  } catch {
    // private mode / quota: the loop just won't close on this browser
  }
}
