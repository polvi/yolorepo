import { describe, expect, it } from 'vitest';
import { generateApiToken, generatePublicKey } from '../worker/auth';
import { sha256Hex } from '../worker/hash';

describe('bt_ tokens', () => {
  it('carries the prefix and 32 chars of base64url entropy', () => {
    const token = generateApiToken();
    expect(token).toMatch(/^bt_[A-Za-z0-9_-]{32}$/);
  });

  it('does not repeat', () => {
    const seen = new Set(Array.from({ length: 100 }, generateApiToken));
    expect(seen.size).toBe(100);
  });
});

describe('pk_ project keys', () => {
  it('carries the prefix and 16 chars of base64url entropy', () => {
    expect(generatePublicKey()).toMatch(/^pk_[A-Za-z0-9_-]{16}$/);
  });
});

describe('sha256Hex', () => {
  it('matches a known vector', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
  });
});
