// Server-side error grouping. Pure and unit-tested: the same crash must map
// to the same fingerprint across page loads, minified chunk hashes, and
// volatile ids embedded in messages.

import { sha256Hex } from './hash';

/** First line only; volatile tokens (uuids, long hex, numbers, URL query strings) collapsed. */
export function normalizeMessage(message: string): string {
  let m = (message.split('\n')[0] ?? '').trim();
  m = m.replace(/https?:\/\/[^\s'")]+/g, (u) => u.replace(/[?#].*$/, ''));
  m = m.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '#');
  m = m.replace(/\b[0-9a-f]{8,}\b/gi, '#');
  m = m.replace(/\d{3,}/g, '#');
  return m.slice(0, 300);
}

/**
 * The first stack frame with a source location, reduced to `fn|path`:
 * line/col stripped (minified builds shift them constantly), origin and
 * query stripped (CDN hosts and cache-busting params vary).
 * Handles Chrome ("at fn (url:1:2)") and Firefox/Safari ("fn@url:1:2").
 */
export function normalizeFrame(stack: string | null | undefined): string {
  if (!stack) return '';
  for (const raw of stack.split('\n')) {
    const line = raw.trim();
    const loc = line.match(/((?:https?|file|blob|webpack[^:]*):\/\/[^\s()]+?|\/[^\s():]+?):(\d+):(\d+)/);
    if (!loc) continue;
    let path = loc[1]!;
    try {
      path = new URL(path).pathname;
    } catch {
      // already a bare path
    }
    path = path.replace(/[?#].*$/, '');
    let fn = '';
    const chrome = line.match(/^at\s+([^\s(]+)\s*\(/);
    const gecko = line.match(/^([^@\s]+)@/);
    if (chrome) fn = chrome[1]!;
    else if (gecko) fn = gecko[1]!;
    return `${fn}|${path}`;
  }
  return '';
}

export async function fingerprint(message: string, stack?: string | null): Promise<string> {
  return sha256Hex(`${normalizeMessage(message)}\n${normalizeFrame(stack)}`);
}

/**
 * Deterministic group id: concurrent ingests of the same new error compute
 * the same id and collide harmlessly on INSERT OR IGNORE (no read-then-create
 * race; see specs/BacktalkGroups.tla).
 */
export async function groupIdFor(projectId: string, fp: string): Promise<string> {
  return (await sha256Hex(`${projectId}:${fp}`)).slice(0, 32);
}
