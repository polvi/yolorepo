<script lang="ts">
  import type { PDFDocumentProxy } from 'pdfjs-dist';
  import { TextLayer } from 'pdfjs-dist';
  import type { RenderTask } from 'pdfjs-dist';
  import type { Rect } from '@happybook/shared';
  import { withRenderSlot } from '$lib/pdf';
  import { buildPageTextIndex, type PageTextIndex } from '$lib/anchors';
  import AnnotationLayer, { type HighlightMark, type LinkMark } from './AnnotationLayer.svelte';

  let {
    pdf,
    pageNumber,
    size,
    scale,
    y,
    highlights = [],
    linkMarks = [],
    flashRects = [],
    onTextIndex,
    onPageClick,
    onLinkClick,
  }: {
    pdf: PDFDocumentProxy;
    pageNumber: number;
    size: { w: number; h: number };
    scale: number;
    y: number;
    highlights?: HighlightMark[];
    linkMarks?: LinkMark[];
    flashRects?: Rect[];
    onTextIndex?: (page: number, index: PageTextIndex, pageEl: HTMLElement) => void;
    onPageClick?: (page: number, pt: { x: number; y: number }) => void;
    onLinkClick?: (linkId: string, kind: 'source' | 'target') => void;
  } = $props();

  let pageEl: HTMLDivElement;
  let canvas: HTMLCanvasElement;
  let textLayerEl: HTMLDivElement;
  let renderTask: RenderTask | null = null;
  let cancelled = false;

  $effect(() => {
    // re-render when the scale changes
    void render(scale);
    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  });

  async function render(atScale: number) {
    cancelled = false;
    try {
      const page = await pdf.getPage(pageNumber);
      if (cancelled) return;
      const viewport = page.getViewport({ scale: atScale });
      const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);

      await withRenderSlot(async () => {
        if (cancelled) return;
        renderTask?.cancel();
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        renderTask = page.render({
          canvasContext: ctx,
          viewport,
          transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0],
        });
        await renderTask.promise.catch((err: unknown) => {
          if ((err as { name?: string })?.name !== 'RenderingCancelledException') throw err;
        });
      });
      if (cancelled) return;

      const textContent = await page.getTextContent();
      if (cancelled) return;
      textLayerEl.replaceChildren();
      const textLayer = new TextLayer({
        textContentSource: textContent,
        container: textLayerEl,
        viewport,
      });
      await textLayer.render();
      if (cancelled) return;
      const index = buildPageTextIndex(
        pageNumber,
        textContent.items as { str: string }[],
        textLayer.textDivs as HTMLElement[],
      );
      onTextIndex?.(pageNumber, index, pageEl);
    } catch (err) {
      if ((err as { name?: string })?.name !== 'RenderingCancelledException') {
        console.warn(`page ${pageNumber} render failed`, err);
      }
    }
  }

  function handleClick(e: MouseEvent) {
    if (!onPageClick) return;
    const box = pageEl.getBoundingClientRect();
    onPageClick(pageNumber, {
      x: (e.clientX - box.left) / scale,
      y: (e.clientY - box.top) / scale,
    });
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div
  bind:this={pageEl}
  class="page"
  style={`top:${y}px; width:${size.w * scale}px; height:${size.h * scale}px; --scale-factor:${scale}; --total-scale-factor:${scale};`}
  data-page={pageNumber}
  onclick={handleClick}
>
  <canvas bind:this={canvas} style={`width:${size.w * scale}px; height:${size.h * scale}px;`}></canvas>
  <div bind:this={textLayerEl} class="textLayer"></div>
  <AnnotationLayer
    width={size.w}
    height={size.h}
    {scale}
    {highlights}
    {linkMarks}
    {flashRects}
    {onLinkClick}
  />
</div>

<style>
  .page {
    position: absolute;
    left: 50%;
    transform: translateX(-50%);
    background: #fff;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
  }
  canvas {
    display: block;
  }
  .page :global(.textLayer) {
    position: absolute;
    inset: 0;
    overflow: hidden;
    line-height: 1;
    text-size-adjust: none;
    forced-color-adjust: none;
    transform-origin: 0 0;
    caret-color: CanvasText;
  }
  .page :global(.textLayer span),
  .page :global(.textLayer br) {
    color: transparent;
    position: absolute;
    white-space: pre;
    cursor: text;
    transform-origin: 0% 0%;
  }
  .page :global(.textLayer ::selection) {
    background: rgba(64, 116, 230, 0.35);
  }
</style>
