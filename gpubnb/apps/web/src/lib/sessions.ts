// Renter sessions live only in this browser, keyed by endpoint URL. What is
// stored is whatever @gpubnb/client exports (session id + key + subaddress);
// losing it means losing the prepaid balance on that session, so the page
// says so next to the "forget" button.
const KEY = 'gpubnb.sessions.v1';

export interface StoredSession {
  endpoint: string;
  listing_id: string;
  saved_at: number;
  data: unknown;
}

function readAll(): Record<string, StoredSession> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, StoredSession>;
  } catch {
    return {};
  }
}

export function loadSession(endpoint: string): StoredSession | null {
  return readAll()[endpoint] ?? null;
}

export function saveSession(endpoint: string, listingId: string, data: unknown): void {
  const all = readAll();
  all[endpoint] = { endpoint, listing_id: listingId, saved_at: Date.now(), data };
  localStorage.setItem(KEY, JSON.stringify(all));
}

export function forgetSession(endpoint: string): void {
  const all = readAll();
  delete all[endpoint];
  localStorage.setItem(KEY, JSON.stringify(all));
}
