// pkt-line framing for git smart HTTP protocol v1, plus side-band chunking.

const enc = new TextEncoder();
const dec = new TextDecoder();

export const FLUSH: Uint8Array = enc.encode('0000');

export function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export function pktLine(data: string | Uint8Array): Uint8Array {
  const payload = typeof data === 'string' ? enc.encode(data) : data;
  const len = payload.length + 4;
  if (len > 0xfff0) throw new Error('pkt-line too long');
  const out = new Uint8Array(len);
  out.set(enc.encode(len.toString(16).padStart(4, '0')), 0);
  out.set(payload, 4);
  return out;
}

export type Pkt = { kind: 'line'; data: Uint8Array } | { kind: 'flush' };

export interface ParsedPkts {
  pkts: Pkt[];
  /** Byte offset just past the last parsed pkt (e.g. where pack data starts). */
  offset: number;
}

/**
 * Parse pkt-lines from `bytes` starting at `start`. Stops after
 * `stopAfterFlush` flush pkts when given (receive-pack: command list ends at
 * the first flush, pack bytes follow), otherwise parses to end of buffer.
 */
export function parsePktLines(bytes: Uint8Array, start = 0, stopAfterFlush?: number): ParsedPkts {
  const pkts: Pkt[] = [];
  let pos = start;
  let flushes = 0;
  while (pos + 4 <= bytes.length) {
    const lenStr = dec.decode(bytes.subarray(pos, pos + 4));
    if (!/^[0-9a-fA-F]{4}$/.test(lenStr)) throw new Error(`bad pkt-line length at byte ${pos}`);
    const len = parseInt(lenStr, 16);
    if (len === 0) {
      pkts.push({ kind: 'flush' });
      pos += 4;
      flushes++;
      if (stopAfterFlush !== undefined && flushes >= stopAfterFlush) break;
      continue;
    }
    if (len < 4 || pos + len > bytes.length) throw new Error(`bad pkt-line at byte ${pos}`);
    pkts.push({ kind: 'line', data: bytes.subarray(pos + 4, pos + len) });
    pos += len;
  }
  return { pkts, offset: pos };
}

/** Text payload of a line pkt with any single trailing newline removed. */
export function pktText(p: Pkt): string {
  if (p.kind !== 'line') return '';
  let s = dec.decode(p.data);
  if (s.endsWith('\n')) s = s.slice(0, -1);
  return s;
}

/** Wrap `data` into side-band-64k pkt-lines on `channel` (1 data, 2 progress, 3 error). */
export function sidebandChunks(channel: number, data: Uint8Array, max = 32000): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < data.length; i += max) {
    const chunk = data.subarray(i, Math.min(i + max, data.length));
    const payload = new Uint8Array(chunk.length + 1);
    payload[0] = channel;
    payload.set(chunk, 1);
    out.push(pktLine(payload));
  }
  return out;
}
