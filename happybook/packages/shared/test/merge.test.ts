import { describe, expect, test } from 'bun:test';
import { compareVersions, incomingWins, type Versioned } from '../src/merge';

const v = (updatedAt: number, writeId: string): Versioned => ({ updatedAt, writeId });

describe('compareVersions', () => {
  test('orders by updatedAt first', () => {
    expect(compareVersions(v(1, 'z'), v(2, 'a'))).toBe(-1);
    expect(compareVersions(v(2, 'a'), v(1, 'z'))).toBe(1);
  });

  test('breaks ties by writeId', () => {
    expect(compareVersions(v(5, 'a'), v(5, 'b'))).toBe(-1);
    expect(compareVersions(v(5, 'b'), v(5, 'a'))).toBe(1);
    expect(compareVersions(v(5, 'a'), v(5, 'a'))).toBe(0);
  });

  test('is antisymmetric and total for every pairing', () => {
    const versions = [v(1, 'a'), v(1, 'b'), v(2, 'a'), v(2, 'b')];
    for (const a of versions) {
      for (const b of versions) {
        expect(compareVersions(a, b) + compareVersions(b, a)).toBe(0);
      }
    }
  });
});

describe('incomingWins', () => {
  test('incoming wins against missing current', () => {
    expect(incomingWins(v(1, 'a'), null)).toBe(true);
    expect(incomingWins(v(1, 'a'), undefined)).toBe(true);
  });

  test('strictly newer wins, equal or older loses', () => {
    expect(incomingWins(v(2, 'a'), v(1, 'z'))).toBe(true);
    expect(incomingWins(v(1, 'z'), v(2, 'a'))).toBe(false);
    expect(incomingWins(v(5, 'a'), v(5, 'a'))).toBe(false); // idempotent re-delivery
  });

  test('two writers converge regardless of apply order', () => {
    // Simulate every interleaving of two concurrent writes to the same key:
    // whichever order the merges run, both sides settle on the same version.
    const writes = [v(7, 'aaa'), v(7, 'bbb'), v(8, 'aaa')];
    for (const first of writes) {
      for (const second of writes) {
        let stateA: Versioned | null = null;
        for (const w of [first, second]) if (incomingWins(w, stateA)) stateA = w;
        let stateB: Versioned | null = null;
        for (const w of [second, first]) if (incomingWins(w, stateB)) stateB = w;
        expect(stateA).toEqual(stateB);
      }
    }
  });
});
