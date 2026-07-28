// Test helpers: isomorphic-git http plugin over SELF.fetch, memfs client fs,
// and hand-rolled pack construction for codec tests.

import { SELF } from 'cloudflare:test';
import { createFsFromVolume, Volume } from 'memfs';
import { concatBytes } from '../worker/git/pkt';
import { packObjectHeader } from '../worker/git/pack-write';
import { sha1 } from '../worker/git/sha1';
import { deflate } from '../worker/git/zlib';

// --- isomorphic-git plumbing -------------------------------------------------

type HttpHeaders = Record<string, string>;

interface GitHttpRequest {
  url: string;
  method?: string;
  headers?: HttpHeaders;
  body?: AsyncIterableIterator<Uint8Array> | Iterable<Uint8Array>;
}

async function collect(body: GitHttpRequest['body']): Promise<Uint8Array | undefined> {
  if (!body) return undefined;
  const chunks: Uint8Array[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array>) chunks.push(chunk);
  return concatBytes(chunks);
}

/** isomorphic-git `http` plugin routed through the test worker via SELF.fetch. */
export const http = {
  async request({ url, method = 'GET', headers = {}, body }: GitHttpRequest) {
    const buf = await collect(body);
    const res = await SELF.fetch(url, { method, headers, body: buf });
    const resBody = new Uint8Array(await res.arrayBuffer());
    const resHeaders: HttpHeaders = {};
    res.headers.forEach((v, k) => {
      resHeaders[k] = v;
    });
    async function* iterate() {
      yield resBody;
    }
    return {
      url: res.url,
      method,
      statusCode: res.status,
      statusMessage: res.statusText,
      body: iterate(),
      headers: resHeaders,
    };
  },
};

export function makeClientFs() {
  const vol = new Volume();
  return { fs: createFsFromVolume(vol), vol };
}

export const AUTHOR = { name: 'Test User', email: 'test@example.com' };

export function repoUrl(name: string): string {
  return `https://example.com/repo/${name}`;
}

export const OWNER_HEADERS = { 'x-test-user': 'owner1', 'x-test-owner': '1' };
export const U2_HEADERS = { 'x-test-user': 'u2' };

// --- raw pack construction ---------------------------------------------------

export interface RawPackEntry {
  /** 1..4 for full objects; 6 (ofs) / 7 (ref) for deltas. */
  type: number;
  data: Uint8Array; // raw content, or delta instruction stream
  baseOffsetDistance?: number; // ofs-delta: entryOffset - baseOffset
  baseOid?: string; // ref-delta
}

function encodeOfsDeltaDistance(distance: number): Uint8Array {
  // Inverse of the reader: value = ((value + 1) << 7) | septet, little group last.
  const septets = [distance & 0x7f];
  distance = Math.floor(distance / 128) - 1;
  while (distance >= 0) {
    septets.unshift(distance & 0x7f);
    distance = Math.floor(distance / 128) - 1;
  }
  return new Uint8Array(septets.map((s, i) => (i < septets.length - 1 ? s | 0x80 : s)));
}

function hexToBytesLocal(hexStr: string): Uint8Array {
  const out = new Uint8Array(hexStr.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hexStr.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Build a syntactically valid pack from explicit entries (deflating each). */
export async function makePack(entries: RawPackEntry[]): Promise<Uint8Array> {
  const header = new Uint8Array(12);
  header.set([0x50, 0x41, 0x43, 0x4b]);
  const dv = new DataView(header.buffer);
  dv.setUint32(4, 2);
  dv.setUint32(8, entries.length);
  const parts: Uint8Array[] = [header];
  let offset = 12;
  const offsets: number[] = [];
  for (const e of entries) {
    offsets.push(offset);
    const chunk: Uint8Array[] = [packObjectHeader(e.type, e.data.length)];
    if (e.type === 6) chunk.push(encodeOfsDeltaDistance(e.baseOffsetDistance!));
    if (e.type === 7) chunk.push(hexToBytesLocal(e.baseOid!));
    chunk.push(deflate(e.data));
    const bytes = concatBytes(chunk);
    parts.push(bytes);
    offset += bytes.length;
  }
  const body = concatBytes(parts);
  return concatBytes([body, await sha1(body)]);
}

/** A structurally valid pack containing zero objects (delete-only pushes). */
export async function emptyPack(): Promise<Uint8Array> {
  return makePack([]);
}

/** Build a delta instruction stream: literal insert of `insert`, then copy [ofs,len) from base. */
export function makeDelta(
  srcSize: number,
  tgtSize: number,
  ops: Array<{ insert?: Uint8Array; copy?: { offset: number; size: number } }>
): Uint8Array {
  const sizeVarint = (n: number): number[] => {
    const out: number[] = [];
    do {
      out.push(n & 0x7f);
      n = Math.floor(n / 128);
    } while (n > 0);
    return out.map((b, i) => (i < out.length - 1 ? b | 0x80 : b));
  };
  const bytes: number[] = [...sizeVarint(srcSize), ...sizeVarint(tgtSize)];
  for (const op of ops) {
    if (op.insert) {
      if (op.insert.length === 0 || op.insert.length > 127) throw new Error('bad insert size');
      bytes.push(op.insert.length, ...op.insert);
    } else if (op.copy) {
      const { offset, size } = op.copy;
      let cmd = 0x80;
      const args: number[] = [];
      if (offset & 0xff) {
        cmd |= 0x01;
        args.push(offset & 0xff);
      }
      if ((offset >> 8) & 0xff) {
        cmd |= 0x02;
        args.push((offset >> 8) & 0xff);
      }
      if ((offset >> 16) & 0xff) {
        cmd |= 0x04;
        args.push((offset >> 16) & 0xff);
      }
      if (size & 0xff) {
        cmd |= 0x10;
        args.push(size & 0xff);
      }
      if ((size >> 8) & 0xff) {
        cmd |= 0x20;
        args.push((size >> 8) & 0xff);
      }
      bytes.push(cmd, ...args);
    }
  }
  return new Uint8Array(bytes);
}

export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const te = new TextEncoder();
export const td = new TextDecoder();
