import { describe, expect, it } from 'vitest';
import { bucketVital, normalizePath, originAllowed, parseEnvelope } from '../worker/ingest';

describe('bucketVital', () => {
  it('applies web.dev thresholds', () => {
    expect(bucketVital('LCP', 2000)).toBe('good');
    expect(bucketVital('LCP', 3000)).toBe('needs');
    expect(bucketVital('LCP', 5000)).toBe('poor');
    expect(bucketVital('INP', 150)).toBe('good');
    expect(bucketVital('INP', 300)).toBe('needs');
    expect(bucketVital('INP', 900)).toBe('poor');
    expect(bucketVital('CLS', 0.05)).toBe('good');
    expect(bucketVital('CLS', 0.2)).toBe('needs');
    expect(bucketVital('CLS', 0.4)).toBe('poor');
  });
});

describe('normalizePath', () => {
  it('strips query and hash', () => {
    expect(normalizePath('/pricing?utm=x#top')).toBe('/pricing');
  });

  it('reduces full urls to their pathname', () => {
    expect(normalizePath('https://example.com/a/b?x=1')).toBe('/a/b');
  });

  it('bounds length and never returns empty', () => {
    expect(normalizePath(`/${'x'.repeat(500)}`)).toHaveLength(200);
    expect(normalizePath('')).toBe('/');
  });
});

describe('originAllowed', () => {
  it('empty allowlist admits anyone, even without an Origin header', () => {
    expect(originAllowed('', 'https://evil.example')).toBe(true);
    expect(originAllowed('', null)).toBe(true);
  });

  it('non-empty allowlist requires an exact match', () => {
    const list = 'https://a.example, https://b.example';
    expect(originAllowed(list, 'https://a.example')).toBe(true);
    expect(originAllowed(list, 'https://b.example')).toBe(true);
    expect(originAllowed(list, 'https://c.example')).toBe(false);
    expect(originAllowed(list, null)).toBe(false);
  });
});

describe('parseEnvelope', () => {
  it('accepts a minimal envelope', () => {
    const r = parseEnvelope(JSON.stringify({ key: 'pk_x', events: [{ type: 'pageview', path: '/' }] }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.key).toBe('pk_x');
      expect(r.release).toBeNull();
      expect(r.events).toHaveLength(1);
    }
  });

  it('rejects junk, empty event lists, and oversized batches', () => {
    expect(parseEnvelope('not json').ok).toBe(false);
    expect(parseEnvelope(JSON.stringify({ key: 'pk_x', events: [] })).ok).toBe(false);
    expect(
      parseEnvelope(JSON.stringify({ key: 'pk_x', events: Array(26).fill({ type: 'pageview' }) })).ok
    ).toBe(false);
  });
});
