import { unzipSync } from 'fflate';
import { dirname, resolveHref } from './epub-paths';

export interface EpubDoc {
  title: string | null;
  /** Spine order; each entry is a zip path to an (X)HTML chapter. */
  chapters: { path: string }[];
  rawChapter(index: number): string; // 0-based
  resource(path: string): Uint8Array | null;
  mediaType(path: string): string | undefined;
}

function parseXml(text: string): Document {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('invalid XML inside EPUB');
  return doc;
}

/** Unzip and read the OPF package: title, manifest media types, spine order. */
export function parseEpub(bytes: ArrayBuffer): EpubDoc {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(new Uint8Array(bytes));
  } catch {
    throw new Error('That file is not a valid EPUB (could not read its archive).');
  }
  const decoder = new TextDecoder();
  const text = (path: string): string => {
    const entry = files[path];
    if (!entry) throw new Error(`EPUB is missing ${path}`);
    return decoder.decode(entry);
  };

  const container = parseXml(text('META-INF/container.xml'));
  const opfPath = container.querySelector('rootfile')?.getAttribute('full-path');
  if (!opfPath || !files[opfPath]) throw new Error('EPUB has no readable package document');
  const opf = parseXml(text(opfPath));
  const opfDir = dirname(opfPath);

  const manifest = new Map<string, { path: string; mediaType: string }>();
  const mediaTypes = new Map<string, string>();
  for (const item of opf.querySelectorAll('manifest > item')) {
    const id = item.getAttribute('id');
    const href = item.getAttribute('href');
    if (!id || !href) continue;
    const path = resolveHref(opfDir ? `${opfDir}/x` : 'x', href);
    const mediaType = item.getAttribute('media-type') ?? '';
    manifest.set(id, { path, mediaType });
    mediaTypes.set(path, mediaType);
  }

  const chapters: { path: string }[] = [];
  for (const ref of opf.querySelectorAll('spine > itemref')) {
    const item = manifest.get(ref.getAttribute('idref') ?? '');
    if (item && files[item.path] && /x?html/i.test(item.mediaType)) {
      chapters.push({ path: item.path });
    }
  }
  if (chapters.length === 0) throw new Error('EPUB has no readable chapters');

  const title =
    opf.getElementsByTagNameNS('http://purl.org/dc/elements/1.1/', 'title')[0]?.textContent?.trim() ||
    null;

  return {
    title,
    chapters,
    rawChapter: (index) => text(chapters[index]!.path),
    resource: (path) => files[path] ?? null,
    mediaType: (path) => mediaTypes.get(path),
  };
}

// ---- open-document cache, mirroring pdf.ts

const open = new Map<string, EpubDoc>();

/** Open (and cache) an EPUB by content hash. Throws if it does not parse. */
export function openEpub(sha256: string, bytes: ArrayBuffer): EpubDoc {
  let doc = open.get(sha256);
  if (!doc) {
    doc = parseEpub(bytes);
    open.set(sha256, doc);
  }
  return doc;
}

export function closeEpub(sha256: string): void {
  open.delete(sha256);
}

// ---- chapter sanitization

const DROP_TAGS = new Set([
  'script',
  'style',
  'link',
  'meta',
  'base',
  'title',
  'iframe',
  'object',
  'embed',
  'form',
  'input',
  'button',
  'select',
  'textarea',
  'video',
  'audio',
  'source',
  'track',
  'svg',
  'math',
  'noscript',
]);
const KEEP_ATTRS = new Set(['alt', 'title', 'colspan', 'rowspan', 'dir', 'lang']);

/**
 * Render a chapter's markup into `target`: scripts/styles/embeds stripped, all
 * attributes dropped except a small allowlist, images rewritten to object URLs
 * backed by the EPUB's own resources (remote images are removed). Returns a
 * cleanup that revokes those object URLs.
 */
export function renderChapterInto(epub: EpubDoc, index: number, target: HTMLElement): () => void {
  const chapterPath = epub.chapters[index]!.path;
  const parsed = new DOMParser().parseFromString(epub.rawChapter(index), 'text/html');
  const objectUrls: string[] = [];

  for (const el of Array.from(parsed.body.querySelectorAll('*'))) {
    if (DROP_TAGS.has(el.localName)) {
      el.remove();
      continue;
    }
    const src = el.localName === 'img' ? el.getAttribute('src') : null;
    const kept = Array.from(el.attributes)
      .filter((a) => KEEP_ATTRS.has(a.name))
      .map((a) => [a.name, a.value] as const);
    for (const attr of Array.from(el.attributes)) el.removeAttribute(attr.name);
    for (const [name, value] of kept) el.setAttribute(name, value);

    if (el.localName === 'img') {
      // Only images shipped inside the EPUB survive, served via object URLs.
      const local = src && !/^[a-z][a-z0-9+.-]*:/i.test(src) ? epub.resource(resolveHref(chapterPath, src)) : null;
      if (!local) {
        el.remove();
        continue;
      }
      const blob = new Blob([local.slice().buffer as ArrayBuffer], {
        type: epub.mediaType(resolveHref(chapterPath, src!)) || 'application/octet-stream',
      });
      const url = URL.createObjectURL(blob);
      objectUrls.push(url);
      el.setAttribute('src', url);
    }
  }

  target.replaceChildren(...Array.from(parsed.body.childNodes).map((n) => document.importNode(n, true)));
  return () => {
    for (const url of objectUrls) URL.revokeObjectURL(url);
  };
}
