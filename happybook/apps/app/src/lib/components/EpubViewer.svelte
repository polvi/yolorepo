<script lang="ts">
  import { liveQuery } from 'dexie';
  import type { Anchor, TextAnchor } from '@happybook/shared';
  import { db, addHighlight, softDelete, type LocalDocument, type LocalHighlight, type LocalLink } from '$lib/db';
  import { blobStore } from '$lib/blobstore';
  import { ensureBlobLocal, syncState } from '$lib/sync-client';
  import { openEpub, type EpubDoc } from '$lib/epub';
  import { epubAnchorFromSelection, epubRangeForOffsets, type ChapterTextIndex } from '$lib/epub-anchors';
  import { resolveTextAnchor } from '$lib/anchors';
  import { pinch } from '$lib/pinch';
  import { immersive } from '$lib/ui';
  import EpubChapter from './EpubChapter.svelte';
  import SelectionPopover from './SelectionPopover.svelte';

  let {
    doc,
    linkArmed = false,
    initialView = null,
    initialPosition = null,
    jumpTo = null,
    onJumped,
    onPositionChange,
    onLinkSource,
    onLinkTarget,
    onNavigateLink,
  }: {
    doc: LocalDocument;
    linkArmed?: boolean;
    initialView?: { scrollTop: number; scale: number } | null;
    /** Synced reading position; applies only when no in-session view state exists. */
    initialPosition?: { page?: number; percentage?: number } | null;
    /** Pending link jump, passed declaratively so it survives {#key} remounts. */
    jumpTo?: Anchor | null;
    onJumped?: () => void;
    onPositionChange?: (pos: { percentage: number }) => void;
    onLinkSource: (anchor: Anchor) => void;
    onLinkTarget: (anchor: Anchor) => void;
    onNavigateLink: (link: LocalLink, clickedSide: 'source' | 'target') => void;
  } = $props();

  let container: HTMLDivElement | undefined = $state();
  let bookEl: HTMLDivElement | undefined = $state();
  let epub = $state<EpubDoc | null>(null);
  let loadError = $state<string | null>(null);
  // Font scale reuses the view-state `scale` slot the workspace already keeps.
  // svelte-ignore state_referenced_locally
  let fontScale = $state(clampScale(initialView?.scale ?? 1));
  let viewH = $state(0);
  let viewW = $state(0);
  let missingBlob = $state(false);
  let downloading = $state(false);
  let popover = $state<{ x: number; y: number; anchor: TextAnchor } | null>(null);
  let flash = $state<{ chapter: number; anchor: Anchor } | null>(null);
  let flashTimer: ReturnType<typeof setTimeout> | undefined;

  const textIndexes = new Map<number, { index: ChapterTextIndex; chapterEl: HTMLElement }>();
  let chapterWaiters: { chapter: number; resolve: (entry: { index: ChapterTextIndex; chapterEl: HTMLElement }) => void }[] = [];

  let highlights = $state<LocalHighlight[]>([]);
  let links = $state<LocalLink[]>([]);

  $effect(() => {
    const sub = liveQuery(() =>
      db.highlights.where('documentId').equals(doc.id).filter((h) => h.deleted === 0).toArray(),
    ).subscribe((v) => (highlights = v));
    return () => sub.unsubscribe();
  });

  $effect(() => {
    const docId = doc.id;
    const sub = liveQuery(() =>
      db.links
        .where('fromDocumentId')
        .equals(docId)
        .or('toDocumentId')
        .equals(docId)
        .filter((l) => l.deleted === 0)
        .toArray(),
    ).subscribe((v) => (links = v));
    return () => sub.unsubscribe();
  });

  $effect(() => {
    void load(doc.sha256);
  });

  let loadedSha: string | null = null;

  async function load(sha256: string) {
    // The doc prop's identity churns with every liveQuery emission; reloading
    // the same book would wipe chapter registrations without remounting the
    // chapters (openEpub returns a cached object), so bail when already open.
    if (epub && loadedSha === sha256) return;
    epub = null;
    loadError = null;
    missingBlob = false;
    const bytes = await blobStore.get(sha256);
    if (!bytes) {
      missingBlob = true;
      void downloadBlob(); // try to fetch right away; the card is the fallback
      return;
    }
    try {
      epub = openEpub(sha256, bytes);
      loadedSha = sha256;
    } catch (err) {
      loadError = err instanceof Error ? err.message : 'Could not open this EPUB.';
      return;
    }
    if (initialView) {
      // Chapters render on mount; restore the reading spot on the next frame.
      requestAnimationFrame(() => {
        if (container && !suppressRestore) container.scrollTop = initialView.scrollTop;
      });
    } else if (initialPosition) {
      // Synced position. Percentage is the only cross-renderer unit an EPUB
      // has (KOReader positions are CRengine xpointers the web cannot read).
      requestAnimationFrame(() => {
        if (!container || suppressRestore) return;
        const max = container.scrollHeight - container.clientHeight;
        container.scrollTop = (initialPosition.percentage ?? 0) * Math.max(0, max);
      });
    }
  }

  /** Read by the workspace before a tab switch so the spot survives remounts. */
  export function getViewState(): { scrollTop: number; scale: number } {
    return { scrollTop: container?.scrollTop ?? 0, scale: fontScale };
  }

  /** Reading position in kosync terms: fraction of the book scrolled. */
  export function getPosition(): { percentage: number } {
    if (!container) return { percentage: 0 };
    const max = container.scrollHeight - container.clientHeight;
    return { percentage: max > 0 ? Math.min(1, Math.max(0, container.scrollTop / max)) : 0 };
  }

  async function downloadBlob() {
    if (downloading) return;
    downloading = true;
    const ok = await ensureBlobLocal(doc.sha256);
    downloading = false;
    if (ok) {
      missingBlob = false;
      void load(doc.sha256);
    }
  }

  // A sync pass may have downloaded this book (new-device fill-in): whenever
  // sync goes idle while we're showing the missing card, look again.
  $effect(() => {
    if (missingBlob && !downloading && $syncState === 'idle') {
      void blobStore.has(doc.sha256).then((present) => {
        if (present) {
          missingBlob = false;
          void load(doc.sha256);
        }
      });
    }
  });

  function clampScale(s: number): number {
    return Math.min(1.6, Math.max(0.7, Math.round(s * 10) / 10));
  }

  function zoom(delta: number) {
    fontScale = clampScale(fontScale + delta);
    popover = null;
  }

  // ---- pinch: live CSS preview, committed as a font-size change at the end

  function effectiveRatio(ratio: number): number {
    return clampScale(fontScale * ratio) / fontScale;
  }

  function pinchLive(ratio: number, focal: { x: number; y: number }) {
    if (!bookEl || !container) return;
    popover = null;
    const r = effectiveRatio(ratio);
    bookEl.style.transformOrigin = `50% ${container.scrollTop + focal.y}px`;
    bookEl.style.transform = `scale(${r})`;
  }

  function pinchEnd(ratio: number, focal: { x: number; y: number }) {
    if (!bookEl || !container) return;
    const r = effectiveRatio(ratio);
    bookEl.style.transform = '';
    bookEl.style.transformOrigin = '';
    const y = container.scrollTop;
    fontScale = clampScale(fontScale * ratio);
    requestAnimationFrame(() => {
      if (!container) return;
      // Text height tracks font size roughly linearly; keep the focal line put.
      container.scrollTop = (y + focal.y) * r - focal.y;
    });
  }

  // ---- annotation marks per chapter

  const highlightsByChapter = $derived.by(() => {
    const map = new Map<number, { id: string; color: string; anchor: TextAnchor }[]>();
    for (const h of highlights) {
      const ch = h.anchor.page;
      if (!map.has(ch)) map.set(ch, []);
      map.get(ch)!.push({ id: h.id, color: h.color, anchor: h.anchor });
    }
    return map;
  });

  const linksByChapter = $derived.by(() => {
    const map = new Map<number, { linkId: string; kind: 'source' | 'target'; anchor: Anchor }[]>();
    const push = (linkId: string, kind: 'source' | 'target', anchor: Anchor) => {
      if (!map.has(anchor.page)) map.set(anchor.page, []);
      map.get(anchor.page)!.push({ linkId, kind, anchor });
    };
    for (const l of links) {
      if (l.fromDocumentId === doc.id) push(l.id, 'source', l.fromAnchor);
      if (l.toDocumentId === doc.id) push(l.id, 'target', l.toAnchor);
    }
    return map;
  });

  // ---- selection & clicks

  function computeSelectionPopover(): { x: number; y: number; anchor: TextAnchor } | null {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0);
    const chapterEl = (range.startContainer.parentElement ?? null)?.closest?.(
      '[data-chapter]',
    ) as HTMLElement | null;
    if (!chapterEl || !container || !container.contains(chapterEl)) return null;
    // Cross-chapter selections have no single anchor; ignore them.
    if (!chapterEl.contains(range.endContainer)) return null;
    const entry = textIndexes.get(Number(chapterEl.dataset.chapter));
    if (!entry) return null;
    const anchor = epubAnchorFromSelection(range, entry.index);
    if (!anchor) return null;

    const rect = range.getBoundingClientRect();
    const box = container.getBoundingClientRect();
    // Clamp (in viewport terms) so the popover stays reachable on narrow
    // phone viewports, then shift into the container's scrolled content
    // space, which is what `position: absolute` coordinates address.
    return {
      x:
        Math.min(Math.max(rect.left + rect.width / 2 - box.left, 100), Math.max(viewW - 100, 100)) +
        container.scrollLeft,
      y: Math.max(rect.top - box.top, 48) + container.scrollTop,
      anchor,
    };
  }

  function refreshPopoverFromSelection() {
    const next = computeSelectionPopover();
    if (next) popover = next;
  }

  function handlePointerUp() {
    setTimeout(refreshPopoverFromSelection, 0);
  }

  // iOS long-press selection (and handle-dragging) never fires a matching
  // pointerup on the text; selectionchange is how those selections arrive.
  let selectionTimer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    const onSelectionChange = () => {
      clearTimeout(selectionTimer);
      selectionTimer = setTimeout(refreshPopoverFromSelection, 350);
    };
    document.addEventListener('selectionchange', onSelectionChange);
    return () => {
      document.removeEventListener('selectionchange', onSelectionChange);
      clearTimeout(selectionTimer);
    };
  });

  function completeArmedLink() {
    if (!popover) return;
    const anchor = $state.snapshot(popover.anchor) as Anchor;
    window.getSelection()?.removeAllRanges();
    popover = null;
    onLinkTarget(anchor);
  }

  function handleLinkClick(linkId: string, kind: 'source' | 'target') {
    const link = links.find((l) => l.id === linkId);
    if (link) onNavigateLink(link, kind);
  }

  async function applyHighlight(color: string) {
    if (!popover) return;
    // $state proxies cannot be structured-cloned into IndexedDB; snapshot first.
    const anchor = $state.snapshot(popover.anchor) as TextAnchor;
    await addHighlight(doc.notebookId, doc.id, anchor, color);
    window.getSelection()?.removeAllRanges();
    popover = null;
  }

  /** Tombstone every highlight whose text range overlaps the selection. */
  async function clearHighlightsUnder() {
    if (!popover) return;
    const sel = popover.anchor;
    const overlapping = highlights.filter(
      (h) => h.anchor.page === sel.page && h.anchor.start < sel.end && h.anchor.end > sel.start,
    );
    for (const h of overlapping) await softDelete('highlights', h.id);
    window.getSelection()?.removeAllRanges();
    popover = null;
  }

  function startLink() {
    if (!popover) return;
    onLinkSource($state.snapshot(popover.anchor) as Anchor);
    window.getSelection()?.removeAllRanges();
    popover = null;
  }

  // ---- programmatic navigation

  let suppressRestore = false;

  function handleTextIndex(chapter: number, index: ChapterTextIndex, chapterEl: HTMLElement) {
    textIndexes.set(chapter, { index, chapterEl });
    chapterWaiters = chapterWaiters.filter((w) => {
      if (w.chapter !== chapter) return true;
      w.resolve({ index, chapterEl });
      return false;
    });
  }

  function whenChapterReady(
    chapter: number,
  ): Promise<{ index: ChapterTextIndex; chapterEl: HTMLElement } | null> {
    const entry = textIndexes.get(chapter);
    if (entry) return Promise.resolve(entry);
    // Times out instead of hanging when the anchor's chapter never renders
    // (deleted blob, out-of-range chapter from a divergent replica).
    return Promise.race([
      new Promise<{ index: ChapterTextIndex; chapterEl: HTMLElement }>((resolve) =>
        chapterWaiters.push({ chapter, resolve }),
      ),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 8000)),
    ]);
  }

  // The jump arrives as a prop (not an imperative call) so that a jump into a
  // freshly remounted viewer cannot land on the dying instance.
  $effect(() => {
    const target = jumpTo;
    if (!target) return;
    suppressRestore = true; // synchronous: beats load()'s restore rAF
    void scrollToAnchor(target).then(() => onJumped?.());
  });

  async function scrollToAnchor(anchor: Anchor): Promise<void> {
    suppressRestore = true;
    const entry = await whenChapterReady(anchor.page);
    if (!entry || !container) return;
    const { index, chapterEl } = entry;

    // Text anchors land on their resolved range; anything else (or a quote
    // that no longer resolves) falls back to the top of the chapter.
    let targetTop: number | null = null;
    if (anchor.kind === 'text') {
      const resolved = resolveTextAnchor(anchor, index.text);
      const range = resolved ? epubRangeForOffsets(index, resolved.start, resolved.end) : null;
      const rect = range?.getBoundingClientRect();
      if (rect && rect.height > 0) {
        targetTop = rect.top - container.getBoundingClientRect().top + container.scrollTop;
      }
    }
    if (targetTop == null) {
      targetTop = chapterEl.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
    }
    container.scrollTo({ top: Math.max(0, targetTop - viewH / 3), behavior: 'smooth' });

    flash = { chapter: anchor.page, anchor: $state.snapshot(anchor) as Anchor };
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => (flash = null), 1800);
  }
