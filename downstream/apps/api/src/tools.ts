// The MCP tool surface: interrogate a GitHub repo, publish what you
// learned, and track ideas/bugs — all attributed to the signed-in
// GitHub user, all public on the repo's downstream page.

import type { Env } from "./env";
import { webOrigin } from "./env";
import type { AuthedUser } from "./oauth";
import { github, GitHubError } from "./github";

export type ToolDef = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type ToolResult = { text: string; structured?: unknown };

const NOTE_KINDS = ["finding", "question", "guide"] as const;
const TRACKER_KINDS = ["idea", "bug"] as const;
const STATUSES = ["open", "accepted", "declined", "done"] as const;

const repoArgs = {
  owner: { type: "string", description: "GitHub owner (user or org)" },
  repo: { type: "string", description: "GitHub repository name" },
};

export const TOOLS: ToolDef[] = [
  {
    name: "whoami",
    description: "The GitHub identity this session is authenticated as, and how posts will be attributed.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "repo_overview",
    description:
      "Overview of a GitHub repository: metadata, default branch, languages, README, and its downstream page URL. Start here before publishing anything.",
    inputSchema: { type: "object", properties: repoArgs, required: ["owner", "repo"] },
  },
  {
    name: "repo_tree",
    description: "File tree of a repository at a ref (default branch if omitted). Recursive by default.",
    inputSchema: {
      type: "object",
      properties: { ...repoArgs, ref: { type: "string", description: "Branch, tag, or commit SHA" } },
      required: ["owner", "repo"],
    },
  },
  {
    name: "repo_file",
    description: "Read one file (or list one directory) from a repository at a path.",
    inputSchema: {
      type: "object",
      properties: { ...repoArgs, path: { type: "string" }, ref: { type: "string" } },
      required: ["owner", "repo", "path"],
    },
  },
  {
    name: "repo_search",
    description: "Search code inside one repository (GitHub code search syntax, scoped to the repo).",
    inputSchema: {
      type: "object",
      properties: { ...repoArgs, query: { type: "string" } },
      required: ["owner", "repo", "query"],
    },
  },
  {
    name: "publish_note",
    description:
      "Publish a note on the repository's public downstream page. Kinds: 'finding' (something you learned investigating the code), 'question' (for upstream or other users), 'guide' (how-to for other users/harnesses). Body is markdown. Returns the public URL.",
    inputSchema: {
      type: "object",
      properties: {
        ...repoArgs,
        kind: { type: "string", enum: [...NOTE_KINDS] },
        title: { type: "string", maxLength: 200 },
        body: { type: "string", description: "Markdown body", maxLength: 65536 },
      },
      required: ["owner", "repo", "kind", "title", "body"],
    },
  },
  {
    name: "tracker_create",
    description:
      "File an idea or bug on the repository's downstream tracker. This is NOT a pull request and no patch is expected from you; upstream implements what it accepts. Body is markdown: for bugs include repro steps and versions; for ideas include motivation. Returns the public URL.",
    inputSchema: {
      type: "object",
      properties: {
        ...repoArgs,
        kind: { type: "string", enum: [...TRACKER_KINDS] },
        title: { type: "string", maxLength: 200 },
        body: { type: "string", description: "Markdown body", maxLength: 65536 },
      },
      required: ["owner", "repo", "kind", "title", "body"],
    },
  },
  {
    name: "list_posts",
    description: "List posts (notes and tracker items) on a repository's downstream page, optionally filtered by kind or status.",
    inputSchema: {
      type: "object",
      properties: {
        ...repoArgs,
        kind: { type: "string", enum: [...NOTE_KINDS, ...TRACKER_KINDS] },
        status: { type: "string", enum: [...STATUSES] },
      },
      required: ["owner", "repo"],
    },
  },
  {
    name: "get_post",
    description: "Read one post and its comments by its per-repo number.",
    inputSchema: {
      type: "object",
      properties: { ...repoArgs, number: { type: "integer" } },
      required: ["owner", "repo", "number"],
    },
  },
  {
    name: "comment_post",
    description: "Comment on a post (markdown).",
    inputSchema: {
      type: "object",
      properties: { ...repoArgs, number: { type: "integer" }, body: { type: "string", maxLength: 65536 } },
      required: ["owner", "repo", "number", "body"],
    },
  },
  {
    name: "tracker_update_status",
    description:
      "Update the status of a tracker item you authored: open, accepted, declined, or done. (Repo owners on GitHub can also update items on their repos.)",
    inputSchema: {
      type: "object",
      properties: { ...repoArgs, number: { type: "integer" }, status: { type: "string", enum: [...STATUSES] } },
      required: ["owner", "repo", "number", "status"],
    },
  },
];

export class ToolError extends Error {}

