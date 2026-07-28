// Git object model: type tags, oid computation, commit/tree/tag codecs.

import { bytesToHex, hexToBytes, sha1Hex } from './sha1';
import { concatBytes } from './pkt';

export const OBJ_COMMIT = 1;
export const OBJ_TREE = 2;
export const OBJ_BLOB = 3;
export const OBJ_TAG = 4;
export const OBJ_OFS_DELTA = 6;
export const OBJ_REF_DELTA = 7;

export const TYPE_NAMES: Record<number, string> = {
  [OBJ_COMMIT]: 'commit',
  [OBJ_TREE]: 'tree',
  [OBJ_BLOB]: 'blob',
  [OBJ_TAG]: 'tag',
};

const enc = new TextEncoder();
const dec = new TextDecoder();

/** oid = SHA-1 of "<type> <size>\0" + raw content (loose-object header form). */
export async function oidOf(type: number, raw: Uint8Array): Promise<string> {
  const name = TYPE_NAMES[type];
  if (!name) throw new Error(`cannot hash object of type ${type}`);
  const header = enc.encode(`${name} ${raw.length}\0`);
  return sha1Hex(concatBytes([header, raw]));
}

export interface TreeEntry {
  mode: string; // "100644", "100755", "120000", "40000", "160000"
  name: string;
  oid: string;
}

export function parseTree(raw: Uint8Array): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < raw.length) {
    const sp = raw.indexOf(0x20, pos);
    const nul = raw.indexOf(0x00, sp);
    if (sp === -1 || nul === -1 || nul + 21 > raw.length) throw new Error('corrupt tree object');
    entries.push({
      mode: dec.decode(raw.subarray(pos, sp)),
      name: dec.decode(raw.subarray(sp + 1, nul)),
      oid: bytesToHex(raw.subarray(nul + 1, nul + 21)),
    });
    pos = nul + 21;
  }
  return entries;
}

/** Canonical git tree ordering: directories sort as "name/". */
function treeSortKey(e: TreeEntry): string {
  return e.mode === '40000' || e.mode === '040000' ? `${e.name}/` : e.name;
}

export function encodeTree(entries: TreeEntry[]): Uint8Array {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : 1));
  const parts: Uint8Array[] = [];
  for (const e of sorted) {
    parts.push(enc.encode(`${e.mode} ${e.name}\0`));
    parts.push(hexToBytes(e.oid));
  }
  return concatBytes(parts);
}

export interface CommitData {
  tree: string;
  parents: string[];
}

export function parseCommit(raw: Uint8Array): CommitData {
  const text = dec.decode(raw);
  const headerEnd = text.indexOf('\n\n');
  const header = headerEnd === -1 ? text : text.slice(0, headerEnd);
  let tree = '';
  const parents: string[] = [];
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5, 45);
    else if (line.startsWith('parent ')) parents.push(line.slice(7, 47));
  }
  if (!tree) throw new Error('corrupt commit object: no tree');
  return { tree, parents };
}

export function encodeCommit(o: {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}): Uint8Array {
  let s = `tree ${o.tree}\n`;
  for (const p of o.parents) s += `parent ${p}\n`;
  s += `author ${o.author}\ncommitter ${o.committer}\n\n${o.message}`;
  return enc.encode(s);
}

/** Target oid of an annotated tag object ("object <oid>" first line), or null. */
export function parseTagTarget(raw: Uint8Array): string | null {
  const text = dec.decode(raw.subarray(0, Math.min(raw.length, 48)));
  return text.startsWith('object ') ? text.slice(7, 47) : null;
}
