import { describe, expect, test } from 'bun:test';
import { nextTimestamp, observeTimestamp } from '../src/clock';

describe('clock', () => {
  test('uses wall clock when ahead of everything seen', () => {
    expect(nextTimestamp(100, 500)).toBe(500);
  });

  test('bumps past observed timestamps when local clock is behind', () => {
    expect(nextTimestamp(500, 100)).toBe(501);
  });

  test('successive writes are strictly increasing even with a frozen clock', () => {
    let seen = 0;
    const stamps: number[] = [];
    for (let i = 0; i < 5; i++) {
      const ts = nextTimestamp(seen, 42);
      stamps.push(ts);
      seen = observeTimestamp(seen, ts);
    }
    for (let i = 1; i < stamps.length; i++) {
      expect(stamps[i]!).toBeGreaterThan(stamps[i - 1]!);
    }
  });

  test('observe keeps the max', () => {
    expect(observeTimestamp(5, 3)).toBe(5);
    expect(observeTimestamp(3, 5)).toBe(5);
  });
});