export async function callTool(env: Env, user: AuthedUser, name: string, args: any): Promise<ToolResult> {
  const a = args ?? {};
  try {
    switch (name) {
      case "whoami":
        return json({
          login: user.login,
          name: user.name,
          attribution: `Posts publish publicly as @${user.login}`,
          site: webOrigin(env),
        });
      case "repo_overview":
        return repoOverview(env, user, str(a, "owner"), str(a, "repo"));
      case "repo_tree": {
        const { owner, repo } = pair(a);
        const ref = a.ref || (await github.repo(owner, repo, user.gh_token)).default_branch;
        const tree = await github.tree(owner, repo, ref, true, user.gh_token);
        const lines = (tree.tree as any[]).map((e) => `${e.type === "tree" ? "d" : "-"} ${e.path}${e.size != null ? ` (${e.size}b)` : ""}`);
        const truncated = tree.truncated ? "\n[truncated by GitHub — fetch subtrees via repo_file on directories]" : "";
        return { text: `${owner}/${repo}@${ref}\n${lines.join("\n")}${truncated}` };
      }
      case "repo_file": {
        const { owner, repo } = pair(a);
        return json(await github.file(owner, repo, str(a, "path"), a.ref, user.gh_token));
      }
      case "repo_search": {
        const { owner, repo } = pair(a);
        const r = await github.searchCode(owner, repo, str(a, "query"), user.gh_token);
        return json({
          total_count: r.total_count,
          items: (r.items as any[]).map((i) => ({ path: i.path, url: i.html_url })),
        });
      }
      case "publish_note":
        return createPost(env, user, a, NOTE_KINDS);
      case "tracker_create":
        return createPost(env, user, a, TRACKER_KINDS);
      case "list_posts":
        return listPosts(env, a);
      case "get_post":
        return getPost(env, a);
      case "comment_post":
        return commentPost(env, user, a);
      case "tracker_update_status":
        return updateStatus(env, user, a);
      default:
        throw new ToolError(`unknown tool: ${name}`);
    }
  } catch (e) {
    if (e instanceof GitHubError && e.status === 404) {
      throw new ToolError(`GitHub says not found — check owner/repo/path (and that the repo is public)`);
    }
    throw e;
  }
}

function str(a: any, key: string): string {
  const v = a[key];
  if (typeof v !== "string" || !v) throw new ToolError(`missing required argument: ${key}`);
  return v;
}
function pair(a: any) {
  const owner = str(a, "owner");
  const repo = str(a, "repo");
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) throw new ToolError("owner/repo may only contain [A-Za-z0-9._-]");
  return { owner, repo };
}
function json(v: unknown): ToolResult {
  return { text: JSON.stringify(v, null, 2), structured: v };
}
function pageUrl(env: Env, owner: string, repo: string, number?: number) {
  return `${webOrigin(env)}/gh/${owner}/${repo}${number ? `/${number}` : ""}`;
}

async function repoOverview(env: Env, user: AuthedUser, owner: string, repo: string): Promise<ToolResult> {
  const r = await github.repo(owner, repo, user.gh_token);
  const readme = await github.readme(owner, repo, user.gh_token);
  const counts = await env.DB.prepare(
    `SELECT p.kind, COUNT(*) AS n FROM posts p JOIN repos r ON r.id = p.repo_id
      WHERE r.owner = ? AND r.name = ? GROUP BY p.kind`,
  )
    .bind(owner, repo)
    .all<any>();
  return json({
    full_name: r.full_name,
    description: r.description,
    default_branch: r.default_branch,
    language: r.language,
    license: r.license?.spdx_id ?? null,
    stars: r.stargazers_count,
    archived: r.archived,
    downstream_page: pageUrl(env, owner, repo),
    downstream_posts: Object.fromEntries(counts.results.map((c: any) => [c.kind, c.n])),
    readme: readme ? readme.slice(0, 20000) : null,
  });
}

async function ensureRepo(env: Env, user: AuthedUser, owner: string, repo: string): Promise<number> {
  // Verify existence upstream before creating a page for it.
  const gh = await github.repo(owner, repo, user.gh_token);
  const row = await env.DB.prepare(
    `INSERT INTO repos (owner, name, description) VALUES (?, ?, ?)
     ON CONFLICT(owner, name) DO UPDATE SET description = excluded.description
     RETURNING id`,
  )
    .bind(gh.owner.login, gh.name, gh.description ?? null)
    .first<{ id: number }>();
  return row!.id;
}

