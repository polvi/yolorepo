// git-upload-pack (fetch/clone), smart HTTP protocol v1.
// Deliberately minimal: no multi_ack, no thin-pack, no shallow, no ofs-delta.
// Every negotiation answers NAK + the full closure of the wants.

import { FLUSH, concatBytes, parsePktLines, pktLine, pktText, sidebandChunks } from './pkt';
import type { ObjectStore } from './store';
import { closure } from './walk';
import { buildPack } from './pack-write';

const AGENT = 'agent=git/forkable';

export function advertiseUploadPack(store: ObjectStore): Uint8Array {
  const parts: Uint8Array[] = [pktLine('# service=git-upload-pack\n'), FLUSH];
  const refs = store.getRefs();
  const head = store.getHead();
  const headOid = refs[head];
  const lines: string[] = [];
  if (headOid) lines.push(`${headOid} HEAD`);
  for (const name of Object.keys(refs).sort()) lines.push(`${refs[name]} ${name}`);
  if (lines.length === 0) {
    // Empty repo: no refs, no capability line (matches native git-upload-pack).
    parts.push(FLUSH);
    return concatBytes(parts);
  }
  const caps = `side-band-64k symref=HEAD:${head} ${AGENT}`;
  parts.push(pktLine(`${lines[0]}\0${caps}\n`));
  for (const line of lines.slice(1)) parts.push(pktLine(`${line}\n`));
  parts.push(FLUSH);
  return concatBytes(parts);
}

function errResponse(message: string): Response {
  return resultResponse(pktLine(`ERR ${message}\n`));
}

function resultResponse(body: Uint8Array): Response {
  return new Response(body, {
    headers: {
      'Content-Type': 'application/x-git-upload-pack-result',
      'Cache-Control': 'no-cache',
    },
  });
}

export async function handleUploadPack(store: ObjectStore, body: Uint8Array): Promise<Response> {
  let pkts;
  try {
    pkts = parsePktLines(body).pkts;
  } catch (err) {
    return errResponse(err instanceof Error ? err.message : 'bad request');
  }

  const wants: string[] = [];
  let caps = '';
  let hasDeepen = false;
  for (const p of pkts) {
    if (p.kind === 'flush') continue;
    const text = pktText(p);
    if (text.startsWith('want ')) {
      if (wants.length === 0) caps = text.slice(45).trim(); // caps ride on the first want line
      const oid = text.slice(5, 45);
      if (!/^[0-9a-f]{40}$/.test(oid)) return errResponse(`invalid want ${oid}`);
      wants.push(oid);
    } else if (text.startsWith('deepen')) {
      hasDeepen = true;
    }
    // have/done lines are read but ignored: we always send the full closure.
  }

  if (hasDeepen) return errResponse('shallow/deepen is not supported');
  if (wants.length === 0) return errResponse('no wants');
  for (const w of wants) {
    if (!store.has(w)) return errResponse(`upload-pack: not our ref ${w}`);
  }

  const sideband = /\bside-band-64k\b/.test(caps);
  let oids: string[];
  try {
    oids = closure(store, wants);
  } catch (err) {
    return errResponse(err instanceof Error ? err.message : 'closure failed');
  }
  const pack = await buildPack(store, oids);

  const parts: Uint8Array[] = [pktLine('NAK\n')];
  if (sideband) {
    parts.push(...sidebandChunks(1, pack));
    parts.push(FLUSH);
  } else {
    parts.push(pack);
  }
  return resultResponse(concatBytes(parts));
}
