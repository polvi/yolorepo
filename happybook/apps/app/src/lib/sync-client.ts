import { get, writable } from 'svelte/store';
import {
  incomingWins,
  observeTimestamp,
  type Change,
  type PullResponse,
  type PushResponse,
  type RecordType,
} from '@happybook/shared';
import { blobStore } from './blobstore';
import { db, getMeta, setLocalWriteListener, setMeta } from './db';

export type SyncState = 'local-only' | 'idle' | 'syncing' | 'offline' | 'error';
export const syncState = writable<SyncState>('local-only');
export const currentUser = writable<string | null>(null);

const TABLES = {
  notebook: db.notebooks,
  document: db.documents,
  highlight: db.highlights,
  link: db.links,
  progress: db.progress,
} as const;
const TYPES = Object.keys(TABLES) as RecordType[];

let running = false;
let syncing = false;
let again = false;
let debounce: ReturnType<typeof setTimeout> | undefined;
let interval: ReturnType<typeof setInterval> | undefined;

/** Check our own API (which owns the auth question) and start syncing if signed in. */
export async function initSync(): Promise<void> {
  const me = await fetch('/api/me')
    .then((r) => (r.ok ? (r.json() as Promise<{ user_id: string }>) : null))
    .catch(() => null);
  if (!me) {
    syncState.set('local-only');
    return;
  }
  await startSync(me.user_id);
}

export async function startSync(userId: string): Promise<void> {
  const prev = await getMeta<string>('userId');
  if (prev && prev !== userId) {
    const wipe = confirm(
      'This device holds notebooks for a different account. Clear local data and continue with this account?',
    );
    if (!wipe) return;
    await Promise.all([
      db.notebooks.clear(),
      db.documents.clear(),
      db.highlights.clear(),
      db.links.clear(),
      db.progress.clear(),
      db.meta.clear(),
    ]);
  }
  if (prev !== userId) {
    await setMeta('userId', userId);
    await markAllDirty(); // pre-login local data has never been pushed
  }

  currentUser.set(userId);
  if (!running) {
    running = true;
    setLocalWriteListener(() => scheduleSync(2000));
    addEventListener('online', () => scheduleSync(0));
    interval = setInterval(() => {
      if (document.visibilityState === 'visible') scheduleSync(0);
    }, 60_000);
  }
  syncState.set('idle');
  void navigator.storage?.persist?.().catch(() => {});
  scheduleSync(0);
}

export function stopSync(): void {
  running = false;
  currentUser.set(null);
  syncState.set('local-only');
  setLocalWriteListener(null);
  if (interval) clearInterval(interval);
  clearTimeout(debounce);
}

export function scheduleSync(delayMs: number): void {
  if (!running) return;
  clearTimeout(debounce);
  debounce = setTimeout(() => void syncNow(), delayMs);
}

async function markAllDirty(): Promise<void> {
  await Promise.all([
    db.notebooks.toCollection().modify({ dirty: 1 }),
    db.documents.toCollection().modify({ dirty: 1 }),
    db.highlights.toCollection().modify({ dirty: 1 }),
    db.links.toCollection().modify({ dirty: 1 }),
    db.progress.toCollection().modify({ dirty: 1 }),
  ]);
}

export async function syncNow(): Promise<void> {
  if (!running) return;
  if (syncing) {
    again = true;
    return;
  }
  syncing = true;
  syncState.set('syncing');
  try {
    await pushDirty();
    await pullAll();
    await uploadMissingBlobs();
    await downloadMissingBlobs();
    syncState.set('idle');
  } catch (err) {
    syncState.set(navigator.onLine ? 'error' : 'offline');
    console.warn('sync failed', err);
  } finally {
    syncing = false;
    if (again) {
      again = false;
      scheduleSync(1000);
    }
  }
}

