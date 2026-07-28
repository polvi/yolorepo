// End-to-end smart HTTP tests with isomorphic-git as the client (memfs client
// fs, http plugin over SELF.fetch through the test router worker).
// vitest-pool-workers isolates storage per test, so each test is a full flow.

import { describe, expect, it } from 'vitest';
import { SELF } from 'cloudflare:test';
import git from 'isomorphic-git';
import {
  AUTHOR,
  OWNER_HEADERS,
  U2_HEADERS,
  http,
  makeClientFs,
  repoUrl,
  td,
} from './helpers';

const INIT_FILES = {
  'index.html': '<!doctype html><h1>hello forkable</h1>\n',
  'assets/app.js': "console.log('hi');\n",
  'docs/index.html': '<p>docs</p>\n',
};

async function initRepo(name: string, files: Record<string, string> = INIT_FILES) {
  const res = await SELF.fetch(`${repoUrl(name)}/internal/init`, {
    method: 'POST',
    body: JSON.stringify({ files }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { oid: string };
}

async function getRefs(name: string): Promise<{ refs: Record<string, string>; head: string }> {
  const res = await SELF.fetch(`${repoUrl(name)}/internal/refs`);
  expect(res.status).toBe(200);
  return res.json();
}

async function cloneRepo(name: string, dir = '/repo') {
  const { fs } = makeClientFs();
  await git.clone({ fs, http, dir, url: repoUrl(name) });
  return { fs, dir };
}

async function commitFile(
  fs: ReturnType<typeof makeClientFs>['fs'],
  dir: string,
  path: string,
  content: string,
  message: string
): Promise<string> {
  await fs.promises.writeFile(`${dir}/${path}`, content);
  await git.add({ fs, dir, filepath: path });
  return git.commit({ fs, dir, message, author: AUTHOR });
}

/** Push and tolerate both isomorphic-git failure modes (throw vs result.error). */
async function tryPush(opts: Parameters<typeof git.push>[0]) {
  try {
    const result = await git.push(opts);
    const refErrors = Object.values(result.refs ?? {}).some((r) => !r.ok || r.error);
    return { rejected: !result.ok || refErrors, result };
  } catch (err) {
    return { rejected: true, error: err };
  }
}

describe('clone and fetch', () => {
  it('advertises an empty repo cleanly and getRemoteInfo parses it', async () => {
    const advert = await SELF.fetch(`${repoUrl('empty')}/info/refs?service=git-upload-pack`);
    expect(advert.status).toBe(200);
    expect(advert.headers.get('Content-Type')).toBe('application/x-git-upload-pack-advertisement');
    const body = td.decode(new Uint8Array(await advert.arrayBuffer()));
    expect(body).toBe('001e# service=git-upload-pack\n00000000');

    const info = await git.getRemoteInfo({ http, url: repoUrl('empty') });
    expect(Object.keys(info.refs ?? {})).toEqual([]);
  });

  it('clones an initialized repo byte-for-byte', async () => {
    await initRepo('c1');
    const { fs, dir } = await cloneRepo('c1');
    for (const [path, content] of Object.entries(INIT_FILES)) {
      const got = await fs.promises.readFile(`${dir}/${path}`, 'utf8');
      expect(got).toBe(content);
    }
    const branch = await git.currentBranch({ fs, dir });
    expect(branch).toBe('main');
  });
});

describe('push', () => {
  it('accepts a push to refs/heads/main from the owner and serves the result', async () => {
    await initRepo('p1');
    const { fs, dir } = await cloneRepo('p1');
    const sha = await commitFile(fs, dir, 'new.txt', 'pushed content\n', 'add new.txt');
    const { rejected, result } = await tryPush({
      fs,
      http,
      dir,
      remote: 'origin',
      ref: 'main',
      headers: OWNER_HEADERS,
    });
    expect(rejected).toBe(false);
    expect(result?.ok).toBe(true);

    const refs = await getRefs('p1');
    expect(refs.refs['refs/heads/main']).toBe(sha);

    const file = await SELF.fetch(`${repoUrl('p1')}/internal/file?ref=refs/heads/main&path=new.txt`);
    expect(file.status).toBe(200);
    expect(await file.text()).toBe('pushed content\n');
  });

  it('supports a second push and an incremental fetch by a stale client', async () => {
    await initRepo('p2');
    const a = await cloneRepo('p2', '/a');
    const b = await cloneRepo('p2', '/b'); // b is now at commit 1

    await commitFile(a.fs, a.dir, 'one.txt', 'one\n', 'c2');
    const push1 = await tryPush({ fs: a.fs, http, dir: a.dir, ref: 'main', headers: OWNER_HEADERS });
    expect(push1.rejected).toBe(false);
    const sha3 = await commitFile(a.fs, a.dir, 'two.txt', 'two\n', 'c3');
    const push2 = await tryPush({ fs: a.fs, http, dir: a.dir, ref: 'main', headers: OWNER_HEADERS });
    expect(push2.rejected).toBe(false);

    await git.fetch({ fs: b.fs, http, dir: b.dir, remote: 'origin' });
    const remoteMain = await git.resolveRef({ fs: b.fs, dir: b.dir, ref: 'refs/remotes/origin/main' });
    expect(remoteMain).toBe(sha3);
  });

  it('allows refs/forks/<uid> for that user and refuses refs/heads/main', async () => {
    await initRepo('p3');
    const { fs, dir } = await cloneRepo('p3');
    await commitFile(fs, dir, 'fork.txt', 'fork change\n', 'fork commit');

    const forkPush = await tryPush({
      fs,
      http,
      dir,
      ref: 'main',
      remoteRef: 'refs/forks/u2',
      headers: U2_HEADERS,
    });
    expect(forkPush.rejected).toBe(false);
    expect((await getRefs('p3')).refs['refs/forks/u2']).toBeDefined();

    const mainPush = await tryPush({
      fs,
      http,
      dir,
      ref: 'main',
      remoteRef: 'refs/heads/main',
      headers: U2_HEADERS,
    });
    expect(mainPush.rejected).toBe(true);

    // Wrong user on someone else's fork ref is refused too.
    const wrongFork = await tryPush({
      fs,
      http,
      dir,
      ref: 'main',
      remoteRef: 'refs/forks/u3',
      headers: U2_HEADERS,
    });
    expect(wrongFork.rejected).toBe(true);
  });

  it('deletes a fork ref', async () => {
    await initRepo('p4');
    const { fs, dir } = await cloneRepo('p4');
    await commitFile(fs, dir, 'f.txt', 'f\n', 'fork');
    const push = await tryPush({ fs, http, dir, ref: 'main', remoteRef: 'refs/forks/u2', headers: U2_HEADERS });
    expect(push.rejected).toBe(false);
    expect((await getRefs('p4')).refs['refs/forks/u2']).toBeDefined();

    const del = await tryPush({ fs, http, dir, remoteRef: 'refs/forks/u2', delete: true, headers: U2_HEADERS });
    expect(del.rejected).toBe(false);
    expect((await getRefs('p4')).refs['refs/forks/u2']).toBeUndefined();
  });
});
