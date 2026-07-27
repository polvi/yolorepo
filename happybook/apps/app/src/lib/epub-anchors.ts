import type { Rect, TextAnchor } from '@happybook/shared';

const CONTEXT_CHARS = 32;

/**
 * Built once per rendered chapter: the chapter's concatenated text plus the
 * mapping from char offsets to DOM text nodes. The EPUB counterpart of
 * anchors.ts's PageTextIndex, over arbitrary nested markup instead of the
 * flat pdf.js text layer.
 */
export interface ChapterTextIndex {
  chapter: number; // 1-based spine index
  text: string;
  starts: number[];
  nodes: Text[];
}

export function buildChapterTextIndex(chapter: number, root: HTMLElement): ChapterTextIndex {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const starts: number[] = [];
  const nodes: Text[] = [];
  let text = '';
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text;
    starts.push(text.length);
    text += t.data;
    nodes.push(t);
  }
  return { chapter, text, starts, nodes };
}

/** Char offset of a DOM boundary point within the chapter's concatenated text. */
function globalOffset(index: ChapterTextIndex, node: Node, nodeOffset: number): number | null {
  if (node.nodeType === Node.TEXT_NODE) {
    const i = index.nodes.indexOf(node as Text);
    return i === -1 ? null : index.starts[i]! + nodeOffset;
  }
  const probe = document.createRange();
  try {
    probe.setStart(node, nodeOffset);
  } catch {
    return null;
  }
  probe.collapse(true);
  // Nodes are in document order: count every text node that ends at or before
  // the boundary; the first one past it stops the scan.
  let total = 0;
  for (let i = 0; i < index.nodes.length; i++) {
    const t = index.nodes[i]!;
    try {
      if (probe.comparePoint(t, t.data.length) <= 0) total = index.starts[i]! + t.data.length;
      else break;
    } catch {
      return null;
    }
  }
  return total;
}

/** Convert client rects to coordinates relative to the chapter element. */
export function clientRectsToChapterRects(rects: DOMRectList | DOMRect[], chapterEl: HTMLElement): Rect[] {
  const box = chapterEl.getBoundingClientRect();
  const out: Rect[] = [];
  for (const r of Array.from(rects)) {
    if (r.width < 1 || r.height < 1) continue;
    const rect = { x: r.left - box.left, y: r.top - box.top, w: r.width, h: r.height };
    const prev = out[out.length - 1];
    // Merge fragments on the same visual line (nested inline elements split rects).
    if (prev && Math.abs(prev.y - rect.y) < Math.min(prev.h, rect.h) * 0.5 && rect.x <= prev.x + prev.w + 4) {
      const right = Math.max(prev.x + prev.w, rect.x + rect.w);
      const bottom = Math.max(prev.y + prev.h, rect.y + rect.h);
      prev.y = Math.min(prev.y, rect.y);
      prev.w = right - prev.x;
      prev.h = bottom - prev.y;
    } else {
      out.push(rect);
    }
  }
  return out;
}

/**
 * Build a TextAnchor from a selection inside a rendered chapter. Stored rects
 * are empty by design: reflowable content re-derives geometry from offsets.
 */
export function epubAnchorFromSelection(range: Range, index: ChapterTextIndex): TextAnchor | null {
  const start = globalOffset(index, range.startContainer, range.startOffset);
  const end = globalOffset(index, range.endContainer, range.endOffset);
  if (start == null || end == null || end <= start) return null;
  return {
    kind: 'text',
    page: index.chapter,
    quote: index.text.slice(start, end),
    prefix: index.text.slice(Math.max(0, start - CONTEXT_CHARS), start),
    suffix: index.text.slice(end, end + CONTEXT_CHARS),
    start,
    end,
    rects: [],
  };
}

/** DOM range for resolved offsets, for drawing overlays and jump targets. */
export function epubRangeForOffsets(index: ChapterTextIndex, start: number, end: number): Range | null {
  const locate = (offset: number, preferEnd: boolean): { node: Text; offset: number } | null => {
    for (let i = index.nodes.length - 1; i >= 0; i--) {
      const base = index.starts[i]!;
      const len = index.nodes[i]!.data.length;
      const within = preferEnd ? offset > base && offset <= base + len : offset >= base && offset < base + len;
      if (within) return { node: index.nodes[i]!, offset: Math.min(offset - base, len) };
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
