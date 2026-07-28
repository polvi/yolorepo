// Probes Durable Object SQLite value limits directly against a live RepoDO
// instance's storage. Documented behavior (Cloudflare): each column value in
// DO SQLite is limited to 2 MB. Our per-file cap of 1.5 MiB inflated (stored
// deflated, i.e. smaller still) keeps every objects.data row comfortably under
// that; the probes below pin the assumption.

import { describe, expect, it } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';

describe('DO SQLite value limits', () => {
  it('accepts a ~1.9MB blob value', async () => {
    const stub = env.REPO.get(env.REPO.idFromName('limits'));
    await runInDurableObject(stub, async (_instance, state) => {
      const big = new Uint8Array(1_900_000).fill(0x61);
      state.storage.sql.exec(
        'INSERT INTO objects(oid, type, size, data) VALUES (?, ?, ?, ?)',
        'f'.repeat(40),
        3,
        big.length,
        big.buffer
      );
      const row = state.storage.sql
        .exec('SELECT length(data) AS n FROM objects WHERE oid = ?', 'f'.repeat(40))
        .toArray()[0] as { n: number };
      expect(row.n).toBe(1_900_000);
    });
  });

  it('rejects a value over the 2MB limit', async () => {
    const stub = env.REPO.get(env.REPO.idFromName('limits2'));
    await runInDurableObject(stub, async (_instance, state) => {
      const tooBig = new Uint8Array(2_500_000).fill(0x61);
      expect(() =>
        state.storage.sql.exec(
          'INSERT INTO objects(oid, type, size, data) VALUES (?, ?, ?, ?)',
          'e'.repeat(40),
          3,
          tooBig.length,
          tooBig.buffer
        )
      ).toThrow();
    });
  });
});
