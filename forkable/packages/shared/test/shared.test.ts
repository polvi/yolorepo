import { describe, expect, test } from 'bun:test';
import {
  forkRefFor,
  mimeFor,
  parseForkRef,
  validateSiteName,
} from '../src/index';

describe('site names', () => {
  test('accepts simple names', () => {
    expect(validateSiteName('my-site')).toBeNull();
    expect(validateSiteName('a1')).toBeNull();
    expect(validateSiteName('x')).toBeNull();
  });

  test('rejects bad shapes', () => {
    expect(validateSiteName('')).not.toBeNull();
    expect(validateSiteName('-lead')).not.toBeNull();
    expect(validateSiteName('trail-')).not.toBeNull();
    expect(validateSiteName('UPPER')).not.toBeNull();
    expect(validateSiteName('dot.dot')).not.toBeNull();
    expect(validateSiteName('a'.repeat(41))).not.toBeNull();
  });

  test('rejects reserved names', () => {
    expect(validateSiteName('www')).not.toBeNull();
    expect(validateSiteName('api')).not.toBeNull();
    expect(validateSiteName('forkable')).not.toBeNull();
  });
});

describe('fork refs', () => {
  test('round-trips', () => {
    expect(parseForkRef(forkRefFor('u123'))).toBe('u123');
  });

  test('rejects non-fork refs', () => {
    expect(parseForkRef('refs/heads/main')).toBeNull();
    expect(parseForkRef('refs/forks/')).toBeNull();
    expect(parseForkRef('refs/forks/a/b')).toBeNull();
  });
});

describe('mime', () => {
  test('maps common types', () => {
    expect(mimeFor('index.html')).toContain('text/html');
    expect(mimeFor('style.css')).toContain('text/css');
    expect(mimeFor('app.js')).toContain('javascript');
    expect(mimeFor('logo.svg')).toBe('image/svg+xml');
    expect(mimeFor('noext')).toBe('application/octet-stream');
  });
});
