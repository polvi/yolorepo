import { beforeEach, describe, expect, it } from 'vitest';
import { outbox, outboxIds, pushOutbox, replaceOutbox } from '../src/widget/store';

// store.ts touches the localStorage global at call time; give the node test
// environment a minimal in-memory one.
const mem = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
  },
});

const ev = (id: string) => ({ type: 'feedback', id, kind: 'idea', message: 'offline idea' });

describe('offline outbox', () => {
  beforeEach(() => mem.clear());

  it('round-trips queued events', () => {
    expect(pushOutbox('pk_a', ev('e1'))).toBe(true);
    pushOutbox('pk_a', ev('e2'));
    expect(outbox('pk_a').map((e) => e.id)).toEqual(['e1', 'e2']);
    expect(outboxIds('pk_a')).toEqual(new Set(['e1', 'e2']));
  });

  it('is scoped per project key', () => {
    pushOutbox('pk_a', ev('e1'));
    expect(outbox('pk_b')).toEqual([]);
  });

  it('keeps at most the 50 newest events', () => {
    for (let i = 0; i < 55; i++) pushOutbox('pk_a', ev(`e${i}`));
    const ids = outbox('pk_a').map((e) => e.id);
    expect(ids).toHaveLength(50);
    expect(ids[0]).toBe('e5');
    expect(ids.at(-1)).toBe('e54');
  });

  it('replaceOutbox drains partially and clears fully', () => {
    pushOutbox('pk_a', ev('e1'));
    pushOutbox('pk_a', ev('e2'));
    replaceOutbox('pk_a', outbox('pk_a').slice(1));
    expect(outbox('pk_a').map((e) => e.id)).toEqual(['e2']);
    replaceOutbox('pk_a', []);
    expect(outbox('pk_a')).toEqual([]);
  });
});