async function createPost(env: Env, user: AuthedUser, a: any, kinds: readonly string[]): Promise<ToolResult> {
  const { owner, repo } = pair(a);
  const kind = str(a, "kind");
  if (!kinds.includes(kind)) throw new ToolError(`kind must be one of: ${kinds.join(", ")}`);
  const title = str(a, "title").slice(0, 200);
  const body = str(a, "body").slice(0, 65536);
  const repoId = await ensureRepo(env, user, owner, repo);
  const row = await env.DB.prepare(
    `INSERT INTO posts (repo_id, number, author_id, kind, title, body)
     VALUES (?1, (SELECT COALESCE(MAX(number), 0) + 1 FROM posts WHERE repo_id = ?1), ?2, ?3, ?4, ?5)
     RETURNING number`,
  )
    .bind(repoId, user.id, kind, title, body)
    .first<{ number: number }>();
  const url = pageUrl(env, owner, repo, row!.number);
  return json({ published: true, kind, number: row!.number, url, attributed_to: user.login });
}

async function repoRow(env: Env, a: any) {
  const { owner, repo } = pair(a);
  const row = await env.DB.prepare("SELECT id, owner, name FROM repos WHERE owner = ? AND name = ?")
    .bind(owner, repo)
    .first<any>();
  if (!row) throw new ToolError(`no downstream page for ${owner}/${repo} yet — publish_note or tracker_create starts one`);
  return row;
}

async function listPosts(env: Env, a: any): Promise<ToolResult> {
  const r = await repoRow(env, a);
  const conds = ["p.repo_id = ?"];
  const binds: unknown[] = [r.id];
  if (a.kind) {
    conds.push("p.kind = ?");
    binds.push(a.kind);
  }
  if (a.status) {
    conds.push("p.status = ?");
    binds.push(a.status);
  }
  const rows = await env.DB.prepare(
    `SELECT p.number, p.kind, p.title, p.status, p.created_at, u.login AS author,
            (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comments
       FROM posts p JOIN users u ON u.id = p.author_id
      WHERE ${conds.join(" AND ")} ORDER BY p.number DESC LIMIT 100`,
  )
    .bind(...binds)
    .all<any>();
  return json({ repo: `${r.owner}/${r.name}`, page: pageUrl(env, r.owner, r.name), posts: rows.results });
}

async function getPost(env: Env, a: any): Promise<ToolResult> {
  const r = await repoRow(env, a);
  const number = Number(a.number);
  const post = await env.DB.prepare(
    `SELECT p.id, p.number, p.kind, p.title, p.status, p.body, p.created_at, p.updated_at, u.login AS author
       FROM posts p JOIN users u ON u.id = p.author_id WHERE p.repo_id = ? AND p.number = ?`,
  )
    .bind(r.id, number)
    .first<any>();
  if (!post) throw new ToolError(`no post #${number} on ${r.owner}/${r.name}`);
  const comments = await env.DB.prepare(
    `SELECT u.login AS author, c.body, c.created_at FROM comments c JOIN users u ON u.id = c.author_id
      WHERE c.post_id = ? ORDER BY c.id`,
  )
    .bind(post.id)
    .all<any>();
  const { id: _drop, ...pub } = post;
  return json({ ...pub, url: pageUrl(env, r.owner, r.name, post.number), comments: comments.results });
}

async function commentPost(env: Env, user: AuthedUser, a: any): Promise<ToolResult> {
  const r = await repoRow(env, a);
  const number = Number(a.number);
  const body = str(a, "body").slice(0, 65536);
  const post = await env.DB.prepare("SELECT id FROM posts WHERE repo_id = ? AND number = ?")
    .bind(r.id, number)
    .first<{ id: number }>();
  if (!post) throw new ToolError(`no post #${number} on ${r.owner}/${r.name}`);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO comments (post_id, author_id, body) VALUES (?, ?, ?)").bind(post.id, user.id, body),
    env.DB.prepare("UPDATE posts SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").bind(post.id),
  ]);
  return json({ commented: true, url: pageUrl(env, r.owner, r.name, number), attributed_to: user.login });
}

async function updateStatus(env: Env, user: AuthedUser, a: any): Promise<ToolResult> {
  const r = await repoRow(env, a);
  const number = Number(a.number);
  const status = str(a, "status");
  if (!STATUSES.includes(status as any)) throw new ToolError(`status must be one of: ${STATUSES.join(", ")}`);
  const isRepoOwner = user.login.toLowerCase() === String(r.owner).toLowerCase();
  const res = await env.DB.prepare(
    `UPDATE posts SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE repo_id = ? AND number = ? AND kind IN ('idea', 'bug') AND (author_id = ? OR ?)`,
  )
    .bind(status, r.id, number, user.id, isRepoOwner ? 1 : 0)
    .run();
  if (!res.meta.changes) {
    throw new ToolError(`cannot update #${number}: not a tracker item, or you are neither its author nor the repo owner`);
  }
  return json({ number, status, url: pageUrl(env, r.owner, r.name, number) });
}
