import { describe, expect, it } from 'vitest';
import {
  TAB_MICRO_PER_TAB,
  TAB_MICRO_PER_USD,
  equalSplit,
  formatTab,
  normalizeToTabMicro,
  tabMicroPerUnit,
} from '../worker/money';

describe('tabMicroPerUnit', () => {
  it('TAB and USD are fixed and exact', () => {
    expect(tabMicroPerUnit('TAB')).toBe(100_000);
    expect(tabMicroPerUnit('USD')).toBe(10_000);
  });

  it('1 TAB equals 10 USD', () => {
    expect(TAB_MICRO_PER_TAB).toBe(10 * TAB_MICRO_PER_USD);
  });

  it('CAD uses the fx snapshot', () => {
    expect(tabMicroPerUnit('CAD', 0.73)).toBe(7_300);
    expect(() => tabMicroPerUnit('CAD')).toThrow();
    expect(() => tabMicroPerUnit('CAD', 0)).toThrow();
  });
});

describe('normalizeToTabMicro', () => {
  it('converts minor units exactly for fixed currencies', () => {
    // $12.34 = 1234 cents -> 1234 * 10000 / 100 = 123,400 µTAB
    expect(normalizeToTabMicro(1234, tabMicroPerUnit('USD'))).toBe(123_400);
    // 2.50 TAB -> 250,000 µTAB
    expect(normalizeToTabMicro(250, tabMicroPerUnit('TAB'))).toBe(250_000);
  });

  it('rejects non-positive and fractional amounts', () => {
    expect(() => normalizeToTabMicro(0, 10_000)).toThrow();
    expect(() => normalizeToTabMicro(-5, 10_000)).toThrow();
    expect(() => normalizeToTabMicro(1.5, 10_000)).toThrow();
  });
});

describe('equalSplit', () => {
  it('sums exactly to the total for any remainder', () => {
    for (let total = 1; total <= 500; total += 7) {
      for (const n of [1, 2, 3, 4, 5]) {
        const ids = Array.from({ length: n }, (_, i) => `u${i}`);
        const shares = equalSplit(total, ids);
        const sum = [...shares.values()].reduce((a, b) => a + b, 0);
        expect(sum).toBe(total);
      }
    }
  });

  it('gives the remainder to the first users in sorted id order', () => {
    const shares = equalSplit(10, ['c', 'a', 'b']);
    expect(shares.get('a')).toBe(4);
    expect(shares.get('b')).toBe(3);
    expect(shares.get('c')).toBe(3);
  });

  it('is deterministic regardless of input order', () => {
    const a = equalSplit(11, ['x', 'y', 'z']);
    const b = equalSplit(11, ['z', 'x', 'y']);
    expect([...a.entries()].sort()).toEqual([...b.entries()].sort());
  });

  it('rejects empty and duplicate participants', () => {
    expect(() => equalSplit(10, [])).toThrow();
    expect(() => equalSplit(10, ['a', 'a'])).toThrow();
  });
});

describe('formatTab', () => {
  it('formats µTAB as TAB with two decimals', () => {
    expect(formatTab(100_000)).toBe('1.00');
    expect(formatTab(123_400)).toBe('1.23');
    expect(formatTab(-50_000)).toBe('-0.50');
    expect(formatTab(0)).toBe('0.00');
  });
});
