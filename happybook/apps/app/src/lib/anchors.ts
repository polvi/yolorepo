import type { Anchor, Rect, TextAnchor } from '@happybook/shared';

const CONTEXT_CHARS = 32;

/**
 * Built once per rendered page from the pdf.js text layer: the page's
 * concatenated text plus the mapping from char offsets to text-layer spans.
 */
export interface PageTextIndex {
  page: number;
  text: string;
  spanStarts: number[];
  spans: HTMLElement[];
}

export function buildPageTextIndex(
  page: number,
  items: { str: string }[],
  textDivs: HTMLElement[],
): PageTextIndex {
  const spanStarts: number[] = [];
  let text = '';
  for (const item of items) {
    spanStarts.push(text.length);
    text += item.str;
  }
  return { page, text, spanStarts, spans: textDivs };
}

function spanEnd(index: PageTextIndex, spanIdx: number): number {
  return index.spanStarts[spanIdx]! + (index.spans[spanIdx]!.textContent?.length ?? 0);
}

function globalOffset(
  index: PageTextIndex,
  node: Node,
  nodeOffset: number,
  side: 'start' | 'end',
): number | null {
  if (node.nodeType === Node.TEXT_NODE) {
    const el = node.parentElement;
    if (!el) return null;
    const spanIdx = index.spans.indexOf(el);
    if (spanIdx === -1) return null;
    return index.spanStarts[spanIdx]! + nodeOffset;
  }
  const el = node as HTMLElement;
  const asSpan = index.spans.indexOf(el);
  if (asSpan !== -1) {
    // The span element itself: snap to its start or end.
    return nodeOffset > 0 ? spanEnd(index, asSpan) : index.spanStarts[asSpan]!;
  }
  // A container (e.g. the text layer div): nodeOffset is a child index. For a
  // range end, snap to the end of the nearest span before the boundary; for a
  // start, to the start of the nearest span at or after it.
  const children = Array.from(el.childNodes);
  if (side === 'end') {
    for (let i = Math.min(nodeOffset, children.length) - 1; i >= 0; i--) {
      const idx = index.spans.indexOf(children[i] as HTMLElement);
      if (idx !== -1) return spanEnd(index, idx);
    }
    return null;
  }
  for (let i = nodeOffset; i < children.length; i++) {
    const idx = index.spans.indexOf(children[i] as HTMLElement);
    if (idx !== -1) return index.spanStarts[idx]!;
  }
  return null;
}

/** Convert client rects to scale-1 PDF page space relative to the page element. */
export function clientRectsToPageRects(
  rects: DOMRectList | DOMRect[],
  pageEl: HTMLElement,
  scale: number,
): Rect[] {
  const pageBox = pageEl.getBoundingClientRect();
  const out: Rect[] = [];
  for (const r of Array.from(rects)) {
    if (r.width < 1 || r.height < 1) continue;
    out.push({
      x: (r.left - pageBox.left) / scale,
      y: (r.top - pageBox.top) / scale,
      w: r.width / scale,
      h: r.height / scale,
    });
  }
  return mergeLineRects(out);
}

/** Merge fragments that sit on the same visual line into one rect. */
function mergeLineRects(rects: Rect[]): Rect[] {
  const sorted = [...rects].sort((a, b) => a.y - b.y || a.x - b.x);
  const merged: Rect[] = [];
  for (const r of sorted) {
    const prev = merged[merged.length - 1];
    const sameLine = prev && Math.abs(prev.y - r.y) < Math.min(prev.h, r.h) * 0.5;
    if (prev && sameLine && r.x <= prev.x + prev.w + 4) {
      const right = Math.max(prev.x + prev.w, r.x + r.w);
      const bottom = Math.max(prev.y + prev.h, r.y + r.h);
      prev.y = Math.min(prev.y, r.y);
      prev.w = right - prev.x;
      prev.h = bottom - prev.y;
    } else {
      merged.push({ ...r });
    }
  }
  return merged;
}

/** Build a TextAnchor from the current DOM selection on a rendered page. */
export function anchorFromSelection(
  range: Range,
  index: PageTextIndex,
  pageEl: HTMLElement,
  scale: number,
): TextAnchor | null {
  const start = globalOffset(index, range.startContainer, range.startOffset, 'start');
  const end = globalOffset(index, range.endContainer, range.endOffset, 'end');
  if (start == null || end == null || end <= start) return null;

  const rects = clientRectsToPageRects(range.getClientRects(), pageEl, scale);
  if (rects.length === 0) return null;

  return {
    kind: 'text',
    page: index.page,
    quote: index.text.slice(start, end),
    prefix: index.text.slice(Math.max(0, start - CONTEXT_CHARS), start),
    suffix: index.text.slice(end, end + CONTEXT_CHARS),
    start,
    end,
    rects,
  };
}

/**
 * Layered resolution: exact offsets → quote search scored by prefix/suffix →
 * null (caller falls back to the stored rects, which still draw correctly).
 */
export function resolveTextAnchor(
  anchor: TextAnchor,
  pageText: string,
): { start: number; end: number } | null {
  if (pageText.slice(anchor.start, anchor.end) === anchor.quote) {
    return { start: anchor.start, end: anchor.end };
  }
  if (anchor.quote.length === 0) return null;

  let best: { start: number; score: number } | null = null;
  let from = 0;
  while (true) {
    const at = pageText.indexOf(anchor.quote, from);
    if (at === -1) break;
    const prefix = pageText.slice(Math.max(0, at - CONTEXT_CHARS), at);
    const suffix = pageText.slice(at + anchor.quote.length, at + anchor.quote.length + CONTEXT_CHARS);
    const score =
      sharedSuffixLen(prefix, anchor.prefix) +
      sharedPrefixLen(suffix, anchor.suffix) -
      Math.abs(at - anchor.start) / Math.max(pageText.length, 1);
    if (!best || score > best.score) best = { start: at, score };
    from = at + 1;
  }
  return best ? { start: best.start, end: best.start + anchor.quote.length } : null;
}

function sharedSuffixLen(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

function sharedPrefixLen(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

/** DOM range for resolved offsets (used to re-derive rects after text drift). */
export function rangeForOffsets(index: PageTextIndex, start: number, end: number): Range | null {
  const locate = (offset: number, preferEnd: boolean): { node: Node; offset: number } | null => {
    for (let i = index.spanStarts.length - 1; i >= 0; i--) {
      const base = index.spanStarts[i]!;
      const span = index.spans[i]!;
      const len = span.textContent?.length ?? 0;
      const within = preferEnd ? offset > base && offset <= base + len : offset >= base && offset < base + len;
      if (within && span.firstChild) {
        return { node: span.firstChild, offset: Math.min(offset - base, len) };
      }
    }
    return null;
  };
  const s = locate(start, false);
  const e = locate(end, true);
  if (!s || !e) return null;
  const range = document.createRange();
  range.setStart(s.node, s.offset);
  range.setEnd(e.node, e.offset);
  return range;
}

export function anchorPage(anchor: Anchor): number {
  return anchor.page;
}

export function anchorTopY(anchor: Anchor): number {
  switch (anchor.kind) {
    case 'text':
      return anchor.rects[0]?.y ?? 0;
    case 'region':
      return anchor.rect.y;
    case 'point':
      return anchor.y;
  }
}

export function describeAnchor(anchor: Anchor): string {
  if (anchor.kind === 'text' && anchor.quote) {
    const q = anchor.quote.trim();
    return q.length > 80 ? `${q.slice(0, 77)}…` : q;
  }
  return `page ${anchor.page}`;
}
