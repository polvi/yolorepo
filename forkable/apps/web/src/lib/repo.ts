import git from 'isomorphic-git';
import http from 'isomorphic-git/http/web';
import LightningFS from '@isomorphic-git/lightning-fs';
import { forkRefFor } from '@forkable/shared';

// One repo per site origin (IndexedDB is origin-scoped, so a fixed name is
// already per-site). The working tree lives at /site; the local editing
// branch is 'draft', pushed (force) to refs/forks/<uid> on the server.

export const FS_NAME = 'forkable';
export const DIR = '/site';
const DRAFT = 'draft';

const fs = new LightningFS(FS_NAME);
const pfs = fs.promises;

const gitUrl = () => `${location.origin}/__forkable__/git`;

const base = { fs, dir: DIR };
const remote = { http, url: gitUrl() };

async function exists(path: string): Promise<boolean> {
  try {
    await pfs.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Clone if needed; put the working tree on the user's draft branch. */
export async function ensureRepo(userId: string): Promise<void> {
  if (!(await exists(`${DIR}/.git`))) {
    await git.clone({ ...base, ...remote, ref: 'main', singleBranch: true });
  }
  const branches = await git.listBranches(base);
  if (!branches.includes(DRAFT)) {
    // Resume a server-side fork if one exists, else branch from main.
    let start = await git.resolveRef({ ...base, ref: 'main' });
    try {
      const { fetchHead } = await git.fetch({
        ...base,
        ...remote,
        ref: forkRefFor(userId),
        singleBranch: true,
      });
      if (fetchHead) start = fetchHead;
    } catch {
      // no fork ref on the server yet
    }
    await git.branch({ ...base, ref: DRAFT, object: start });
  }
  await git.checkout({ ...base, ref: DRAFT, force: true });
}

export async function listFiles(): Promise<string[]> {
  const out: string[] = [];
  async function walk(rel: string): Promise<void> {
    for (const entry of await pfs.readdir(`${DIR}${rel}`)) {
      if (entry === '.git') continue;
      const relPath = `${rel}/${entry}`;
      const stat = await pfs.stat(`${DIR}${relPath}`);
      if (stat.isDirectory()) await walk(relPath);
      else out.push(relPath.slice(1));
    }
  }
  await walk('');
  return out.sort();
}

export async function readFile(path: string): Promise<string> {
  return (await pfs.readFile(`${DIR}/${path}`, 'utf8')) as string;
}

export async function writeFile(path: string, content: string): Promise<void> {
  const parts = path.split('/').slice(0, -1);
  let acc = DIR;
  for (const part of parts) {
    acc += `/${part}`;
    if (!(await exists(acc))) await pfs.mkdir(acc);
  }
  await pfs.writeFile(`${DIR}/${path}`, content, 'utf8');
}

export async function deleteFile(path: string): Promise<void> {
  await pfs.unlink(`${DIR}/${path}`);
}

/** Stage everything, commit, force-push the draft to the user's fork ref. */
export async function commitAndPush(userId: string, message: string): Promise<string> {
  const matrix = await git.statusMatrix(base);
  for (const [filepath, , worktree] of matrix) {
    if (worktree === 0) await git.remove({ ...base, filepath });
    else await git.add({ ...base, filepath });
  }
  const sha = await git.commit({
    ...base,
    message: message || 'edit',
    author: { name: userId, email: `${userId}@forkable` },
  });
  await git.push({
    ...base,
    ...remote,
    ref: DRAFT,
    remoteRef: forkRefFor(userId),
    force: true,
  });
  return sha;
}
