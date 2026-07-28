// Packfile writer. Entries reuse the deflated bytes exactly as stored, so no
// recompression happens on the read path: varint header + stored zlib stream.

import { sha1 } from './sha1';
import { concatBytes } from './pkt';
import type { ObjectStore } from './store';

/** Pack entry header: type in bits 6-4 of the first byte, size in 4+7n bits, MSB continuation. */
export function packObjectHeader(type: number, size: number): Uint8Array {
  const bytes: number[] = [];
  let b = (type << 4) | (size & 0x0f);
  size = Math.floor(size / 16);
  while (size > 0) {
    bytes.push(b | 0x80);
    b = size & 0x7f;
    size = Math.floor(size / 128);
  }
  bytes.push(b);
  return new Uint8Array(bytes);
}

export async function buildPack(store: ObjectStore, oids: string[]): Promise<Uint8Array> {
  const header = new Uint8Array(12);
  header.set([0x50, 0x41, 0x43, 0x4b]); // "PACK"
  const dv = new DataView(header.buffer);
  dv.setUint32(4, 2);
  dv.setUint32(8, oids.length);
  const parts: Uint8Array[] = [header];
  for (const oid of oids) {
    const obj = store.getRaw(oid);
    if (!obj) throw new Error(`missing object ${oid}`);
    parts.push(packObjectHeader(obj.type, obj.size));
    parts.push(obj.deflated);
  }
  const body = concatBytes(parts);
  const trailer = await sha1(body);
  return concatBytes([body, trailer]);
}
