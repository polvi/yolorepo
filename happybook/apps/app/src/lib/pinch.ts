export interface PinchCallbacks {
  /** Fires on every move while two fingers are down. Ratio is vs. pinch start. */
  onLive: (ratio: number, focal: { x: number; y: number }) => void;
  /** Fires when the pinch ends (a finger lifts). Same ratio/focal semantics. */
  onEnd: (ratio: number, focal: { x: number; y: number }) => void;
}

/**
 * Svelte action: two-finger pinch tracking for touch pointers. The focal
 * point is the fingers' midpoint at pinch start, relative to the node. The
 * node should also set `touch-action: pan-x pan-y` so the browser doesn't
 * claim the gesture for page zoom.
 */
export function pinch(node: HTMLElement, cb: PinchCallbacks) {
  const points = new Map<number, { x: number; y: number }>();
  let startDist = 0;
  let focal: { x: number; y: number } | null = null;
  let ratio = 1;

  const distance = () => {
    const [a, b] = [...points.values()];
    return Math.hypot(a!.x - b!.x, a!.y - b!.y);
  };

  function down(e: PointerEvent) {
    if (e.pointerType !== 'touch') return;
    points.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (points.size === 2) {
      const [a, b] = [...points.values()];
      const rect = node.getBoundingClientRect();
      startDist = distance();
      focal = { x: (a!.x + b!.x) / 2 - rect.left, y: (a!.y + b!.y) / 2 - rect.top };
      ratio = 1;
    }
  }

  function move(e: PointerEvent) {
    if (!points.has(e.pointerId)) return;
    points.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (focal && points.size >= 2 && startDist > 0) {
      ratio = distance() / startDist;
      cb.onLive(ratio, focal);
    }
  }

  function up(e: PointerEvent) {
    if (!points.delete(e.pointerId)) return;
    if (focal && points.size < 2) {
      cb.onEnd(ratio, focal);
      focal = null;
      startDist = 0;
      ratio = 1;
    }
  }

  function touchmove(e: TouchEvent) {
    // Mid-pinch, keep the browser from treating the fingers as a scroll.
    if (focal && e.touches.length >= 2) e.preventDefault();
  }

  // Safari's proprietary gesture events drive page zoom; swallow them here so
  // a pinch over the document never zooms the whole app.
  const prevent = (e: Event) => e.preventDefault();

  node.addEventListener('pointerdown', down);
  node.addEventListener('pointermove', move);
  node.addEventListener('pointerup', up);
  node.addEventListener('pointercancel', up);
  node.addEventListener('touchmove', touchmove, { passive: false });
  node.addEventListener('gesturestart', prevent);
  node.addEventListener('gesturechange', prevent);

  return {
    destroy() {
      node.removeEventListener('pointerdown', down);
      node.removeEventListener('pointermove', move);
      node.removeEventListener('pointerup', up);
      node.removeEventListener('pointercancel', up);
      node.removeEventListener('touchmove', touchmove);
      node.removeEventListener('gesturestart', prevent);
      node.removeEventListener('gesturechange', prevent);
    },
  };
}
