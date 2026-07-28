// Packfile reader: varint entry headers, zlib streams with tracked consumed
// bytes, ofs-delta and ref-delta resolution (bases in-pack or via getBase),
// trailer + per-object oid verification. Handles zero-object packs.
//
// parsePack/applyDelta are small pure interfaces on purpose: an alternate
// implementation (e.g. isomorphic-git internals) could swap in behind them.

import { bytesToHex, sha1Hex } from './sha1';
import { inflateWithConsumed } from './zlib';
import { OBJ_OFS_DELTA, OBJ_REF_DELTA, oidOf } from './objects';

export interface PackedObject {
  oid: string;
  type: number; // 1..4, deltas fully resolved
  raw: Uint8Array;
}

/** Lookup for ref-delta bases that live outside the pack (already in the store). */
export type BaseLookup = (oid: string) => { type: number; raw: Uint8Array } | null;

/** Apply a git delta (copy/insert opcodes) to `base`, producing the target. */
export function applyDelta(base: Uint8Array, delta: Uint8Array): Uint8Array {
  let pos = 0;
  const readSizeVarint = (): number => {
    let result = 0;
    let shift = 0;
    let b: number;
    do {
      if (pos >= delta.length) throw new Error('delta: truncated size varint');
      b = delta[pos++];
      result += (b & 0x7f) * 2 ** shift;
      shift += 7;
    } while (b & 0x80);
    return result;
  };
  const srcSize = readSizeVarint();
  const tgtSize = readSizeVarint();
  if (srcSize !== base.length) throw new Error('delta: base size mismatch');
  const out = new Uint8Array(tgtSize);
  let outPos = 0;
  while (pos < delta.length) {
    const op = delta[pos++];
    if (op & 0x80) {
      // copy from base
      let offset = 0;
      let size = 0;
      if (op & 0x01) offset |= delta[pos++];
      if (op & 0x02) offset |= delta[pos++] << 8;
      if (op & 0x04) offset |= delta[pos++] << 16;
      if (op & 0x08) offset += delta[pos++] * 0x1000000;
      if (op & 0x10) size |= delta[pos++];
      if (op & 0x20) size |= delta[pos++] << 8;
      if (op & 0x40) size |= delta[pos++] << 16;
      if (size === 0) size = 0x10000;
      if (offset + size > base.length) throw new Error('delta: copy out of range');
      out.set(base.subarray(offset, offset + size), outPos);
      outPos += size;
    } else if (op > 0) {
      // insert literal
      out.set(delta.subarray(pos, pos + op), outPos);
      pos += op;
      outPos += op;
    } else {
      throw new Error('delta: reserved opcode 0');
    }
  }
  if (outPos !== tgtSize) throw new Error('delta: output size mismatch');
  return out;
}

interface RawEntry {
  offset: number; // pack byte offset of this entry (delta base references point here)
  type: number; // header type, 1..4 or 6/7
  size: number; // inflated size of data
  data: Uint8Array; // inflated: object content, or delta instructions
  baseOffset?: number; // ofs-delta
  baseOid?: string; // ref-delta
  oid?: string;
  resolvedType?: number;
  resolvedRaw?: Uint8Array;
}