async function pushDirty(): Promise<void> {
  while (true) {
    const batch: (Change & { table: RecordType })[] = [];
    for (const type of TYPES) {
      const rows = await TABLES[type].where('dirty').equals(1).limit(200 - batch.length).toArray();
      for (const row of rows) {
        const { dirty, ...data } = row as unknown as Record<string, unknown> & { dirty: 0 | 1 };
        batch.push({
          table: type,
          id: row.id,
          type,
          notebookId: (row as { notebookId?: string }).notebookId ?? row.id,
          data,
          updatedAt: row.updatedAt,
          writeId: row.writeId,
          deleted: row.deleted,
        });
      }
      if (batch.length >= 200) break;
    }
    if (batch.length === 0) return;

    const res = await fetch('/api/sync/push', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ changes: batch.map(({ table, ...c }) => c) }),
    });
    if (!res.ok) throw new Error(`push failed: ${res.status}`);
    const { results } = (await res.json()) as PushResponse;

    // 'stale' also clears dirty: the server holds something newer and the
    // next pull will overwrite us. Skip clearing if the row changed mid-flight.
    for (const sent of batch) {
      const outcome = results.find((r) => r.id === sent.id);
      if (!outcome) continue;
      const table = TABLES[sent.table];
      await db.transaction('rw', table, async () => {
        const row = await table.get(sent.id);
        if (row && row.writeId === sent.writeId) {
          await table.update(sent.id, { dirty: 0 });
        }
      });
    }
    if (batch.length < 200) return;
  }
}

async function pullAll(): Promise<void> {
  while (true) {
    const since = (await getMeta<number>('cursor')) ?? 0;
    const res = await fetch(`/api/sync/pull?since=${since}&limit=500`);
    if (!res.ok) throw new Error(`pull failed: ${res.status}`);
    const { changes, cursor, hasMore } = (await res.json()) as PullResponse;

    for (const change of changes) {
      const table = TABLES[change.type as RecordType];
      if (!table) continue;
      await db.transaction('rw', table, db.meta, async () => {
        const local = await table.get(change.id);
        // Dirty local rows that win LWW stay put; they will re-push.
        const skip = local && local.dirty === 1 && !incomingWins(change, local);
        if (!skip && incomingWins(change, local)) {
          await table.put({ ...(change.data as object), dirty: 0 } as never);
        }
        const clockRow = await db.meta.get('clock');
        const last = typeof clockRow?.value === 'number' ? clockRow.value : 0;
        await db.meta.put({ key: 'clock', value: observeTimestamp(last, change.updatedAt) });
      });
    }
    await setMeta('cursor', cursor);
    if (!hasMore) return;
  }
}

/** Any local document whose bytes are not confirmed on the server gets uploaded. */
async function uploadMissingBlobs(): Promise<void> {
  const uploaded = (await getMeta<Record<string, true>>('uploadedBlobs')) ?? {};
  const docs = await db.documents.filter((d) => d.deleted === 0).toArray();
  const shas = [...new Set(docs.map((d) => d.sha256))];
  let changed = false;
  for (const sha of shas) {
    if (uploaded[sha]) continue;
    if (!(await blobStore.has(sha))) continue;
    const head = await fetch(`/api/blobs/${sha}`, { method: 'HEAD' });
    if (head.status === 404) {
      const bytes = await blobStore.get(sha);
      if (!bytes) continue;
      const put = await fetch(`/api/blobs/${sha}`, { method: 'PUT', body: bytes });
      if (!put.ok) continue;
    } else if (!head.ok) {
      continue;
    }
    uploaded[sha] = true;
    changed = true;
  }
  if (changed) await setMeta('uploadedBlobs', uploaded);
}

/** The notebook the user is looking at right now; its PDFs download first. */
let priorityNotebookId: string | null = null;
export function setPriorityNotebook(id: string | null): void {
  priorityNotebookId = id;
}

/**
 * Fetch every PDF this account references that is not on this device yet, so
 * a fresh device is fully readable (and offline-capable) after its first sync.
 * The open notebook's documents come first in the queue.
 */
async function downloadMissingBlobs(): Promise<void> {
  const docs = await db.documents.filter((d) => d.deleted === 0).toArray();
  const ordered = priorityNotebookId
    ? [
        ...docs.filter((d) => d.notebookId === priorityNotebookId),
        ...docs.filter((d) => d.notebookId !== priorityNotebookId),
      ]
    : docs;
  const shas = [...new Set(ordered.map((d) => d.sha256))];
  for (const sha of shas) {
    if (await blobStore.has(sha)) continue;
    try {
      const res = await fetch(`/api/blobs/${sha}`);
      if (!res.ok) continue;
      await blobStore.put(sha, await res.arrayBuffer());
    } catch {
      // offline or transient failure: the next sync tick retries
    }
  }
}

/** Make sure a PDF's bytes exist locally, downloading from R2 if needed. */
export async function ensureBlobLocal(sha256: string): Promise<boolean> {
  if (await blobStore.has(sha256)) return true;
  if (!get(currentUser)) return false;
  try {
    const res = await fetch(`/api/blobs/${sha256}`);
    if (!res.ok) return false;
    await blobStore.put(sha256, await res.arrayBuffer());
    return true;
  } catch {
    return false;
  }
}
