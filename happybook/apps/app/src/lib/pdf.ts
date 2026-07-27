import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
// The ?url import makes Vite emit the pdf.js worker as a hashed asset, so the
// service worker can precache it and PDFs render offline.
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export { pdfjs };
export type { PDFDocumentProxy };

const open = new Map<string, Promise<PDFDocumentProxy>>();

/** Open (and cache) a PDF by content hash. `data` is copied by pdf.js. */
export function openPdf(sha256: string, data: ArrayBuffer): Promise<PDFDocumentProxy> {
  let doc = open.get(sha256);
  if (!doc) {
    doc = pdfjs.getDocument({ data: data.slice(0) }).promise;
    open.set(sha256, doc);
  }
  return doc;
}

export function closePdf(sha256: string): void {
  const doc = open.get(sha256);
  open.delete(sha256);
  void doc?.then((d) => d.destroy()).catch(() => {});
}

/** Global cap on concurrent page renders so fast scrolling stays smooth. */
const MAX_CONCURRENT_RENDERS = 2;
let active = 0;
const waiters: (() => void)[] = [];

export async function withRenderSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT_RENDERS) {
    await new Promise<void>((resolve) => waiters.push(resolve));
  }
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiters.shift()?.();
  }
}
