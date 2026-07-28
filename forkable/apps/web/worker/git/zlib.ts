// pako wrappers. pako (not fflate) because pack parsing must know how many
// input bytes each zlib stream consumed: pako.Inflate exposes strm.total_in.

import pako from 'pako';

export function deflate(data: Uint8Array): Uint8Array {
  return pako.deflate(data);
}

export function inflate(data: Uint8Array): Uint8Array {
  return pako.inflate(data);
}

/**
 * Inflate one zlib stream that starts at `data[0]`, tolerating trailing bytes
 * (the rest of the pack). Returns the output plus how many input bytes the
 * stream consumed, so the pack reader can advance its cursor.
 */
export function inflateWithConsumed(data: Uint8Array): { out: Uint8Array; consumed: number } {
  const inf = new pako.Inflate();
  inf.push(data, true);
  const anyInf = inf as unknown as { ended: boolean; strm: { total_in: number } };
  if (inf.err) throw new Error(`zlib: ${inf.msg || `error ${inf.err}`}`);
  if (!anyInf.ended) throw new Error('zlib: truncated stream');
  const out = inf.result;
  if (typeof out === 'string') throw new Error('zlib: unexpected string output');
  return { out: out as Uint8Array, consumed: anyInf.strm.total_in };
}
