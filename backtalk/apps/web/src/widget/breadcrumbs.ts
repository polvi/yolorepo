// Ring buffer of the last 20 things the visitor did — attached to every
// error and feedback event. Clicks record a short selector, navigations the
// path change, console.error the first argument. The only monkeypatches in
// the whole widget live here (pushState/replaceState/console.error), all
// pass-through with re-entrancy guards.

export type Crumb = { t: number; type: 'click' | 'nav' | 'console'; data: string };

const MAX = 20;
const buf: Crumb[] = [];
let inConsoleHook = false;

export function addCrumb(type: Crumb['type'], data: string): void {
  buf.push({ t: Date.now(), type, data: data.slice(0, 500) });
  if (buf.length > MAX) buf.shift();
}

export function crumbs(): Crumb[] {
  return buf.slice();
}

function selectorFor(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const id = el.id ? `#${el.id}` : '';
  const cls = el.classList.length ? `.${[...el.classList].slice(0, 2).join('.')}` : '';
  const text = (el.textContent ?? '').trim().slice(0, 30);
  return `${tag}${id}${cls}${text ? ` "${text}"` : ''}`;
}

export function installBreadcrumbs(onNavigate: (path: string) => void): void {
  document.addEventListener(
    'click',
    (e) => {
      try {
        const el = e.target instanceof Element ? e.target.closest('a,button,[role]') ?? e.target : null;
        if (el) addCrumb('click', selectorFor(el));
      } catch {
        // never break the host page
      }
    },
    true
  );

  let lastPath = location.pathname + location.hash;
  const noteNav = () => {
    try {
      const path = location.pathname + location.hash;
      if (path === lastPath) return;
      addCrumb('nav', `${lastPath} -> ${path}`);
      lastPath = path;
      onNavigate(location.pathname);
    } catch {
      // swallow
    }
  };

  const wrap = (name: 'pushState' | 'replaceState') => {
    const original = history[name].bind(history);
    history[name] = function (...args: Parameters<History['pushState']>) {
      const r = original(...args);
      noteNav();
      return r;
    };
  };
  try {
    wrap('pushState');
    wrap('replaceState');
  } catch {
    // read-only history in exotic environments: fine, we lose SPA navs only
  }
  addEventListener('popstate', noteNav);
  addEventListener('hashchange', noteNav);

  try {
    const original = console.error.bind(console);
    console.error = (...args: unknown[]) => {
      if (!inConsoleHook) {
        inConsoleHook = true;
        try {
          addCrumb('console', String(args[0]).slice(0, 200));
        } catch {
          // swallow
        }
        inConsoleHook = false;
      }
      original(...args);
    };
  } catch {
    // console locked down: fine
  }
}
