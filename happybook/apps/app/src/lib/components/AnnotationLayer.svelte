<script lang="ts">
  import type { Rect } from '@happybook/shared';

  export interface HighlightMark {
    key: string;
    color: string;
    rects: Rect[];
  }
  export interface LinkMark {
    key: string;
    linkId: string;
    kind: 'source' | 'target';
    rects: Rect[]; // underline boxes; empty for point targets
    point?: { x: number; y: number };
  }

  let {
    width,
    height,
    scale,
    highlights = [],
    linkMarks = [],
    flashRects = [],
    onLinkClick,
  }: {
    width: number;
    height: number;
    scale: number;
    highlights?: HighlightMark[];
    linkMarks?: LinkMark[];
    flashRects?: Rect[];
    onLinkClick?: (linkId: string, kind: 'source' | 'target') => void;
  } = $props();
</script>

<!-- viewBox is scale-1 PDF page space; zoom is just the width/height attrs. -->
<svg
  class="annotations"
  viewBox={`0 0 ${width} ${height}`}
  width={width * scale}
  height={height * scale}
  preserveAspectRatio="none"
>
  {#each highlights as h (h.key)}
    {#each h.rects as r, i (i)}
      <rect class="hl" x={r.x} y={r.y} width={r.w} height={r.h} fill={h.color} />
    {/each}
  {/each}

  {#each linkMarks as m (m.key)}
    {#each m.rects as r, i (i)}
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
      <g
        class="link"
        onclick={(e) => {
          e.stopPropagation(); // a link click must never double as a tap-to-fullscreen
          onLinkClick?.(m.linkId, m.kind);
        }}
      >
        <rect class="hit" x={r.x} y={r.y} width={r.w} height={r.h} />
        <line class="underline" x1={r.x} y1={r.y + r.h} x2={r.x + r.w} y2={r.y + r.h} />
      </g>
    {/each}
    {#if m.point}
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
      <g
        class="link pin"
        transform={`translate(${m.point.x} ${m.point.y})`}
        onclick={(e) => {
          e.stopPropagation();
          onLinkClick?.(m.linkId, m.kind);
        }}
      >
        <circle r={9 / scale} class="pin-dot" />
        <text y={3.5 / scale} text-anchor="middle" style={`font-size:${11 / scale}px`}>⇄</text>
      </g>
    {/if}
  {/each}

  {#each flashRects as r, i (i)}
    <rect class="flash" x={r.x - 2} y={r.y - 2} width={r.w + 4} height={r.h + 4} />
  {/each}
</svg>

<style>
  .annotations {
    position: absolute;
    inset: 0;
    pointer-events: none;
    mix-blend-mode: multiply;
  }
  .hl {
    opacity: 0.35;
  }
  .link {
    pointer-events: auto;
    cursor: pointer;
  }
  .hit {
    fill: transparent;
  }
  .underline {
    stroke: #c2542e;
    stroke-width: 1.6;
    stroke-dasharray: 3 2;
  }
  .link:hover .underline {
    stroke-width: 2.4;
  }
  .pin-dot {
    fill: #c2542e;
  }
  .pin text {
    fill: #fff;
    user-select: none;
  }
  .flash {
    fill: none;
    stroke: #c2542e;
    stroke-width: 2.5;
    animation: fade 1.6s ease-out forwards;
  }
  @keyframes fade {
    from {
      opacity: 1;
    }
    to {
      opacity: 0;
    }
  }
</style>
