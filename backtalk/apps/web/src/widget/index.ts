// w.js bootstrap. One script tag, zero dependencies, nothing global except
// window.backtalk. Every entry point is wrapped so a widget bug can never
// take the host page down with it.
//
//   <script src="https://backtalk.<domain>/w.js" data-key="pk_..."
//           data-release="v1" defer></script>

import { addCrumb, installBreadcrumbs } from './breadcrumbs';
import {
  captureError,
  initCapture,
  installErrorHandlers,
  installVitals,
  setMetadata,
  trackPageview,
  type WidgetConfig,
} from './capture';
import { isSheetOpen, openSheet } from './ui';

declare global {
  interface Window {
    backtalk?: {
      open: () => void;
      set: (metadata: Record<string, unknown>) => void;
      capture: (err: unknown) => void;
    };
  }
}

(() => {
  try {
    const script = document.currentScript as HTMLScriptElement | null;
    const key = script?.dataset.key;
    if (!script || !key || window.backtalk) return;

    const cfg: WidgetConfig = {
      key,
      release: script.dataset.release ?? null,
      apiOrigin: new URL(script.src).origin,
      ownSrc: script.src,
    };

    initCapture(cfg);
    installBreadcrumbs((path) => trackPageview(path)); // SPA navigations
    installErrorHandlers();
    installVitals();
    trackPageview(location.pathname);

    // Desktop triggers: bare "?" outside editable elements (GitHub-style),
    // plus Cmd/Ctrl+Shift+/ where the browser lets the page have it. Firefox
    // on macOS binds Cmd+? to Help menu search at the app-menu level, so that
    // combo never reaches the page there; bare "?" covers the gap.
    const inEditable = (t: EventTarget | null): boolean => {
      const el = t as HTMLElement | null;
      if (!el || !el.tagName) return false;
      const tag = el.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
    };
    addEventListener('keydown', (e) => {
      try {
        const combo =
          (e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === '/' || e.key === '?');
        const bare =
          e.key === '?' &&
          !e.metaKey &&
          !e.ctrlKey &&
          !e.altKey &&
          !e.isComposing &&
          !inEditable(e.target);
        if ((combo || bare) && !isSheetOpen()) {
          e.preventDefault();
          openSheet(cfg);
        }
      } catch {
        // swallow
      }
    });

    // Touch trigger: two-finger long-press (~600ms). A single-finger long
    // press collides with text selection and context menus; two fingers held
    // still do not.
    let pressTimer: ReturnType<typeof setTimeout> | null = null;
    const cancel = () => {
      if (pressTimer) {
        clearTimeout(pressTimer);
        pressTimer = null;
      }
    };
    addEventListener(
      'touchstart',
      (e) => {
        try {
          cancel();
          if (e.touches.length === 2) {
            pressTimer = setTimeout(() => openSheet(cfg), 600);
          }
        } catch {
          // swallow
        }
      },
      { passive: true }
    );
    addEventListener('touchend', cancel, { passive: true });
    addEventListener('touchcancel', cancel, { passive: true });
    addEventListener('touchmove', cancel, { passive: true });

    window.backtalk = {
      open: () => {
        try {
          addCrumb('nav', 'backtalk.open()');
          openSheet(cfg);
        } catch {
          // swallow
        }
      },
      set: setMetadata,
      capture: (err: unknown) => {
        const e = err as { message?: string; stack?: string } | undefined;
        captureError(e?.message ?? String(err), e?.stack ?? null);
      },
    };
  } catch {
    // the widget must never break the page it is invited onto
  }
})();
