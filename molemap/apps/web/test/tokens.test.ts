import { describe, expect, it } from 'vitest';
import { TOKEN_PREFIX, generateApiToken, sha256Hex } from '../worker/auth';

describe('generateApiToken', () => {
  it('uses the mm_ prefix', () => {
    expect(TOKEN_PREFIX).toBe('mm_');
    expect(generateApiToken().startsWith('mm_')).toBe(true);
  });

  it('carries 24 bytes of entropy as unpadded base64url', () => {
    for (let i = 0; i < 20; i++) {
      const body = generateApiToken().slice(TOKEN_PREFIX.length);
      expect(body).toHaveLength(32); // 24 bytes -> 32 base64 chars, no padding
      expect(body).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it('never repeats', () => {
    const seen = new Set(Array.from({ length: 100 }, () => generateApiToken()));
    expect(seen.size).toBe(100);
  });
});

describe('sha256Hex', () => {
  it('matches the known sha256("abc") vector', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
  });

  it('is lowercase hex of 64 chars', async () => {
    expect(await sha256Hex('molemap')).toMatch(/^[0-9a-f]{64}$/);
  });
});
