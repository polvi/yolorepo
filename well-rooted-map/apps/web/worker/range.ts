// Single-range HTTP Range parsing (RFC 9110 §14), pure so it can be
// unit-tested. The offset/suffix shapes feed straight into R2's get({range}).

export type ParsedRange =
  | { offset: number; length: number }
  | { suffix: number }
  | 'invalid'
  | null;

export function parseRange(header: string | null, size: number): ParsedRange {
  if (!header) return null;
  // Multi-range requests are legal to ignore (RFC 9110 §15.3.7): callers
  // serve the full body with a 200 instead of multipart/byteranges.
  if (header.includes(',')) return null;

  const m = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!m) return 'invalid';
  const [, startStr, endStr] = m;

  if (startStr === '') {
    if (endStr === '') return 'invalid';
    const n = Number(endStr);
    // A zero-length suffix, or any suffix of an empty object, is unsatisfiable.
    if (n === 0 || size === 0) return 'invalid';
    return { suffix: Math.min(n, size) };
  }

  const start = Number(startStr);
  if (start >= size) return 'invalid';
  if (endStr === '') return { offset: start, length: size - start };
  const end = Number(endStr);
  if (end < start) return 'invalid';
  return { offset: start, length: Math.min(end, size - 1) - start + 1 };
}
