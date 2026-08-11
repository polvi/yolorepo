// Transport + error capture. Batched fetch flush on a debounce, sendBeacon
// on pagehide; bodies are text/plain so nothing ever preflights. Layered
// guards keep the widget from reporting itself into a loop: a re-entrancy
// flag, an own-source filter, a per-page cap, and client-side dedupe.
// Transport failures are swallowed silently — the widget must never be the
// thing that breaks the page.

import { crumbs } from './breadcrumbs';

export type WidgetConfig = {
  key: string;
  release: string | null;
  apiOrigin: string;
  ownSrc: string;
};

let cfg: WidgetConfig;
let metadata: Record<string, unknown> = {};

const queue: Record<string, unknown>[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

let errorCount = 0;
const seenErrors = new Set<string>();
let reporting = false;
let vitalsReported = false;

// vitals accumulators
let lcp = 0;
let cls = 0;
let inp = 0;

export function initCapture(config: WidgetConfig): void {
  cfg = config;

  addEventListener('pagehide', onHide);
  addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') onHide();
  });
}

export function setMetadata(m: Record<string, unknown>): void {
  try {
    metadata = { ...metadata, ...m };
  } catch {
    // swallow
  }
}

export function currentMetadata(): Record<string, unknown> | undefined {
  return Object.keys(metadata).length ? metadata : undefined;
}

function envelope(events: Record<string, unknown>[]): string {
  return JSON.stringify({
    key: cfg.key,
    ...(cfg.release ? { release: cfg.release } : {}),
    events,
  });
}

export function enqueue(ev: Record<string, unknown>): void {
  queue.push(ev);
  if (queue.length >= 20) {
    flush(false);
    return;
  }
  if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flush(false);
    }, 4000);
  }
}

export function flush(useBeacon: boolean): void {
  if (!queue.length) return;
  const body = envelope(queue.splice(0, 25));
  try {
    if (useBeacon && navigator.sendBeacon) {
      // text/plain Blob: a JSON content type would demand a preflight that
      // beacons cannot answer.
      if (navigator.sendBeacon(`${cfg.apiOrigin}/api/ingest`, new Blob([body], { type: 'text/plain' }))) {
        return;
      }
    }
  } catch {
    // fall through to fetch
  }
  try {
    fetch(`${cfg.apiOrigin}/api/ingest`, {
      method: 'POST',
      body,
      headers: { 'content-type': 'text/plain' },
      keepalive: true,
    }).catch(() => {});
  } catch {
    // swallow
  }
}

/** Feedback submits skip the queue: the user is watching. One idempotent retry (same UUID). */
export async function submitNow(ev: Record<string, unknown>): Promise<boolean> {
  const body = envelope([ev]);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${cfg.apiOrigin}/api/ingest`, {
        method: 'POST',
        body,
        headers: { 'content-type': 'text/plain' },
      });
      if (res.ok) return true;
      if (res.status >= 400 && res.status < 500) return false; // rejected, retry won't help
    } catch {
      // network hiccup: retry once
    }
  }
  return false;
}

export function captureError(message: unknown, stack?: string | null, source?: string | null): void {
  if (reporting) return;
  reporting = true;
  try {
    if (errorCount >= 20) return;
    const msg = String(message ?? 'unknown error').slice(0, 2000);
    const stk = stack ? String(stack).slice(0, 8192) : null;
    // never report our own crashes — that way lies the infinite loop
    if (cfg.ownSrc && ((stk && stk.includes(cfg.ownSrc)) || (source && source.includes(cfg.ownSrc)))) {
      return;
    }
    const sig = `${msg}\n${stk ?? ''}`;
    if (seenErrors.has(sig)) return;
    seenErrors.add(sig);
    errorCount++;
    enqueue({
      type: 'error',
      id: crypto.randomUUID(),
      message: msg,
      ...(stk ? { stack: stk } : {}),
      page_url: location.href.slice(0, 1000),
      ua: navigator.userAgent.slice(0, 500),
      breadcrumbs: crumbs(),
    });
  } catch {
    // swallow
  } finally {
    reporting = false;
  }
}

export function installErrorHandlers(): void {
  addEventListener('error', (e) => {
    try {
      captureError(
        e.message || String(e.error ?? 'error'),
        e.error?.stack ?? (e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : null),
        e.filename
      );
    } catch {
      // swallow
    }
  });
  window.addEventListener('unhandledrejection', (e) => {
    try {
      const r = e.reason as { message?: string; stack?: string } | undefined;
      captureError(r?.message ?? String(e.reason), r?.stack ?? null);
    } catch {
      // swallow
    }
  });
}

export function installVitals(): void {
  try {
    new PerformanceObserver((list) => {
      const last = list.getEntries().at(-1);
      if (last) lcp = last.startTime;
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  } catch {
    // unsupported browser
  }
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const e = entry as unknown as { value: number; hadRecentInput: boolean };
        if (!e.hadRecentInput) cls += e.value;
      }
    }).observe({ type: 'layout-shift', buffered: true });
  } catch {
    // unsupported
  }
  try {
    // Max long-interaction duration as a lean INP stand-in.
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.duration > inp) inp = entry.duration;
      }
    }).observe({ type: 'event', buffered: true, durationThreshold: 40 } as PerformanceObserverInit);
  } catch {
    // unsupported
  }
}

export function trackPageview(path: string): void {
  enqueue({ type: 'pageview', path: path.slice(0, 500) });
}

function onHide(): void {
  try {
    if (!vitalsReported) {
      vitalsReported = true;
      const path = location.pathname.slice(0, 500);
      if (lcp > 0) enqueue({ type: 'vital', metric: 'LCP', value: Math.round(lcp), path });
      if (inp > 0) enqueue({ type: 'vital', metric: 'INP', value: Math.round(inp), path });
      enqueue({ type: 'vital', metric: 'CLS', value: Math.round(cls * 1000) / 1000, path });
    }
    flush(true);
  } catch {
    // swallow
  }
}
