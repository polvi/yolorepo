// RepoDO: one Durable Object per repo. SQLite-backed git object store plus
// smart HTTP v1 endpoints and the /internal/* contract used by the front
// worker. The front worker is responsible for stripping and re-setting the
// trusted X-Fk-User / X-Fk-Owner headers; they are trusted verbatim here.

import { DurableObject } from 'cloudflare:workers';
import { ObjectStore } from './store';
import { advertiseUploadPack, handleUploadPack } from './upload-pack';
import { advertiseReceivePack, handleReceivePack } from './receive-pack';
import { closure } from './walk';
import { buildPack } from './pack-write';
import { parsePack } from './pack-read';
import {
  OBJ_BLOB,
  OBJ_COMMIT,
  OBJ_TREE,
  encodeCommit,
  encodeTree,
  parseCommit,
  parseTree,
  type TreeEntry,
} from './objects';

// Minimal local Env: this module must not import types from files outside git/.
export interface Env {
  REPO?: unknown;
}

const enc = new TextEncoder();
const TREE_CACHE_MAX = 4;
const INIT_AUTHOR = 'forkable <system@forkable> 1753600000 +0000';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Nested directory structure: file name -> blob oid, dir name -> subtree. */
type DirNode = Map<string, DirNode | string>;

export class RepoDO extends DurableObject<Env> {
  private store: ObjectStore;
  /** commitOid -> (path -> blob oid), LRU of TREE_CACHE_MAX (Map preserves insertion order). */
  private treeCache = new Map<string, Map<string, string>>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new ObjectStore(ctx.storage.sql);
    ctx.blockConcurrencyWhile(async () => {
      this.store.init();
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;
    try {
      switch (route) {
        case 'GET /info/refs':
          return this.infoRefs(url);
        case 'POST /git-upload-pack':
          return handleUploadPack(this.store, new Uint8Array(await request.arrayBuffer()));
        case 'POST /git-receive-pack':
          return handleReceivePack(this.store, new Uint8Array(await request.arrayBuffer()), {
            user: request.headers.get('X-Fk-User'),
            isOwner: request.headers.get('X-Fk-Owner') === '1',
          });
        case 'POST /internal/init':
          return this.internalInit((await request.json()) as { files: Record<string, string> });
        case 'GET /internal/export':
          return this.internalExport(url);
        case 'POST /internal/import':
          return this.internalImport(url, new Uint8Array(await request.arrayBuffer()));
        case 'GET /internal/file':
          return this.internalFile(url, request);
        case 'GET /internal/refs':
          return json({ refs: this.store.getRefs(), head: this.store.getHead() });
        case 'POST /internal/destroy': {
          this.treeCache.clear();
          await this.ctx.storage.deleteAll();
          this.store.init(); // keep this live instance usable after a wipe
          return json({ ok: true });
        }
        default:
          return json({ error: 'not found' }, 404);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return json({ error: msg }, 500);
    }
  }

  // --- smart HTTP ------------------------------------------------------------

  private infoRefs(url: URL): Response {
    const service = url.searchParams.get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      return json({ error: 'unsupported service' }, 400);
    }
    const body =
      service === 'git-upload-pack'
        ? advertiseUploadPack(this.store)
        : advertiseReceivePack(this.store);
    return new Response(body, {
      headers: {
        'Content-Type': `application/x-${service}-advertisement`,
        'Cache-Control': 'no-cache',
      },
    });
  }

  // --- internal contract -----------------------------------------------------

  private async internalInit(body: { files: Record<string, string> }): Promise<Response> {
    const head = this.store.getHead();
    if (this.store.getRef(head)) return json({ error: 'repo already initialized' }, 409);
    if (!body?.files || Object.keys(body.files).length === 0) {
      return json({ error: 'files required' }, 400);
    }

    const root: DirNode = new Map();
    for (const [path, content] of Object.entries(body.files)) {
      const parts = path.split('/').filter(Boolean);
      if (parts.length === 0) return json({ error: `invalid path: ${path}` }, 400);
      const oid = await this.store.put(OBJ_BLOB, enc.encode(content));
      let node = root;
      for (const part of parts.slice(0, -1)) {
        let next = node.get(part);
        if (typeof next === 'string') return json({ error: `path conflict at ${part}` }, 400);
        if (!next) {
          next = new Map();
          node.set(part, next);
        }
        node = next;
      }
      node.set(parts[parts.length - 1], oid);
    }

    const writeTree = async (node: DirNode): Promise<string> => {
      const entries: TreeEntry[] = [];
      for (const [name, v] of node) {
        if (typeof v === 'string') entries.push({ mode: '100644', name, oid: v });
        else entries.push({ mode: '40000', name, oid: await writeTree(v) });
      }
      return this.store.put(OBJ_TREE, encodeTree(entries));
    };
    const treeOid = await writeTree(root);
    const commitOid = await this.store.put(
      OBJ_COMMIT,
      encodeCommit({
        tree: treeOid,
        parents: [],
        author: INIT_AUTHOR,
        committer: INIT_AUTHOR,
        message: 'Initial commit\n',
      })
    );
    this.store.setRef(head, commitOid);
    return json({ ok: true, oid: commitOid, ref: head });
  }

  private async internalExport(url: URL): Promise<Response> {
    const ref = url.searchParams.get('ref') ?? this.store.getHead();
    const oid = this.store.getRef(ref);
    if (!oid) return json({ error: `ref not found: ${ref}` }, 404);
    const pack = await buildPack(this.store, closure(this.store, [oid]));
    return new Response(pack, {
      headers: { 'Content-Type': 'application/octet-stream', 'X-Head-Oid': oid },
    });
  }

  private async internalImport(url: URL, pack: Uint8Array): Promise<Response> {
    const ref = url.searchParams.get('ref') ?? this.store.getHead();
    const oid = url.searchParams.get('oid');
    if (!oid || !/^[0-9a-f]{40}$/.test(oid)) return json({ error: 'oid required' }, 400);
    if (pack.length > 0) {
      const objects = await parsePack(pack, (base) => {
        const o = this.store.getContent(base);
        return o ? { type: o.type, raw: o.content } : null;
      });
      for (const o of objects) this.store.putRaw(o.oid, o.type, o.raw);
    }
    if (!this.store.has(oid)) return json({ error: `oid ${oid} not present after import` }, 400);
    this.store.setRef(ref, oid);
    return json({ ok: true, ref, oid });
  }

  private internalFile(url: URL, request: Request): Response {
    const ref = url.searchParams.get('ref') ?? this.store.getHead();
    const commitOid = this.store.getRef(ref);
    if (!commitOid) return json({ error: `ref not found: ${ref}` }, 404);
    const map = this.pathMap(commitOid);

    const raw = (url.searchParams.get('path') ?? '').replace(/^\/+/, '');
    const clean = raw.replace(/\/+$/, '');
    // Exact file first; "" and directory paths fall through to index.html.
    let blobOid = clean === '' ? undefined : map.get(clean);
    if (!blobOid) blobOid = map.get(clean === '' ? 'index.html' : `${clean}/index.html`);
    if (!blobOid) return json({ error: 'not found' }, 404);

    const etag = `"${blobOid}"`;
    const headers: Record<string, string> = { ETag: etag, 'X-Blob-Oid': blobOid };
    const inm = request.headers.get('If-None-Match');
    if (inm && inm.includes(blobOid)) return new Response(null, { status: 304, headers });
    const obj = this.store.getContent(blobOid);
    if (!obj) return json({ error: 'blob missing' }, 500);
    // Content-Type is deliberately absent: the front worker owns mime mapping.
    return new Response(obj.content, { headers });
  }

  /** Flattened path -> blob oid map for a commit, with a small per-instance LRU. */
  private pathMap(commitOid: string): Map<string, string> {
    const cached = this.treeCache.get(commitOid);
    if (cached) {
      this.treeCache.delete(commitOid);
      this.treeCache.set(commitOid, cached);
      return cached;
    }
    const commit = this.store.getContent(commitOid);
    if (!commit || commit.type !== OBJ_COMMIT) throw new Error(`bad commit ${commitOid}`);
    const map = new Map<string, string>();
    const walkTree = (treeOid: string, prefix: string): void => {
      const t = this.store.getContent(treeOid);
      if (!t || t.type !== OBJ_TREE) throw new Error(`bad tree ${treeOid}`);
      for (const e of parseTree(t.content)) {
        if (e.mode === '40000' || e.mode === '040000') walkTree(e.oid, `${prefix}${e.name}/`);
        else if (e.mode !== '160000') map.set(`${prefix}${e.name}`, e.oid);
      }
    };
    walkTree(parseCommit(commit.content).tree, '');
    this.treeCache.set(commitOid, map);
    if (this.treeCache.size > TREE_CACHE_MAX) {
      this.treeCache.delete(this.treeCache.keys().next().value!);
    }
    return map;
  }
}
