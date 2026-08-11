import { describe, expect, it } from 'vitest';
import { fingerprint, groupIdFor, normalizeFrame, normalizeMessage } from '../worker/fingerprint';

describe('normalizeMessage', () => {
  it('keeps only the first line', () => {
    expect(normalizeMessage('boom\nat foo.js:1:2')).toBe('boom');
  });

  it('collapses uuids, long hex, and numbers', () => {
    expect(normalizeMessage('user 123e4567-e89b-12d3-a456-426614174000 not found')).toBe(
      'user # not found'
    );
    expect(normalizeMessage('chunk deadbeefcafe1234 failed')).toBe('chunk # failed');
    expect(normalizeMessage('timeout after 30000ms')).toBe('timeout after #ms');
  });

  it('keeps small numbers (arity, indexes) intact', () => {
    expect(normalizeMessage('expected 2 arguments')).toBe('expected 2 arguments');
  });

  it('strips query strings from embedded urls', () => {
    expect(normalizeMessage('failed to fetch https://api.example.com/v1/items?page=2')).toBe(
      'failed to fetch https://api.example.com/v1/items'
    );
  });

  it('truncates to 300 chars', () => {
    expect(normalizeMessage('x'.repeat(500))).toHaveLength(300);
  });
});

describe('normalizeFrame', () => {
  it('parses chrome frames to fn|path', () => {
    const stack = `TypeError: boom
    at renderRow (https://cdn.example.com/assets/app-abc123.js:41:13)
    at map (https://cdn.example.com/assets/app-abc123.js:2:1)`;
    expect(normalizeFrame(stack)).toBe('renderRow|/assets/app-abc123.js');
  });

  it('parses firefox/safari frames to fn|path', () => {
    const stack = `renderRow@https://example.com/app.js:41:13
map@https://example.com/app.js:2:1`;
    expect(normalizeFrame(stack)).toBe('renderRow|/app.js');
  });

  it('strips query strings (cache busters) from frame urls', () => {
    expect(normalizeFrame('at f (https://example.com/app.js?v=99:1:2)')).toBe('f|/app.js');
  });

  it('is stable across line/col changes', () => {
    const a = normalizeFrame('at f (https://x.io/a.js:1:2)');
    const b = normalizeFrame('at f (https://x.io/a.js:500:9)');
    expect(a).toBe(b);
  });

  it('returns empty for missing or locationless stacks', () => {
    expect(normalizeFrame(null)).toBe('');
    expect(normalizeFrame('Error: boom')).toBe('');
  });
});

describe('fingerprint + group id', () => {
  it('same crash, different volatile bits => same fingerprint', async () => {
    const a = await fingerprint(
      'timeout after 30000ms',
      'at fetchData (https://cdn-1.example.com/app.js?v=1:10:5)'
    );
    const b = await fingerprint(
      'timeout after 45000ms',
      'at fetchData (https://cdn-1.example.com/app.js?v=2:99:1)'
    );
    expect(a).toBe(b);
  });

  it('different top frame => different fingerprint', async () => {
    const a = await fingerprint('boom', 'at f (https://x.io/a.js:1:1)');
    const b = await fingerprint('boom', 'at g (https://x.io/a.js:1:1)');
    expect(a).not.toBe(b);
  });

  it('group id is deterministic per project + fingerprint and 32 chars', async () => {
    const fp = await fingerprint('boom', null);
    const g1 = await groupIdFor('proj-1', fp);
    const g2 = await groupIdFor('proj-1', fp);
    const other = await groupIdFor('proj-2', fp);
    expect(g1).toBe(g2);
    expect(g1).toHaveLength(32);
    expect(other).not.toBe(g1);
  });
});
