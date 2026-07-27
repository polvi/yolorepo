import { describe, expect, test } from 'bun:test';
import type { TextAnchor } from '@happybook/shared';
import { resolveTextAnchor } from '../src/lib/anchors';

const PAGE = 'The mitochondria is the powerhouse of the cell. The cell divides by mitosis.';

function anchorFor(quote: string, start: number): TextAnchor {
  return {
    kind: 'text',
    page: 1,
    quote,
    prefix: PAGE.slice(Math.max(0, start - 32), start),
    suffix: PAGE.slice(start + quote.length, start + quote.length + 32),
    start,
    end: start + quote.length,
    rects: [{ x: 0, y: 0, w: 10, h: 10 }],
  };
}

describe('resolveTextAnchor', () => {
  test('exact offsets resolve on unchanged text', () => {
    const a = anchorFor('powerhouse', PAGE.indexOf('powerhouse'));
    expect(resolveTextAnchor(a, PAGE)).toEqual({ start: a.start, end: a.end });
  });

  test('recovers by quote search when extraction drifts', () => {
    const a = anchorFor('powerhouse', PAGE.indexOf('powerhouse'));
    const drifted = 'PREAMBLE INSERTED. ' + PAGE; // all offsets shifted
    const resolved = resolveTextAnchor(a, drifted);
    expect(resolved).not.toBeNull();
    expect(drifted.slice(resolved!.start, resolved!.end)).toBe('powerhouse');
    expect(resolved!.start).toBe(drifted.indexOf('powerhouse'));
  });

  test('disambiguates repeated quotes using surrounding context', () => {
    // 'cell' appears twice; anchor points at the second occurrence.
    const second = PAGE.indexOf('cell', PAGE.indexOf('cell') + 1);
    const a = anchorFor('cell', second);
    const drifted = '>> ' + PAGE;
    const resolved = resolveTextAnchor(a, drifted)!;
    expect(drifted.slice(Math.max(0, resolved.start - 4), resolved.start)).toBe('The ');
    expect(resolved.start).toBe(drifted.indexOf('cell', drifted.indexOf('cell') + 1));
  });

  test('returns null when the quote no longer exists', () => {
    const a = anchorFor('powerhouse', PAGE.indexOf('powerhouse'));
    expect(resolveTextAnchor(a, 'Completely different page text.')).toBeNull();
  });
});
