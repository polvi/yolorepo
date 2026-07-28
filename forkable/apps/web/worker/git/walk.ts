// Object graph closure for pack building. BFS commits -> parents, walking each
// commit's tree into subtrees and blobs. `haves` is accepted for the protocol
// signature but v1 always builds the full closure of the wants.

import {
  OBJ_COMMIT,
  OBJ_TAG,
  OBJ_TREE,
  parseCommit,
  parseTagTarget,
  parseTree,
} from './objects';
import type { ObjectStore } from './store';

export function closure(store: ObjectStore, wants: string[], _haves?: Set<string>): string[] {
  const seen = new Set<string>();
  const order: string[] = [];

  const addBlob = (oid: string): void => {
    if (seen.has(oid)) return;
    if (!store.has(oid)) throw new Error(`missing object ${oid}`);
    seen.add(oid);
    order.push(oid);
  };

  const addTree = (treeOid: string): void => {
    if (seen.has(treeOid)) return;
    const obj = store.getContent(treeOid);
    if (!obj || obj.type !== OBJ_TREE) throw new Error(`missing tree ${treeOid}`);
    seen.add(treeOid);
    order.push(treeOid);
    for (const e of parseTree(obj.content)) {
      if (e.mode === '40000' || e.mode === '040000') addTree(e.oid);
      else if (e.mode === '160000') continue; // gitlink: commit in another repo, never stored
      else addBlob(e.oid);
    }
  };

  const queue = [...wants];
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    const obj = store.getContent(oid);
    if (!obj) throw new Error(`missing object ${oid}`);
    if (obj.type === OBJ_TREE) {
      addTree(oid);
      continue;
    }
    seen.add(oid);
    order.push(oid);
    if (obj.type === OBJ_COMMIT) {
      const c = parseCommit(obj.content);
      addTree(c.tree);
      for (const p of c.parents) queue.push(p);
    } else if (obj.type === OBJ_TAG) {
      const target = parseTagTarget(obj.content);
      if (target) queue.push(target);
    }
  }
  return order;
}
