import { describe, expect, it } from 'vitest';
import { parseRange } from '../worker/range';

describe('parseRange', () => {
  it('no header serves the full body', () => {
    expect(parseRange(null, 1000)).toBeNull();
  });

  it('bytes=a-b is an inclusive window', () => {
    expect(parseRange('bytes=0-99', 1000)).toEqual({ offset: 0, length: 100 });
    expect(parseRange('bytes=200-299', 1000)).toEqual({ offset: 200, length: 100 });
  });

  it('bytes=a-b clamps the end to the object', () => {
    expect(parseRange('bytes=900-5000', 1000)).toEqual({ offset: 900, length: 100 });
  });

  it('bytes=a- runs to the end', () => {
    expect(parseRange('bytes=100-', 1000)).toEqual({ offset: 100, length: 900 });
    expect(parseRange('bytes=0-', 1000)).toEqual({ offset: 0, length: 1000 });
  });

  it('bytes=-n is a suffix, clamped to the object', () => {
    expect(parseRange('bytes=-100', 1000)).toEqual({ suffix: 100 });
    expect(parseRange('bytes=-5000', 1000)).toEqual({ suffix: 1000 });
  });

  it('start at or past the end is unsatisfiable', () => {
    expect(parseRange('bytes=1000-', 1000)).toBe('invalid');
    expect(parseRange('bytes=1000-1099', 1000)).toBe('invalid');
  });

  it('malformed headers are invalid', () => {
    expect(parseRange('bytes=-', 1000)).toBe('invalid');
    expect(parseRange('bytes=abc-def', 1000)).toBe('invalid');
    expect(parseRange('bytes=10-5', 1000)).toBe('invalid');
    expect(parseRange('items=0-99', 1000)).toBe('invalid');
    expect(parseRange('bytes=-0', 1000)).toBe('invalid');
  });

  it('multi-range is legally ignored: full 200 body', () => {
    expect(parseRange('bytes=0-99,200-299', 1000)).toBeNull();
  });

  it('size 0 objects satisfy no range', () => {
    expect(parseRange('bytes=0-', 0)).toBe('invalid');
    expect(parseRange('bytes=0-0', 0)).toBe('invalid');
    expect(parseRange('bytes=-1', 0)).toBe('invalid');
    expect(parseRange(null, 0)).toBeNull();
  });
});
