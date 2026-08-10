import { describe, expect, it } from 'vitest';
import { computeNets, settle, type Transfer } from '../worker/settle';

function applyTransfers(nets: Map<string, number>, transfers: Transfer[]) {
  const out = new Map(nets);
  for (const t of transfers) {
    out.set(t.from, (out.get(t.from) ?? 0) + t.amountTabMicro);
    out.set(t.to, (out.get(t.to) ?? 0) - t.amountTabMicro);
  }
  return out;
}

describe('settle', () => {
  it('handles the plan example', () => {
    const nets = new Map([
      ['a', 80],
      ['b', 20],
      ['c', -40],
      ['d', -60],
    ]);
    const transfers = settle(nets);
    expect(transfers).toEqual([
      { from: 'd', to: 'a', amountTabMicro: 60 },
      { from: 'c', to: 'a', amountTabMicro: 20 },
      { from: 'c', to: 'b', amountTabMicro: 20 },
    ]);
  });

  it('returns nothing when everyone is settled', () => {
    expect(settle(new Map([['a', 0], ['b', 0]]))).toEqual([]);
  });

  it('property: transfers exactly zero all nets, with at most n-1 transfers', () => {
    // Deterministic pseudo-random balances that sum to zero.
    let seed = 42;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let trial = 0; trial < 200; trial++) {
      const n = 2 + Math.floor(rand() * 6);
      const ids = Array.from({ length: n }, (_, i) => `u${i}`);
      const nets = new Map<string, number>();
      let running = 0;
      for (let i = 0; i < n - 1; i++) {
        const v = Math.floor(rand() * 2001) - 1000;
        nets.set(ids[i]!, v);
        running += v;
      }
      nets.set(ids[n - 1]!, -running);

      const transfers = settle(nets);
      expect(transfers.length).toBeLessThanOrEqual(n - 1);
      for (const t of transfers) expect(t.amountTabMicro).toBeGreaterThan(0);
      const after = applyTransfers(nets, transfers);
      for (const [, bal] of after) expect(bal).toBe(0);
    }
  });

  it('is deterministic under tie-breaks', () => {
    const nets = new Map([
      ['b', 50],
      ['a', 50],
      ['d', -50],
      ['c', -50],
    ]);
    expect(settle(nets)).toEqual([
      { from: 'c', to: 'a', amountTabMicro: 50 },
      { from: 'd', to: 'b', amountTabMicro: 50 },
    ]);
  });
});

describe('computeNets', () => {
  it('derives zero-sum nets from double-entry rows', () => {
    const nets = computeNets(['a', 'b', 'c'], {
      expenses: [{ paidBy: 'a', amountTabMicro: 300 }],
      shares: [
        { userId: 'a', shareTabMicro: 100 },
        { userId: 'b', shareTabMicro: 100 },
        { userId: 'c', shareTabMicro: 100 },
      ],
      payments: [{ fromUser: 'b', toUser: 'a', amountTabMicro: 100 }],
    });
    expect(nets.get('a')).toBe(100);
    expect(nets.get('b')).toBe(0);
    expect(nets.get('c')).toBe(-100);
    expect([...nets.values()].reduce((x, y) => x + y, 0)).toBe(0);
  });

  it('a stale payment simply nets in and self-corrects on the next settle', () => {
    // b paid a based on an old suggestion; a new expense flips direction.
    const nets = computeNets(['a', 'b'], {
      expenses: [
        { paidBy: 'a', amountTabMicro: 100 },
        { paidBy: 'b', amountTabMicro: 400 },
      ],
      shares: [
        { userId: 'a', shareTabMicro: 50 },
        { userId: 'b', shareTabMicro: 50 },
        { userId: 'a', shareTabMicro: 200 },
        { userId: 'b', shareTabMicro: 200 },
      ],
      payments: [{ fromUser: 'b', toUser: 'a', amountTabMicro: 50 }],
    });
    expect([...nets.values()].reduce((x, y) => x + y, 0)).toBe(0);
    const transfers = settle(nets);
    const after = applyTransfers(nets, transfers);
    for (const [, bal] of after) expect(bal).toBe(0);
  });
});
