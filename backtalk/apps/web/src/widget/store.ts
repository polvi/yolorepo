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

// ------------------------------------------------------------- outbox
// Feedback written on a plane: events that could not be sent are parked
// here and drained when connectivity returns. Client UUIDs make resends
// idempotent, so draining can race a retry harmlessly.

const outboxKey = (projectKey: string) => `bt:${projectKey}:outbox`;

export function outbox(projectKey: string): Record<string, unknown>[] {
  try {
    const raw = localStorage.getItem(outboxKey(projectKey));
    return raw ? (JSON.parse(raw) as Record<string, unknown>[]) : [];
  } catch {
    return [];
  }
}

export function pushOutbox(projectKey: string, ev: Record<string, unknown>): boolean {
  try {
    const all = [...outbox(projectKey), ev].slice(-50);
    localStorage.setItem(outboxKey(projectKey), JSON.stringify(all));
    return true;
  } catch {
    return false; // private mode / quota: nothing we can do offline
  }
}

export function replaceOutbox(projectKey: string, events: Record<string, unknown>[]): void {
  try {
    if (events.length === 0) localStorage.removeItem(outboxKey(projectKey));
    else localStorage.setItem(outboxKey(projectKey), JSON.stringify(events));
  } catch {
    // swallow
  }
}

export function outboxIds(projectKey: string): Set<string> {
  return new Set(outbox(projectKey).map((e) => String(e.id)));
}
