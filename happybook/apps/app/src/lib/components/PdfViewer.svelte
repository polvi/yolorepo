<script lang="ts">
  import { liveQuery } from 'dexie';
  import type { Anchor, Rect, TextAnchor } from '@happybook/shared';
  import { db, addHighlight, softDelete, type LocalDocument, type LocalHighlight, type LocalLink } from '$lib/db';
  import { blobStore } from '$lib/blobstore';
  import { ensureBlobLocal, syncState } from '$lib/sync-client';
  import { openPdf, type PDFDocumentProxy } from '$lib/pdf';
  import { anchorFromSelection, anchorPage, anchorTopY, type PageTextIndex } from '$lib/anchors';
  import { pinch } from '$lib/pinch';
  import { immersive } from '$lib/ui';
  import PdfPage from './PdfPage.svelte';
  import SelectionPopover from './SelectionPopover.svelte';
  import type { HighlightMark, LinkMark } from './AnnotationLayer.svelte';

  const GAP = 14;
  const OVERSCAN = 2;

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
    onPositionChange?: (pos: { page: number; percentage: number }) => void;
    onLinkSource: (anchor: Anchor) => void;
    onLinkTarget: (anchor: Anchor) => void;
    onNavigateLink: (link: LocalLink, clickedSide: 'source' | 'target') => void;
  } = $props();

  let container: HTMLDivElement | undefined = $state();
  let contentEl: HTMLDivElement | undefined = $state();
  let pdf = $state<PDFDocumentProxy | null>(null);
  let sizes = $state<{ w: number; h: number }[]>([]);
  // Intentionally read once: the workspace remounts this component per
  // document, so initialView is fixed for this instance's lifetime.
  // svelte-ignore state_referenced_locally
  let scale = $state(initialView?.scale ?? 1);
  // svelte-ignore state_referenced_locally
  let fitted = initialView !== null;
  let scrollTop = $state(0);
  let viewH = $state(0);
  let viewW = $state(0);
  let missingBlob = $state(false);
  let downloading = $state(false);
  let popover = $state<{ x: number; y: number; anchor: Anchor } | null>(null);
  let flash = $state<{ page: number; rects: Rect[] } | null>(null);
  let flashTimer: ReturnType<typeof setTimeout> | undefined;

  const textIndexes = new Map<number, { index: PageTextIndex; pageEl: HTMLElement }>();
  let readyResolvers: (() => void)[] = [];

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
    // Same guard as EpubViewer: the doc prop's identity churns with liveQuery
    // emissions, and reloading an already-open PDF would reset the measured
    // sizes and with them the scroll position, mid-read.
    if (pdf && loadedSha === sha256) return;
    pdf = null;
    sizes = [];
    missingBlob = false;
    textIndexes.clear();
    const bytes = await blobStore.get(sha256);
    if (!bytes) {
      missingBlob = true;
      void downloadBlob(); // try to fetch right away; the card is the fallback
      return;
    }
    const opened = await openPdf(sha256, bytes);
    const measured: { w: number; h: number }[] = [];
    for (let i = 1; i <= opened.numPages; i++) {
      const page = await opened.getPage(i);
      const vp = page.getViewport({ scale: 1 });
      measured.push({ w: vp.width, h: vp.height });
    }
    pdf = opened;
    loadedSha = sha256;
    sizes = measured;
    if (initialView) {
      // Restore the spot the reader was at when they left this tab — unless a
      // link jump is in flight, which must win over the remembered position.
      requestAnimationFrame(() => {
        if (container && !suppressRestore) {
          container.scrollTop = initialView.scrollTop;
          scrollTop = initialView.scrollTop;
        }
      });
    } else if (initialPosition) {
      // Synced reading position (this device earlier, another device, or a
      // KOReader). By rAF time the fit-width effect has settled the scale, so
      // the page offsets are final.
      requestAnimationFrame(() => {
        if (!container || suppressRestore) return;
        const page = initialPosition.page;
        container.scrollTop =
          page && page >= 1 && page <= offsets.length
            ? offsets[page - 1]!
            : (initialPosition.percentage ?? 0) * Math.max(0, totalHeight - viewH);
        scrollTop = container.scrollTop;
      });
    }
    for (const resolve of readyResolvers.splice(0)) resolve();
  }

  /** Read by the workspace before a tab switch so the spot survives remounts. */
  export function getViewState(): { scrollTop: number; scale: number } {
    return { scrollTop: container?.scrollTop ?? 0, scale };
  }

  /** Reading position in kosync terms: the page at the upper third of the view. */
  export function getPosition(): { page: number; percentage: number } {
    const at = (container?.scrollTop ?? 0) + viewH / 3;
    let page = 1;
    for (let i = 0; i < offsets.length; i++) {
      if (offsets[i]! <= at) page = i + 1;
      else break;
    }
    return { page, percentage: sizes.length ? page / sizes.length : 0 };
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

  // A sync pass may have downloaded this PDF (new-device fill-in): whenever
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

  // Fit width once we know both the container and the widest page.
  $effect(() => {
    if (!fitted && viewW > 0 && sizes.length > 0) {
      fitted = true;
      fitWidth();
    }
  });

  function fitWidth() {
    const maxW = Math.max(...sizes.map((s) => s.w));
    const pad = viewW < 600 ? 12 : 48; // phones need every pixel of width
    scale = clampScale((viewW - pad) / maxW);
  }
  const clampScale = (s: number) => Math.min(3, Math.max(0.4, s));

  function zoom(delta: number) {
    const prev = scale;
    scale = clampScale(scale + delta);
    if (container && prev > 0) container.scrollTop = (container.scrollTop / prev) * scale;
    popover = null;
  }

  const offsets = $derived.by(() => {
    const out: number[] = [];
    let y = GAP;
    for (const s of sizes) {
      out.push(y);
      y += s.h * scale + GAP;
    }
    return out;
  });
  const totalHeight = $derived(
    sizes.reduce((acc, s) => acc + s.h * scale + GAP, GAP),
  );

  const visible = $derived.by(() => {
    const from = scrollTop - OVERSCAN * viewH;
    const to = scrollTop + (1 + OVERSCAN) * viewH;
    const pages: number[] = [];
    for (let i = 0; i < sizes.length; i++) {
      const top = offsets[i]!;
      const bottom = top + sizes[i]!.h * scale;
      if (bottom >= from && top <= to) pages.push(i + 1);
      if (top > to) break;
    }
    return pages;
  });

  // ---- annotation marks per page

  function anchorRects(anchor: Anchor): Rect[] {
    if (anchor.kind === 'text') return anchor.rects;
    if (anchor.kind === 'region') return [anchor.rect];
    return [];
  }

  const highlightsByPage = $derived.by(() => {
    const map = new Map<number, HighlightMark[]>();
    for (const h of highlights) {
      const page = h.anchor.page;
      if (!map.has(page)) map.set(page, []);
      map.get(page)!.push({ key: h.id, color: h.color, rects: h.anchor.rects });
    }
    return map;
  });

  const linkMarksByPage = $derived.by(() => {
    const map = new Map<number, LinkMark[]>();
    const push = (linkId: string, kind: 'source' | 'target', anchor: Anchor) => {
      const page = anchorPage(anchor);
      if (!map.has(page)) map.set(page, []);
      map.get(page)!.push({
        key: `${linkId}:${kind}:${page}`,
        linkId,
        kind,
        rects: anchorRects(anchor),
        point: anchor.kind === 'point' ? { x: anchor.x, y: anchor.y } : undefined,
      });
    };
    for (const l of links) {
      if (l.fromDocumentId === doc.id) push(l.id, 'source', l.fromAnchor);
      if (l.toDocumentId === doc.id) push(l.id, 'target', l.toAnchor);
    }
    return map;
  });

  // ---- selection & clicks

  function computeSelectionPopover(): { x: number; y: number; anchor: Anchor } | null {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0);
    const pageEl = (range.startContainer.parentElement ?? null)?.closest?.(
      '.page[data-page]',
    ) as HTMLElement | null;
    if (!pageEl || !container || !container.contains(pageEl)) return null;
    const entry = textIndexes.get(Number(pageEl.dataset.page));
    if (!entry) return null;
    const anchor = anchorFromSelection(range, entry.index, entry.pageEl, scale);
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

  function handlePageClick(page: number, pt: { x: number; y: number }) {
    if (!linkArmed) return;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) return; // selection flow handles it
    if (popover) {
      popover = null; // first click just dismisses a pending selection popover
      return;
    }
    onLinkTarget({ kind: 'point', page, x: pt.x, y: pt.y });
  }

  function handleLinkClick(linkId: string, kind: 'source' | 'target') {
    const link = links.find((l) => l.id === linkId);
    if (link) onNavigateLink(link, kind);
  }

  async function applyHighlight(color: string) {
    if (!popover || popover.anchor.kind !== 'text') return;
    // $state proxies cannot be structured-cloned into IndexedDB; snapshot first.
    const anchor = $state.snapshot(popover.anchor) as TextAnchor;
    await addHighlight(doc.notebookId, doc.id, anchor, color);
    window.getSelection()?.removeAllRanges();
    popover = null;
  }

  /** Tombstone every highlight whose text range overlaps the selection. */
  async function clearHighlightsUnder() {
    if (!popover || popover.anchor.kind !== 'text') return;
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

  function whenReady(): Promise<void> {
    if (sizes.length > 0) return Promise.resolve();
    return new Promise((resolve) => readyResolvers.push(resolve));
  }

  let suppressRestore = false;

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
    await whenReady();
    const idx = anchorPage(anchor) - 1;
    if (!container || idx < 0 || idx >= offsets.length) return;
    const y = offsets[idx]! + anchorTopY(anchor) * scale - viewH / 3;
    container.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
    const rects = anchorRects(anchor);
    flash = {
      page: anchorPage(anchor),
      rects: rects.length
        ? rects
        : anchor.kind === 'point'
          ? [{ x: anchor.x - 12, y: anchor.y - 12, w: 24, h: 24 }]
          : [],
    };
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => (flash = null), 1800);
  }

  function handleTextIndex(page: number, index: PageTextIndex, pageEl: HTMLElement) {
    textIndexes.set(page, { index, pageEl });
  }

  // ---- pinch zoom: live CSS preview, crisp re-render committed at gesture end

  /** Ratio the current scale can actually absorb without leaving the clamp. */
  function effectiveRatio(ratio: number): number {
    return clampScale(scale * ratio) / scale;
  }

  function pinchLive(ratio: number, focal: { x: number; y: number }) {
    if (!contentEl || !container) return;
    popover = null;
    const r = effectiveRatio(ratio);
    contentEl.style.transformOrigin = `${container.scrollLeft + focal.x}px ${container.scrollTop + focal.y}px`;
    contentEl.style.transform = `scale(${r})`;
  }

  function pinchEnd(ratio: number, focal: { x: number; y: number }) {
    if (!contentEl || !container) return;
    const r = effectiveRatio(ratio);
    contentEl.style.transform = '';
    contentEl.style.transformOrigin = '';
    const x = container.scrollLeft;
    const y = container.scrollTop;
    scale = clampScale(scale * ratio);
    requestAnimationFrame(() => {
      if (!container) return;
      // Keep the point under the fingers where it was.
      container.scrollLeft = (x + focal.x) * r - focal.x;
      container.scrollTop = (y + focal.y) * r - focal.y;
    });
  }
