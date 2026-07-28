// Codec units: pkt-line framing, delta application, pack round-trips, and
// real `git pack-objects` fixture packs (with ref-deltas and ofs-deltas).

import { describe, expect, it } from 'vitest';
import { FLUSH, concatBytes, parsePktLines, pktLine, pktText, sidebandChunks } from '../worker/git/pkt';
import { applyDelta, parsePack } from '../worker/git/pack-read';
import { packObjectHeader } from '../worker/git/pack-write';
import { OBJ_BLOB, OBJ_COMMIT, oidOf } from '../worker/git/objects';
import { deflate } from '../worker/git/zlib';
import { b64ToBytes, makeDelta, makePack, td, te } from './helpers';
import {
  A_TXT_CONTENT,
  A_TXT_OID,
  EXPECTED_OIDS,
  OFS_DELTA_PACK_B64,
  REF_DELTA_PACK_B64,
} from './fixtures/fixtures.generated';

describe('pkt-line', () => {
  it('round-trips lines and flushes', () => {
    const body = concatBytes([
      pktLine('want deadbeef\n'),
      FLUSH,
      pktLine('have cafebabe\n'),
      pktLine('done\n'),
    ]);
    const { pkts, offset } = parsePktLines(body);
    expect(offset).toBe(body.length);
    expect(pkts.map((p) => (p.kind === 'flush' ? '(flush)' : pktText(p)))).toEqual([
      'want deadbeef',
      '(flush)',
      'have cafebabe',
      'done',
    ]);
  });

  it('encodes known lengths', () => {
    // "# service=git-upload-pack\n" is 26 bytes -> 001e
    expect(td.decode(pktLine('# service=git-upload-pack\n').subarray(0, 4))).toBe('001e');
    expect(td.decode(pktLine('NAK\n'))).toBe('0008NAK\n');
  });

  it('stops after the first flush when asked (pack boundary)', () => {
    const pack = te.encode('PACK....');
    const body = concatBytes([pktLine('cmd\n'), FLUSH, pack]);
    const { offset } = parsePktLines(body, 0, 1);
    expect(td.decode(body.subarray(offset))).toBe('PACK....');
  });

  it('side-band chunks respect the payload cap and channel byte', () => {
    const data = new Uint8Array(70000).fill(7);
    const chunks = sidebandChunks(1, data, 32000);
    expect(chunks.length).toBe(3);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(32000 + 5);
      expect(c[4]).toBe(1);
    }
    const total = chunks.reduce((n, c) => n + c.length - 5, 0);
    expect(total).toBe(70000);
  });
});

describe('applyDelta', () => {
  it('applies insert + copy opcodes', () => {
    const base = te.encode('hello brave new world');
    const delta = makeDelta(base.length, 11, [
      { insert: te.encode('HEY ') },
      { copy: { offset: 6, size: 5 } }, // "brave"
      { insert: te.encode('!!') },
    ]);
    expect(td.decode(applyDelta(base, delta))).toBe('HEY brave!!');
  });

  it('rejects base size mismatch', () => {
    const delta = makeDelta(99, 1, [{ insert: te.encode('x') }]);
    expect(() => applyDelta(te.encode('short'), delta)).toThrow(/base size/);
  });
});

describe('pack round-trip', () => {
  it('parses a hand-built pack with ref-delta and ofs-delta entries', async () => {
    const base = te.encode('The quick brown fox jumps over the lazy dog\n'.repeat(8));
    const baseOid = await oidOf(OBJ_BLOB, base);
    const target = concatBytes([te.encode('prefix:'), base.subarray(0, 90)]);
    const delta = makeDelta(base.length, target.length, [
      { insert: te.encode('prefix:') },
      { copy: { offset: 0, size: 90 } },
    ]);

    // Entry 0: base blob at offset 12. Entry 1: ref-delta. Entry 2: ofs-delta -> entry 0.
    const e0 = { type: OBJ_BLOB, data: base };
    const e1 = { type: 7, data: delta, baseOid };
    // Compute entry offsets: header(12) + e0 bytes.
    const e0Size = packObjectHeader(OBJ_BLOB, base.length).length + deflate(base).length;
    const e1Size = packObjectHeader(7, delta.length).length + 20 + deflate(delta).length;
    const e2 = { type: 6, data: delta, baseOffsetDistance: e0Size + e1Size };

    const pack = await makePack([e0, e1, e2]);
    const objects = await parsePack(pack);
    expect(objects.length).toBe(3);
    expect(objects[0].oid).toBe(baseOid);
    expect(td.decode(objects[1].raw)).toBe(td.decode(target));
    expect(objects[2].oid).toBe(objects[1].oid); // same delta, same base, same result
  });

  it('resolves ref-delta bases from the store lookup when absent from the pack', async () => {
    const base = te.encode('stored base content, long enough to copy from\n');
    const baseOid = await oidOf(OBJ_BLOB, base);
    const delta = makeDelta(base.length, 11, [{ copy: { offset: 0, size: 11 } }]);
    const pack = await makePack([{ type: 7, data: delta, baseOid }]);
    const objects = await parsePack(pack, (oid) =>
      oid === baseOid ? { type: OBJ_BLOB, raw: base } : null
    );
    expect(objects.length).toBe(1);
    expect(td.decode(objects[0].raw)).toBe('stored base');
    await expect(parsePack(pack)).rejects.toThrow(/unresolvable delta/);
  });

  it('handles zero-object packs', async () => {
    const pack = await makePack([]);
    expect(pack.length).toBe(32);
    expect(await parsePack(pack)).toEqual([]);
  });

  it('rejects a corrupted checksum', async () => {
    const pack = await makePack([{ type: OBJ_BLOB, data: te.encode('x') }]);
    pack[pack.length - 1] ^= 0xff;
    await expect(parsePack(pack)).rejects.toThrow(/checksum/);
  });
});

describe('git pack-objects fixtures', () => {
  it('parses the ref-delta fixture pack to the expected object set', async () => {
    const objects = await parsePack(b64ToBytes(REF_DELTA_PACK_B64));
    expect(objects.map((o) => o.oid).sort()).toEqual(EXPECTED_OIDS);
    const aTxt = objects.find((o) => o.oid === A_TXT_OID);
    expect(aTxt).toBeDefined();
    expect(td.decode(aTxt!.raw)).toBe(A_TXT_CONTENT);
    expect(objects.some((o) => o.type === OBJ_COMMIT)).toBe(true);
  });

  it('parses the ofs-delta fixture pack to the expected object set', async () => {
    const objects = await parsePack(b64ToBytes(OFS_DELTA_PACK_B64));
    expect(objects.map((o) => o.oid).sort()).toEqual(EXPECTED_OIDS);
  });
});
