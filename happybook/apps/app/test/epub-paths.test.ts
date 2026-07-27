import { describe, expect, test } from 'bun:test';
import { dirname, resolveHref } from '../src/lib/epub-paths';

describe('dirname', () => {
  test('returns the directory part of a zip path', () => {
    expect(dirname('OEBPS/text/ch1.xhtml')).toBe('OEBPS/text');
    expect(dirname('content.opf')).toBe('');
  });
});

describe('resolveHref', () => {
  test('resolves siblings relative to the referencing file', () => {
    expect(resolveHref('OEBPS/content.opf', 'text/ch1.xhtml')).toBe('OEBPS/text/ch1.xhtml');
    expect(resolveHref('ch1.xhtml', 'ch2.xhtml')).toBe('ch2.xhtml');
  });

  test('collapses parent and current-dir segments', () => {
    expect(resolveHref('OEBPS/text/ch1.xhtml', '../images/fig.png')).toBe('OEBPS/images/fig.png');
    expect(resolveHref('OEBPS/text/ch1.xhtml', './fig.png')).toBe('OEBPS/text/fig.png');
    expect(resolveHref('a/b/c.xhtml', '../../top.css')).toBe('top.css');
  });

  test('strips fragments and queries, percent-decodes', () => {
    expect(resolveHref('OEBPS/nav.xhtml', 'ch1.xhtml#section-2')).toBe('OEBPS/ch1.xhtml');
    expect(resolveHref('OEBPS/nav.xhtml', 'my%20image.png')).toBe('OEBPS/my image.png');
  });

  test('treats leading slash as archive root', () => {
    expect(resolveHref('OEBPS/text/ch1.xhtml', '/images/fig.png')).toBe('images/fig.png');
  });
});