</script>

<div class="viewer-wrap">
  {#if !$immersive}
    <div class="toolbar">
      <span class="doc-title" title={doc.title}>{doc.title}</span>
      <span class="spacer"></span>
      <button onclick={() => zoom(-0.25)} aria-label="Zoom out">−</button>
      <span class="zoom">{Math.round(scale * 100)}%</span>
      <button onclick={() => zoom(0.25)} aria-label="Zoom in">+</button>
      <button onclick={fitWidth}>Fit</button>
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
  {:else}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="viewer"
      bind:this={container}
      bind:clientHeight={viewH}
      bind:clientWidth={viewW}
      use:pinch={{ onLive: pinchLive, onEnd: pinchEnd }}
      onscroll={() => {
        scrollTop = container?.scrollTop ?? 0;
        popover = null;
        onPositionChange?.(getPosition());
      }}
      onpointerup={handlePointerUp}
      class:armed={linkArmed}
    >
      <div class="content" bind:this={contentEl} style={`height:${totalHeight}px;`}>
        {#if pdf}
          {#each visible as n (n)}
            <PdfPage
              {pdf}
              pageNumber={n}
              size={sizes[n - 1]!}
              {scale}
              y={offsets[n - 1]!}
              highlights={highlightsByPage.get(n) ?? []}
              linkMarks={linkMarksByPage.get(n) ?? []}
              flashRects={flash?.page === n ? flash.rects : []}
              onTextIndex={handleTextIndex}
              onPageClick={handlePageClick}
              onLinkClick={handleLinkClick}
            />
          {/each}
        {/if}
      </div>
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
    /* Panning stays native; pinches are ours (document zoom, not page zoom). */
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
  .content {
    position: relative;
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
