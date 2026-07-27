import Dexie, { type EntityTable } from 'dexie';
import {
  nextTimestamp,
  progressIdFor,
  type Anchor,
  type DocumentRec,
  type Highlight,
  type Link,
  type Notebook,
  type ProgressRec,
  type TextAnchor,
} from '@happybook/shared';

/** Local rows add the push-queue flag on top of the synced shape. */
type Local<T> = T & { dirty: 0 | 1 };
export type LocalNotebook = Local<Notebook>;
export type LocalDocument = Local<DocumentRec>;
export type LocalHighlight = Local<Highlight>;
export type LocalLink = Local<Link>;
export type LocalProgress = Local<ProgressRec>;
export type MetaRow = { key: string; value: unknown };

export const db = new Dexie('happybook') as Dexie & {
  notebooks: EntityTable<LocalNotebook, 'id'>;
  documents: EntityTable<LocalDocument, 'id'>;
  highlights: EntityTable<LocalHighlight, 'id'>;
  links: EntityTable<LocalLink, 'id'>;
  progress: EntityTable<LocalProgress, 'id'>;
  meta: EntityTable<MetaRow, 'key'>;
};

db.version(1).stores({
  notebooks: 'id, updatedAt, dirty',
  documents: 'id, notebookId, sha256, dirty',
  highlights: 'id, documentId, notebookId, dirty',
  links: 'id, notebookId, fromDocumentId, toDocumentId, dirty',
  meta: 'key',
});

db.version(2).stores({
  progress: 'id, documentId, notebookId, dirty',
});

/** Lamport-bumped write stamp; the clock survives restarts via the meta table. */
export async function stamp(): Promise<{ updatedAt: number; writeId: string }> {
  return db.transaction('rw', db.meta, async () => {
    const row = await db.meta.get('clock');
    const last = typeof row?.value === 'number' ? row.value : 0;
    const updatedAt = nextTimestamp(last, Date.now());
    await db.meta.put({ key: 'clock', value: updatedAt });
    return { updatedAt, writeId: crypto.randomUUID() };
  });
}

export async function getMeta<T>(key: string): Promise<T | undefined> {
  return (await db.meta.get(key))?.value as T | undefined;
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  await db.meta.put({ key, value });
}

// ---- Operations. Every mutation stamps the record and marks it dirty; the
// sync client picks dirty rows up on its next tick.

let onLocalWrite: (() => void) | null = null;
/** The sync client registers here to get poked (debounced) after local writes. */
export function setLocalWriteListener(fn: (() => void) | null): void {
  onLocalWrite = fn;
}
function poke(): void {
  onLocalWrite?.();
}

export async function createNotebook(title: string): Promise<LocalNotebook> {
  const s = await stamp();
  const notebook: LocalNotebook = {
    id: crypto.randomUUID(),
    title,
    createdAt: Date.now(),
    deleted: 0,
    dirty: 1,
    ...s,
  };
  await db.notebooks.add(notebook);
  poke();
  return notebook;
}

export async function renameNotebook(id: string, title: string): Promise<void> {
  const s = await stamp();
  await db.notebooks.update(id, { title, dirty: 1, ...s });
  poke();
}

export async function addDocument(
  notebookId: string,
  info: {
    title: string;
    sha256: string;
    size: number;
    format: 'pdf' | 'epub';
    pageCount: number;
  },
): Promise<LocalDocument> {
  const s = await stamp();
  const doc: LocalDocument = {
    id: crypto.randomUUID(),
    notebookId,
    addedAt: Date.now(),
    deleted: 0,
    dirty: 1,
    ...info,
    ...s,
  };
  await db.documents.add(doc);
  poke();
  return doc;
}

export async function addHighlight(
  notebookId: string,
  documentId: string,
  anchor: TextAnchor,
  color: string,
): Promise<LocalHighlight> {
  const s = await stamp();
  const highlight: LocalHighlight = {
    id: crypto.randomUUID(),
    notebookId,
    documentId,
    anchor,
    color,
    deleted: 0,
    dirty: 1,
    ...s,
  };
  await db.highlights.add(highlight);
  poke();
  return highlight;
}

export async function addLink(
  notebookId: string,
  from: { documentId: string; anchor: Anchor },
  to: { documentId: string; anchor: Anchor },
): Promise<LocalLink> {
  const s = await stamp();
  const link: LocalLink = {
    id: crypto.randomUUID(),
    notebookId,
    fromDocumentId: from.documentId,
    fromAnchor: from.anchor,
    toDocumentId: to.documentId,
    toAnchor: to.anchor,
    deleted: 0,
    dirty: 1,
    ...s,
  };
  await db.links.add(link);
  poke();
  return link;
}

/**
 * Persist the reading position for a document. One record per document at a
 * deterministic id shared with the kosync endpoint, so device and web writes
 * converge on the same row. Skips writes that would not move the position
 * meaningfully to keep scroll noise out of the sync stream.
 */
export async function saveProgress(
  doc: LocalDocument,
  pos: { page?: number; percentage: number },
): Promise<void> {
  const id = await progressIdFor(doc.id);
  const percentage = Math.min(1, Math.max(0, pos.percentage));
  const format = doc.format ?? 'pdf';
  const existing = await db.progress.get(id);

  if (existing && existing.deleted === 0) {
    const samePage = format === 'pdf' && pos.page !== undefined && existing.progress === String(pos.page);
    const sameSpot = format !== 'pdf' && Math.abs(existing.percentage - percentage) < 0.002;
    if (samePage || sameSpot) return;
  }

  const s = await stamp();
  const row: LocalProgress = {
    id,
    notebookId: doc.notebookId,
    documentId: doc.id,
    percentage,
    // PDFs speak page numbers in both directions. The web cannot produce the
    // CRengine xpointers EPUB progress is expressed in, so it preserves the
    // device's last one and only advances the percentage.
    progress: format === 'pdf' && pos.page !== undefined ? String(pos.page) : (existing?.progress ?? ''),
    device: 'happybook-web',
    timestamp: Math.floor(Date.now() / 1000),
    deleted: 0,
    dirty: 1,
    ...s,
  };
  await db.progress.put(row);
  poke();
}

export async function getProgress(documentId: string): Promise<LocalProgress | undefined> {
  const row = await db.progress.get(await progressIdFor(documentId));
  return row && row.deleted === 0 ? row : undefined;
}

type SyncTable = 'notebooks' | 'documents' | 'highlights' | 'links' | 'progress';

/** Deletes are writes: tombstone the row, keep it, let LWW spread it. */
export async function softDelete(table: SyncTable, id: string): Promise<void> {
  const s = await stamp();
  await db[table].update(id, { deleted: 1, dirty: 1, ...s });
  poke();
}

export async function deleteNotebookDeep(notebookId: string): Promise<void> {
  const docs = await db.documents.where('notebookId').equals(notebookId).toArray();
  for (const d of docs) await softDelete('documents', d.id);
  const progress = await db.progress.where('notebookId').equals(notebookId).toArray();
  for (const p of progress) await softDelete('progress', p.id);
  const highlights = await db.highlights.where('notebookId').equals(notebookId).toArray();
  for (const h of highlights) await softDelete('highlights', h.id);
  const links = await db.links.where('notebookId').equals(notebookId).toArray();
  for (const l of links) await softDelete('links', l.id);
  await softDelete('notebooks', notebookId);
}
