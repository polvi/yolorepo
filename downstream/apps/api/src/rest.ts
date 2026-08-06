// Public read-only JSON API consumed by the Astro site (service binding
// in production, public fetch in dev). Everything here is public data.

import { Hono } from "hono";
import type { Env } from "./env";

export const restRoutes = new Hono<{ Bindings: Env }>();

const author = (r: any) => ({ login: r.author_login, avatar_url: r.author_avatar });

restRoutes.get("/api/repos", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT r.owner, r.name, r.description,
            COUNT(p.id) AS post_count, MAX(p.updated_at) AS last_activity
       FROM repos r LEFT JOIN posts p ON p.repo_id = r.id
      GROUP BY r.id ORDER BY last_activity DESC NULLS LAST LIMIT 200`,
  ).all<any>();
  return c.json({ repos: rows.results });
});

restRoutes.get("/api/repos/:owner/:name", async (c) => {
  const { owner, name } = c.req.param();
  const repo = await c.env.DB.prepare("SELECT id, owner, name, description FROM repos WHERE owner = ? AND name = ?")
    .bind(owner, name)
    .first<any>();
  if (!repo) return c.json({ error: "unknown repo" }, 404);
  const posts = await c.env.DB.prepare(
    `SELECT p.number, p.kind, p.title, p.status, p.created_at, p.updated_at,
            u.login AS author_login, u.avatar_url AS author_avatar,
            (SELECT COUNT(*) FROM comments c2 WHERE c2.post_id = p.id) AS comment_count
       FROM posts p JOIN users u ON u.id = p.author_id
      WHERE p.repo_id = ? ORDER BY p.updated_at DESC LIMIT 500`,
  )
    .bind(repo.id)
    .all<any>();
  return c.json({
    repo: { owner: repo.owner, name: repo.name, description: repo.description },
    posts: posts.results.map((p: any) => ({
      number: p.number,
      kind: p.kind,
      title: p.title,
      status: p.status,
      author: author(p),
      comment_count: p.comment_count,
      created_at: p.created_at,
      updated_at: p.updated_at,
    })),
  });
});

restRoutes.get("/api/repos/:owner/:name/posts/:number", async (c) => {
  const { owner, name, number } = c.req.param();
  const repo = await c.env.DB.prepare("SELECT id, owner, name, description FROM repos WHERE owner = ? AND name = ?")
    .bind(owner, name)
    .first<any>();
  if (!repo) return c.json({ error: "unknown repo" }, 404);
  const post = await c.env.DB.prepare(
    `SELECT p.id, p.number, p.kind, p.title, p.status, p.body, p.created_at, p.updated_at,
            u.login AS author_login, u.avatar_url AS author_avatar
       FROM posts p JOIN users u ON u.id = p.author_id WHERE p.repo_id = ? AND p.number = ?`,
  )
    .bind(repo.id, Number(number))
    .first<any>();
  if (!post) return c.json({ error: "unknown post" }, 404);
  const comments = await c.env.DB.prepare(
    `SELECT c2.body, c2.created_at, u.login AS author_login, u.avatar_url AS author_avatar
       FROM comments c2 JOIN users u ON u.id = c2.author_id WHERE c2.post_id = ? ORDER BY c2.id`,
  )
    .bind(post.id)
    .all<any>();
  return c.json({
    repo: { owner: repo.owner, name: repo.name, description: repo.description },
    post: {
      number: post.number,
      kind: post.kind,
      title: post.title,
      status: post.status,
      body: post.body,
      author: author(post),
      created_at: post.created_at,
      updated_at: post.updated_at,
    },
    comments: comments.results.map((cm: any) => ({ author: author(cm), body: cm.body, created_at: cm.created_at })),
  });
});