export async function parsePack(bytes: Uint8Array, getBase?: BaseLookup): Promise<PackedObject[]> {
  if (bytes.length < 32) throw new Error('pack: too small'); // 12 header + 20 trailer minimum
  if (bytes[0] !== 0x50 || bytes[1] !== 0x41 || bytes[2] !== 0x43 || bytes[3] !== 0x4b) {
    throw new Error('pack: bad magic');
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = dv.getUint32(4);
  if (version !== 2 && version !== 3) throw new Error(`pack: unsupported version ${version}`);
  const count = dv.getUint32(8);

  const expected = bytesToHex(bytes.subarray(bytes.length - 20));
  const actual = await sha1Hex(bytes.subarray(0, bytes.length - 20));
  if (expected !== actual) throw new Error('pack: checksum mismatch');

  const dataEnd = bytes.length - 20;
  let pos = 12;
  const entries: RawEntry[] = [];
  for (let i = 0; i < count; i++) {
    const offset = pos;
    if (pos >= dataEnd) throw new Error('pack: truncated');
    let b = bytes[pos++];
    const type = (b >> 4) & 0x07;
    let size = b & 0x0f;
    let shift = 4;
    while (b & 0x80) {
      if (pos >= dataEnd) throw new Error('pack: truncated varint');
      b = bytes[pos++];
      size += (b & 0x7f) * 2 ** shift;
      shift += 7;
    }
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (type === OBJ_OFS_DELTA) {
      b = bytes[pos++];
      let value = b & 0x7f;
      while (b & 0x80) {
        if (pos >= dataEnd) throw new Error('pack: truncated ofs-delta base');
        b = bytes[pos++];
        value = (value + 1) * 128 + (b & 0x7f);
      }
      baseOffset = offset - value;
      if (baseOffset < 12) throw new Error('pack: ofs-delta base before pack start');
    } else if (type === OBJ_REF_DELTA) {
      if (pos + 20 > dataEnd) throw new Error('pack: truncated ref-delta base');
      baseOid = bytesToHex(bytes.subarray(pos, pos + 20));
      pos += 20;
    } else if (type < 1 || type > 4) {
      throw new Error(`pack: bad object type ${type}`);
    }
    const { out, consumed } = inflateWithConsumed(bytes.subarray(pos, dataEnd));
    if (out.length !== size) throw new Error('pack: inflated size mismatch');
    pos += consumed;
    entries.push({ offset, type, size, data: out, baseOffset, baseOid });
  }
  if (pos !== dataEnd) throw new Error('pack: trailing garbage before checksum');

  // Resolve deltas. Multi-pass: each pass finalizes entries whose base is now
  // known (non-delta, previously resolved in-pack by offset or oid, or in the
  // store via getBase). Oids are computed as entries resolve so ref-deltas can
  // reference in-pack bases.
  const byOffset = new Map<number, RawEntry>();
  const byOid = new Map<string, RawEntry>();
  for (const e of entries) byOffset.set(e.offset, e);

  const finalize = async (e: RawEntry, type: number, raw: Uint8Array): Promise<void> => {
    e.resolvedType = type;
    e.resolvedRaw = raw;
    e.oid = await oidOf(type, raw);
    byOid.set(e.oid, e);
  };

  for (const e of entries) {
    if (e.type >= 1 && e.type <= 4) await finalize(e, e.type, e.data);
  }

  let unresolved = entries.filter((e) => !e.resolvedRaw).length;
  while (unresolved > 0) {
    let progress = 0;
    for (const e of entries) {
      if (e.resolvedRaw) continue;
      let base: { type: number; raw: Uint8Array } | null = null;
      if (e.baseOffset !== undefined) {
        const be = byOffset.get(e.baseOffset);
        if (!be) throw new Error('pack: ofs-delta base offset not at an entry boundary');
        if (be.resolvedRaw) base = { type: be.resolvedType!, raw: be.resolvedRaw };
      } else if (e.baseOid !== undefined) {
        const be = byOid.get(e.baseOid);
        if (be?.resolvedRaw) base = { type: be.resolvedType!, raw: be.resolvedRaw };
        else base = getBase?.(e.baseOid) ?? null;
      }
      if (base) {
        await finalize(e, base.type, applyDelta(base.raw, e.data));
        progress++;
      }
    }
    unresolved -= progress;
    if (progress === 0) {
      const missing = entries.find((e) => !e.resolvedRaw);
      throw new Error(
        `pack: unresolvable delta (base ${missing?.baseOid ?? `at offset ${missing?.baseOffset}`} not found)`
      );
    }
  }

  return entries.map((e) => ({ oid: e.oid!, type: e.resolvedType!, raw: e.resolvedRaw! }));
}
