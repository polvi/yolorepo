// Internal contract tests (/internal/*) plus raw-wire receive-pack edge cases
// that a well-behaved client cannot produce (stale old-oid, oversize file).

import { describe, expect, it } from 'vitest';
import { SELF } from 'cloudflare:test';
import { FLUSH, concatBytes, pktLine } from '../worker/git/pkt';
import { OBJ_BLOB, oidOf } from '../worker/git/objects';
import { MAX_FILE_BYTES } from '../worker/git/receive-pack';
import { makePack, repoUrl, td, te, OWNER_HEADERS } from './helpers';

const ZERO = '0'.repeat(40);

async function initRepo(name: string, files: Record<string, string>) {
  const res = await SELF.fetch(`${repoUrl(name)}/internal/init`, {
    method: 'POST',
    body: JSON.stringify({ files }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { oid: string };
}

async function rawPush(name: string, command: string, pack: Uint8Array): Promise<string> {
  const body = concatBytes([pktLine(`${command}\0report-status agent=git/test\n`), FLUSH, pack]);
  const res = await SELF.fetch(`${repoUrl(name)}/git-receive-pack`, {
    method: 'POST',
    headers: { ...OWNER_HEADERS, 'Content-Type': 'application/x-git-receive-pack-request' },
    body,
  });
  expect(res.status).toBe(200);
  return td.decode(new Uint8Array(await res.arrayBuffer()));
}

describe('internal contract', () => {
  it('init is create-once and returns the head commit oid', async () => {
    const { oid } = await initRepo('i1', { 'index.html': 'x' });
    expect(oid).toMatch(/^[0-9a-f]{40}$/);
    const again = await SELF.fetch(`${repoUrl('i1')}/internal/init`, {
      method: 'POST',
      body: JSON.stringify({ files: { 'index.html': 'y' } }),
    });
    expect(again.status).toBe(409);
  });

  it('serves files with ETag/304, index.html fallbacks, and X-Blob-Oid', async () => {
    await initRepo('i2', {
      'index.html': '<h1>root</h1>',
      'docs/index.html': '<p>docs</p>',
      'a/b/c.txt': 'deep',
    });
    const base = `${repoUrl('i2')}/internal/file?ref=refs/heads/main`;

    const root = await SELF.fetch(`${base}&path=`);
    expect(root.status).toBe(200);
    expect(await root.text()).toBe('<h1>root</h1>');
    const etag = root.headers.get('ETag')!;
    expect(etag).toContain(root.headers.get('X-Blob-Oid')!);
    expect(root.headers.get('Content-Type')).toBeNull(); // mime is the front worker's job

    const cached = await SELF.fetch(`${base}&path=`, { headers: { 'If-None-Match': etag } });
    expect(cached.status).toBe(304);

    // Directory paths fall through to their index.html, with or without slash.
    for (const p of ['docs', 'docs/']) {
      const docs = await SELF.fetch(`${base}&path=${p}`);
      expect(docs.status).toBe(200);
      expect(await docs.text()).toBe('<p>docs</p>');
    }
    const deep = await SELF.fetch(`${base}&path=a/b/c.txt`);
    expect(await deep.text()).toBe('deep');
    const missing = await SELF.fetch(`${base}&path=nope.txt`);
    expect(missing.status).toBe(404);
  });

  it('export/import reproduces the tree in a second repo (fork-on-create)', async () => {
    const files = { 'index.html': '<h1>fork me</h1>', 'sub/data.json': '{"n":1}' };
    const { oid } = await initRepo('i3src', files);

    const exp = await SELF.fetch(`${repoUrl('i3src')}/internal/export?ref=refs/heads/main`);
    expect(exp.status).toBe(200);
    expect(exp.headers.get('X-Head-Oid')).toBe(oid);
    const pack = await exp.arrayBuffer();

    const imp = await SELF.fetch(
      `${repoUrl('i3dst')}/internal/import?ref=refs/heads/main&oid=${oid}`,
      { method: 'POST', body: pack }
    );
    expect(imp.status).toBe(200);

    const refs = (await (await SELF.fetch(`${repoUrl('i3dst')}/internal/refs`)).json()) as {
      refs: Record<string, string>;
    };
    expect(refs.refs['refs/heads/main']).toBe(oid);
    for (const [path, content] of Object.entries(files)) {
      const res = await SELF.fetch(`${repoUrl('i3dst')}/internal/file?path=${path}`);
      expect(await res.text()).toBe(content);
    }
  });

  it('destroy wipes the repo', async () => {
    await initRepo('i4', { 'index.html': 'x' });
    const destroy = await SELF.fetch(`${repoUrl('i4')}/internal/destroy`, { method: 'POST' });
    expect(destroy.status).toBe(200);
    const refs = (await (await SELF.fetch(`${repoUrl('i4')}/internal/refs`)).json()) as {
      refs: Record<string, string>;
    };
    expect(refs.refs).toEqual({});
  });
});

describe('receive-pack wire edge cases', () => {
  it('rejects a stale old-oid with ng (CAS)', async () => {
    const { oid } = await initRepo('w1', { 'index.html': 'x' });
    const stale = 'a'.repeat(40);
    const report = await rawPush('w1', `${stale} ${oid} refs/heads/main`, await makePack([]));
    expect(report).toContain('unpack ok');
    expect(report).toContain('ng refs/heads/main stale info');
  });

  it('rejects a file over the 1.5 MiB limit with a clear message', async () => {
    await initRepo('w2', { 'index.html': 'x' });
    const big = new Uint8Array(MAX_FILE_BYTES + 1).fill(0x78);
    const bigOid = await oidOf(OBJ_BLOB, big);
    const pack = await makePack([{ type: OBJ_BLOB, data: big }]);
    const report = await rawPush('w2', `${ZERO} ${bigOid} refs/forks/owner1`, pack);
    expect(report).toContain('unpack error');
    expect(report).toContain('maximum file size');
    expect(report).toContain('ng refs/forks/owner1 unpacker error');
  });

  it('refuses refs outside main and forks namespaces', async () => {
    const { oid } = await initRepo('w3', { 'index.html': 'x' });
    const report = await rawPush('w3', `${ZERO} ${oid} refs/tags/v1`, await makePack([]));
    expect(report).toContain('ng refs/tags/v1 ref not allowed');
  });

  it('rejects a new oid whose objects were never sent', async () => {
    await initRepo('w4', { 'index.html': 'x' });
    const head = ((await (await SELF.fetch(`${repoUrl('w4')}/internal/refs`)).json()) as {
      refs: Record<string, string>;
    }).refs['refs/heads/main'];
    const phantom = 'b'.repeat(40);
    const report = await rawPush('w4', `${head} ${phantom} refs/heads/main`, await makePack([]));
    expect(report).toContain('ng refs/heads/main missing necessary objects');
  });
});
