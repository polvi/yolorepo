#!/usr/bin/env bun
// Runs INSIDE the twin-runner pod (synced to /work/scripts by the client):
// the photo upload endpoint, plain HTTP on :8080 behind the caddy ingress at
// twin-upload.<baseDomain> (which terminates real TLS). Auth is a bearer
// token minted on first start. Content-addressed: files are keyed by wyhash
// (Bun.hash), the manifest is cached and lazily backfilled, writes are
// tmp+rename atomic — re-running the client resumes and never re-sends
// matching bytes.

import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs';

const ROOT = '/work/job/images';
const TOKEN_PATH = '/work/upload.token';
const MANIFEST_PATH = '/work/job/.manifest.json';
mkdirSync(ROOT, { recursive: true });

if (!existsSync(TOKEN_PATH)) {
  await Bun.write(TOKEN_PATH, crypto.getRandomValues(new Uint8Array(32)).toHex());
}
const token = (await Bun.file(TOKEN_PATH).text()).trim();

type Entry = { size: number; mtimeMs: number; hash: string };
let manifest: Record<string, Entry> = {};
try {
  manifest = (await Bun.file(MANIFEST_PATH).json()) as Record<string, Entry>;
} catch {
  /* fresh start */
}
let saveTimer: ReturnType<typeof setTimeout> | null = null;
function saveManifestSoon(): void {
  saveTimer ??= setTimeout(() => {
    saveTimer = null;
    void Bun.write(MANIFEST_PATH, JSON.stringify(manifest));
  }, 500);
}

const hashOf = (buf: ArrayBuffer): string => Bun.hash(buf).toString(16);
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/;

/** Manifest entry for an on-disk file, hashing lazily on size/mtime change. */
async function entryFor(name: string): Promise<Entry | null> {
  const path = `${ROOT}/${name}`;
  let st;
  try {
    st = statSync(path);
  } catch {
    return null;
  }
  const cached = manifest[name];
  if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) return cached;
  const entry: Entry = {
    size: st.size,
    mtimeMs: st.mtimeMs,
    hash: hashOf(await Bun.file(path).arrayBuffer()),
  };
  manifest[name] = entry;
  saveManifestSoon();
  return entry;
}

Bun.serve({
  port: 8080,
  hostname: '0.0.0.0',
  maxRequestBodySize: 1024 * 1024 * 1024,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.headers.get('authorization') !== `Bearer ${token}`) {
      return Response.json({ error: 'unauthorized' }, { status: 401 });
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      return Response.json({ ok: true });
    }

    if (req.method === 'GET' && url.pathname === '/manifest') {
      const files: Record<string, Entry> = {};
      for (const name of readdirSync(ROOT)) {
        if (name.startsWith('.')) continue;
        const e = await entryFor(name);
        if (e) files[name] = e;
      }
      return Response.json({ files });
    }

    const put = url.pathname.match(/^\/file\/([^/]+)$/);
    if (req.method === 'PUT' && put) {
      const name = decodeURIComponent(put[1]!);
      if (!NAME.test(name)) return Response.json({ error: 'bad name' }, { status: 400 });
      const body = await req.arrayBuffer();
      const hash = hashOf(body);
      const expected = req.headers.get('x-content-hash');
      if (expected && expected !== hash) {
        return Response.json({ error: 'hash mismatch (corrupt transfer)' }, { status: 422 });
      }
      const tmp = `${ROOT}/.tmp-${name}`;
      await Bun.write(tmp, body);
      renameSync(tmp, `${ROOT}/${name}`);
      const st = statSync(`${ROOT}/${name}`);
      manifest[name] = { size: st.size, mtimeMs: st.mtimeMs, hash };
      saveManifestSoon();
      return Response.json({ ok: true, hash, size: st.size });
    }

    return Response.json({ error: 'not found' }, { status: 404 });
  },
});

console.log(`[upload-server] listening on :8080 (root ${ROOT})`);
