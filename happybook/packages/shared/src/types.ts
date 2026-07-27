export type Rect = { x: number; y: number; w: number; h: number };

/**
 * Anchors are stored in scale-1 PDF page space, origin top-left of the page.
 * For EPUB documents `page` is the 1-based spine chapter index, offsets index
 * into the chapter's concatenated text, and `rects` is empty (reflowable
 * content re-derives geometry from the offsets at render time).
 */
export type TextAnchor = {
  kind: 'text';
  page: number; // 1-based
  quote: string;
  prefix: string;
  suffix: string;
  start: number; // char offsets into the page's concatenated text content
  end: number;
  rects: Rect[];
};
export type RegionAnchor = { kind: 'region'; page: number; rect: Rect };
export type PointAnchor = { kind: 'point'; page: number; x: number; y: number };
export type Anchor = TextAnchor | RegionAnchor | PointAnchor;

export type RecordType = 'notebook' | 'document' | 'highlight' | 'link' | 'progress';

/** Fields every syncable record carries. */
export interface SyncMeta {
  id: string; // client-generated UUID
  updatedAt: number; // Lamport-bumped wall clock
  writeId: string; // fresh UUID per write, LWW tie-breaker
  deleted: 0 | 1; // tombstone flag; deletes are writes
}

export interface Notebook extends SyncMeta {
  title: string;
  createdAt: number;
}

export type DocumentFormat = 'pdf' | 'epub';

export interface DocumentRec extends SyncMeta {
  notebookId: string;
  title: string;
  sha256: string;
  size: number;
  /** Absent on records written before EPUB support; treat as 'pdf'. */
  format?: DocumentFormat;
  /** Pages for PDFs, spine chapters for EPUBs. Anchor `page` counts the same unit. */
  pageCount: number;
  addedAt: number;
}

export interface Highlight extends SyncMeta {
  notebookId: string;
  documentId: string;
  anchor: TextAnchor;
  color: string;
  note?: string;
}

export interface Link extends SyncMeta {
  notebookId: string;
  fromDocumentId: string;
  fromAnchor: Anchor;
  toDocumentId: string;
  toAnchor: Anchor;
  label?: string;
}

/**
 * Reading position, one record per document (id is derived from the document
 * id, see progressIdFor). Written by the web reader and by the kosync endpoint
 * when a KOReader device syncs; both converge on the same record through LWW.
 */
export interface ProgressRec extends SyncMeta {
  notebookId: string;
  documentId: string;
  /** 0..1 fraction of the document. */
  percentage: number;
  /**
   * kosync progress value: a page-number string for PDFs, a CRengine xpointer
   * for EPUBs. Opaque — KOReader requires it echoed byte-identical. The web
   * reader cannot produce xpointers, so its EPUB writes preserve the last one.
   */
  progress: string;
  device: string;
  deviceId?: string;
  /** kosync timestamp: unix seconds of the write, KOReader staleness signal. */
  timestamp: number;
}

/** Wire format for push/pull. `data` is the full record JSON. */
export interface Change {
  id: string;
  type: RecordType;
  notebookId: string;
  data: unknown;
  updatedAt: number;
  writeId: string;
  deleted: 0 | 1;
}

export interface PulledChange extends Change {
  seq: number;
}

export interface PushResponse {
  cursor: number;
  results: { id: string; status: 'applied' | 'stale' }[];
}

export interface PullResponse {
  changes: PulledChange[];
  cursor: number;
  hasMore: boolean;
}
