// git-receive-pack (push), smart HTTP protocol v1 with report-status.
//
// Trust model: the front worker authenticates the user and forwards identity
// via X-Fk-User (user id) and X-Fk-Owner ("1" when the requester owns the
// repo). Policy per ref:
//   - refs/heads/main (the head ref): owner only
//   - refs/forks/<uid>: only when <uid> === X-Fk-User (single path segment)
//   - anything else: refused ("ref not allowed")
// Old-oid CAS is always enforced; non-fast-forward is allowed on refs you own.

import { FLUSH, concatBytes, parsePktLines, pktLine, pktText, sidebandChunks } from './pkt';
import { OBJ_BLOB } from './objects';
import { ZERO_OID, type ObjectStore } from './store';
import { parsePack, type PackedObject } from './pack-read';

const RECEIVE_CAPS = 'report-status delete-refs side-band-64k agent=git/forkable';

/** 1.5 MiB per file (inflated blob). Keeps every row well under the 2 MB DO SQLite value limit. */
export const MAX_FILE_BYTES = 1_572_864;
/** Cap on the raw pack body of a single push. */
export const MAX_PACK_BYTES = 20 * 1024 * 1024;

export function advertiseReceivePack(store: ObjectStore): Uint8Array {
  const parts: Uint8Array[] = [pktLine('# service=git-receive-pack\n'), FLUSH];
  const refs = store.getRefs();
  const names = Object.keys(refs).sort();
  if (names.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${RECEIVE_CAPS}\n`));
  } else {
    parts.push(pktLine(`${refs[names[0]]} ${names[0]}\0${RECEIVE_CAPS}\n`));
    for (const name of names.slice(1)) parts.push(pktLine(`${refs[name]} ${name}\n`));
  }
  parts.push(FLUSH);
  return concatBytes(parts);
}

export interface PushAuth {
  user: string | null;
  isOwner: boolean;
}

interface Command {
  old: string;
  nu: string;
  ref: string;
}

interface RefResult {
  ref: string;
  ok: boolean;
  msg?: string;
}

export async function handleReceivePack(
  store: ObjectStore,
  body: Uint8Array,
  auth: PushAuth
): Promise<Response> {
  let parsed;
  try {
    parsed = parsePktLines(body, 0, 1); // command list ends at the first flush
  } catch {
    return new Response('bad pkt-line in receive-pack request', { status: 400 });
  }

  const commands: Command[] = [];
  let caps = '';
  for (const p of parsed.pkts) {
    if (p.kind === 'flush') break;
    let text = pktText(p);
    if (commands.length === 0) {
      const nul = text.indexOf('\0');
      if (nul !== -1) {
        caps = text.slice(nul + 1);
        text = text.slice(0, nul);
      }
    }
    const m = text.match(/^([0-9a-f]{40}) ([0-9a-f]{40}) (.+)$/);
    if (!m) return new Response(`malformed push command: ${text}`, { status: 400 });
    commands.push({ old: m[1], nu: m[2], ref: m[3] });
  }
  const sideband = /\bside-band-64k\b/.test(caps);
  const packBytes = body.subarray(parsed.offset);

  const report = (unpackMsg: string, results: RefResult[]): Response => {
    const parts: Uint8Array[] = [pktLine(`unpack ${unpackMsg}\n`)];
    for (const r of results) {
      parts.push(pktLine(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.msg ?? 'failed'}\n`));
    }
    parts.push(FLUSH);
    let payload = concatBytes(parts);
    if (sideband) payload = concatBytes([...sidebandChunks(1, payload), FLUSH]);
    return new Response(payload, {
      headers: {
        'Content-Type': 'application/x-git-receive-pack-result',
        'Cache-Control': 'no-cache',
      },
    });
  };
  const allNg = (msg: string): RefResult[] =>
    commands.map((c) => ({ ref: c.ref, ok: false, msg }));

  if (commands.length === 0) return report('ok', []);

  // --- unpack (all async work: inflate + SHA-1) ------------------------------
  if (packBytes.length > MAX_PACK_BYTES) {
    return report(
      `error pack exceeds maximum size of ${MAX_PACK_BYTES} bytes (20 MiB)`,
      allNg('unpacker error')
    );
  }
  let objects: PackedObject[] = [];
  if (packBytes.length > 0) {
    try {
      objects = await parsePack(packBytes, (oid) => {
        const o = store.getContent(oid);
        return o ? { type: o.type, raw: o.content } : null;
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unpack failed';
      return report(`error ${msg}`, allNg('unpacker error'));
    }
  }
  for (const o of objects) {
    if (o.type === OBJ_BLOB && o.raw.length > MAX_FILE_BYTES) {
      return report(
        `error file ${o.oid} is ${o.raw.length} bytes; maximum file size is ${MAX_FILE_BYTES} bytes (1.5 MiB)`,
        allNg('unpacker error')
      );
    }
  }

  // Write objects idempotently (content-addressed) BEFORE any ref update.
  for (const o of objects) store.putRaw(o.oid, o.type, o.raw);

  // --- ref updates: one synchronous CAS block --------------------------------
  // No awaits between the reads and writes below; all SHA-1/inflate work is
  // done. DO input gates therefore make each push's check-and-set atomic.
  const head = store.getHead();
  const results: RefResult[] = commands.map((c): RefResult => {
    if (c.ref === head) {
      if (!auth.isOwner) return { ref: c.ref, ok: false, msg: 'permission denied' };
    } else if (c.ref.startsWith('refs/forks/')) {
      const uid = c.ref.slice('refs/forks/'.length);
      if (!uid || uid.includes('/') || uid !== auth.user) {
        return { ref: c.ref, ok: false, msg: 'permission denied' };
      }
    } else {
      return { ref: c.ref, ok: false, msg: 'ref not allowed' };
    }
    const current = store.getRef(c.ref) ?? ZERO_OID;
    if (current !== c.old) {
      return { ref: c.ref, ok: false, msg: `stale info: ref is at ${current}, expected ${c.old}` };
    }
    if (c.nu === ZERO_OID) {
      store.deleteRef(c.ref);
      return { ref: c.ref, ok: true };
    }
    if (!store.has(c.nu)) {
      return { ref: c.ref, ok: false, msg: 'missing necessary objects' };
    }
    store.setRef(c.ref, c.nu);
    return { ref: c.ref, ok: true };
  });

  return report('ok', results);
}