</script>

<div class="viewer-wrap">
  {#if !$immersive}
    <div class="toolbar">
      <span class="doc-title" title={doc.title}>{doc.title}</span>
      <span class="spacer"></span>
      <button onclick={() => zoom(-0.1)} aria-label="Smaller text">A−</button>
      <span class="zoom">{Math.round(fontScale * 100)}%</span>
      <button onclick={() => zoom(0.1)} aria-label="Larger text">A+</button>
      <button onclick={() => immersive.set(true)} aria-label="Full screen" title="Full screen">⛶</button>
    </div>
  {:else}
    <button class="exit-fs" onclick={() => immersive.set(false)} aria-label="Exit full screen" title="Exit full screen">
      ⛶
    </button>
  {/if}

  {#if missingBlob}
    <div class="missing">
      <p><strong>{doc.title}</strong></p>
      <p>{(doc.size / (1024 * 1024)).toFixed(1)} MB — not on this device yet.</p>
      <button onclick={downloadBlob} disabled={downloading}>
        {downloading ? 'Downloading…' : 'Download'}
      </button>
    </div>
  {:else if loadError}
    <div class="missing"><p>{loadError}</p></div>
  {:else}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="viewer"
      bind:this={container}
      bind:clientHeight={viewH}
      bind:clientWidth={viewW}
      use:pinch={{ onLive: pinchLive, onEnd: pinchEnd }}
      onscroll={() => {
        popover = null;
        onPositionChange?.(getPosition());
      }}
      onpointerup={handlePointerUp}
      class:armed={linkArmed}
    >
      {#if epub}
        <div class="book" bind:this={bookEl} style={`font-size:calc(1.02rem * ${fontScale});`}>
          {#each epub.chapters as _, i (i)}
            <EpubChapter
              {epub}
              chapterNumber={i + 1}
              highlights={highlightsByChapter.get(i + 1) ?? []}
              links={linksByChapter.get(i + 1) ?? []}
              flashAnchor={flash?.chapter === i + 1 ? flash.anchor : null}
              onTextIndex={handleTextIndex}
              onLinkClick={handleLinkClick}
            />
          {/each}
        </div>
      {/if}
      {#if popover}
        <SelectionPopover
          x={popover.x}
          y={popover.y}
          armed={linkArmed}
          onHighlight={applyHighlight}
          onClear={clearHighlightsUnder}
          onLink={linkArmed ? completeArmedLink : startLink}
        />
      {/if}
    </div>
  {/if}
</div>

<style>
  .viewer-wrap {
    position: relative; /* anchors the floating exit-fullscreen button */
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  .toolbar {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.35rem 0.75rem;
    border-bottom: 1px solid var(--rule);
    background: var(--card);
    font-size: 0.85rem;
  }
  .doc-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 600;
  }
  .spacer {
    flex: 1;
  }
  .toolbar button {
    background: none;
    border: 1px solid var(--rule);
    border-radius: 0.35rem;
    padding: 0.15rem 0.55rem;
    cursor: pointer;
    color: inherit;
  }
  .zoom {
    min-width: 3.2rem;
    text-align: center;
    color: var(--muted);
  }
  .viewer {
    position: relative;
    flex: 1;
    overflow: auto;
    background: var(--well);
    min-height: 0;
    /* Panning stays native; pinches are ours (font zoom, not page zoom). */
    touch-action: pan-x pan-y;
  }
  .exit-fs {
    position: absolute;
    top: 0.6rem;
    right: 0.9rem;
    z-index: 25;
    width: 2.2rem;
    height: 2.2rem;
    border-radius: 50%;
    border: 1px solid var(--rule);
    background: var(--card);
    color: var(--muted);
    opacity: 0.75;
    cursor: pointer;
    font-size: 1rem;
  }
  .exit-fs:hover {
    opacity: 1;
  }
  .viewer.armed {
    cursor: crosshair;
  }
  .book {
    max-width: 42rem;
    margin: 0 auto;
    padding: 2rem 1.25rem 5rem;
    background: var(--card);
    min-height: 100%;
    font-family: Georgia, 'Times New Roman', serif;
  }
  /* Chapters are separate component instances; the sibling rule lives here. */
  .book :global([data-chapter] + [data-chapter]) {
    border-top: 1px solid var(--rule);
    margin-top: 2.2rem;
    padding-top: 2.2rem;
  }
  .missing {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    color: var(--muted);
  }
  .missing button {
    background: var(--accent);
    color: #fff;
    border: none;
    border-radius: 0.4rem;
    padding: 0.5rem 1.1rem;
    cursor: pointer;
    font-weight: 600;
  }
  @media (max-width: 560px) {
    .doc-title {
      display: none; /* the active tab already names the document */
    }
    .toolbar {
      justify-content: flex-end;
      padding: 0.3rem 0.5rem;
    }
  }
</style>
