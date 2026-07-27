/** Zip-path helpers for EPUB internals. Pure so they stay unit-testable. */

export function dirname(path: string): string {
  const at = path.lastIndexOf('/');
  return at === -1 ? '' : path.slice(0, at);
}

/**
 * Resolve an href found in `fromFile` (a zip path) to a zip path: strips
 * fragment/query, percent-decodes, and collapses `.`/`..` segments.
 */
export function resolveHref(fromFile: string, href: string): string {
  const bare = href.split('#')[0]!.split('?')[0]!;
  let decoded: string;
  try {
    decoded = decodeURIComponent(bare);
  } catch {
    decoded = bare;
  }
  const base = decoded.startsWith('/') ? [] : dirname(fromFile).split('/').filter(Boolean);
  for (const seg of decoded.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') base.pop();
    else base.push(seg);
  }
  return base.join('/');
}
