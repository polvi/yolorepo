import type { DocumentFormat } from '@happybook/shared';
import { addDocument, createNotebook } from './db';
import { blobStore } from './blobstore';
import { sha256Hex } from './hash';
import { openPdf } from './pdf';
import { openEpub } from './epub';

export const MAX_DOC_BYTES = 50 * 1024 * 1024;
export const IMPORT_ACCEPT = 'application/pdf,.pdf,application/epub+zip,.epub';

let persistRequested = false;

function detectFormat(file: File): DocumentFormat {
  if (file.type === 'application/epub+zip' || /\.epub$/i.test(file.name)) return 'epub';
  return 'pdf';
}

/**
 * Import a PDF or EPUB: hash off the main thread, stash bytes in OPFS, record
 * metadata. Creates a fresh notebook when none is given.
 */
export async function importDocument(
  file: File,
  notebookId?: string,
): Promise<{ notebookId: string; documentId: string }> {
  const format = detectFormat(file);
  if (file.size > MAX_DOC_BYTES) {
    throw new Error(`That ${format.toUpperCase()} is over 50 MB, which is the current limit.`);
  }
  const estimate = await navigator.storage?.estimate?.().catch(() => null);
  if (estimate?.quota && estimate.usage != null && estimate.quota - estimate.usage < file.size * 2) {
    throw new Error('Not enough storage space on this device for that file.');
  }

  const bytes = await file.arrayBuffer();
  const sha256 = await sha256Hex(bytes);

  // Opening validates that the file parses before anything is persisted.
  let pageCount: number;
  let embeddedTitle: string | null = null;
  if (format === 'epub') {
    const epub = openEpub(sha256, bytes);
    pageCount = epub.chapters.length;
    embeddedTitle = epub.title;
  } else {
    pageCount = (await openPdf(sha256, bytes)).numPages;
  }
  await blobStore.put(sha256, bytes);

  if (!persistRequested) {
    persistRequested = true;
    void navigator.storage?.persist?.().catch(() => {});
  }

  const title = embeddedTitle || file.name.replace(/\.(pdf|epub)$/i, '');
  const nbId = notebookId ?? (await createNotebook(title)).id;
  const doc = await addDocument(nbId, {
    title,
    sha256,
    size: bytes.byteLength,
    format,
    pageCount,
  });
  return { notebookId: nbId, documentId: doc.id };
}
