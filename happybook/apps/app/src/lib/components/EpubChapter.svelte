<script lang="ts">
  import type { Anchor, Rect, TextAnchor } from '@happybook/shared';
  import { resolveTextAnchor } from '$lib/anchors';
  import { renderChapterInto, type EpubDoc } from '$lib/epub';
  import {
    buildChapterTextIndex,
    clientRectsToChapterRects,
    epubRangeForOffsets,
    type ChapterTextIndex,
  } from '$lib/epub-anchors';
  import AnnotationLayer, { type HighlightMark, type LinkMark } from './AnnotationLayer.svelte';

  let {
    epub,
    chapterNumber,
    highlights = [],
    links = [],
    flashAnchor = null,
    onTextIndex,
    onLinkClick,
  }: {
    epub: EpubDoc;
    chapterNumber: number; // 1-based spine index
    highlights?: { id: string; color: string; anchor: TextAnchor }[];
    links?: { linkId: string; kind: 'source' | 'target'; anchor: Anchor }[];
    flashAnchor?: Anchor | null;
    onTextIndex?: (chapter: number, index: ChapterTextIndex, chapterEl: HTMLElement) => void;
    onLinkClick?: (linkId: string, kind: 'source' | 'target') => void;
  } = $props();

  let chapterEl: HTMLDivElement | undefined = $state();
  let contentEl: HTMLDivElement | undefined = $state();
  let index = $state<ChapterTextIndex | null>(null);
  let w = $state(0);
  let h = $state(0);

  $effect(() => {
    if (!contentEl || !chapterEl) return;
    const cleanup = renderChapterInto(epub, chapterNumber - 1, contentEl);
    const built = buildChapterTextIndex(chapterNumber, contentEl);
    index = built;
    onTextIndex?.(chapterNumber, built, chapterEl);
    return cleanup;
  });

  /** Offsets → live rects. Reads layout, so callers re-run on w/h changes. */
  function rectsFor(anchor: Anchor): Rect[] {
    if (!index || !chapterEl || anchor.kind !== 'text') return [];
    const resolved = resolveTextAnchor(anchor, index.text);
    if (!resolved) return [];
    const range = epubRangeForOffsets(index, resolved.start, resolved.end);
    return range ? clientRectsToChapterRects(range.getClientRects(), chapterEl) : [];
  }

  // w/h are read so font-size changes and reflows recompute the overlays.
  const highlightMarks = $derived.by((): HighlightMark[] => {
    void w, h;
    return highlights.map((hl) => ({ key: hl.id, color: hl.color, rects: rectsFor(hl.anchor) }));
  });

  const linkMarks = $derived.by((): LinkMark[] => {
    void w, h;
    return links.map((l) => ({
      key: `${l.linkId}:${l.kind}`,
      linkId: l.linkId,
      kind: l.kind,
      rects: rectsFor(l.anchor),
    }));
  });

  const flashRects = $derived.by((): Rect[] => {
    void w, h;
    return flashAnchor ? rectsFor(flashAnchor) : [];
  });
</script>

<div
  bind:this={chapterEl}
  class="chapter"
  data-chapter={chapterNumber}
  bind:clientWidth={w}
  bind:clientHeight={h}
>
  <div bind:this={contentEl} class="content"></div>
  {#if w > 0 && h > 0}
    <AnnotationLayer width={w} height={h} scale={1} highlights={highlightMarks} {linkMarks} {flashRects} {onLinkClick} />
  {/if}
</div>

<style>
  .chapter {
    position: relative;
  }
  /* Book typography for whatever markup the EPUB brought along. */
  .content {
    line-height: 1.65;
    overflow-wrap: break-word;
  }
  .content :global(h1),
  .content :global(h2),
  .content :global(h3) {
    line-height: 1.25;
  }
  .content :global(img) {
    max-width: 100%;
    height: auto;
    display: block;
    margin: 1rem auto;
  }
  .content :global(table) {
    border-collapse: collapse;
    max-width: 100%;
  }
  .content :global(td),
  .content :global(th) {
    border: 1px solid var(--rule);
    padding: 0.25rem 0.5rem;
  }
  .content :global(blockquote) {
    border-left: 3px solid var(--rule);
    margin-left: 0;
    padding-left: 1rem;
    color: var(--muted);
  }
  .content :global(pre) {
    overflow-x: auto;
  }
  .content :global(::selection) {
    background: rgba(64, 116, 230, 0.35);
  }
</style>
