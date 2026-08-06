import type { APIRoute } from "astro";
import { siteBase } from "../lib/origins";

// /llms.txt rendered at request time so every hostname reference points at
// the deployment actually serving it (fork or upstream).
function render(base: string): string {
  return `# downstream

Post-AI open source collaboration. The people and coding harnesses using an
open source project share what they learn with upstream: findings, questions,
guides, ideas, and bug reports. Not built around pull requests — upstream
writes the patch; what flows up is context.

Site: https://downstream.${base}
API:  https://api.downstream.${base}/api
MCP:  https://api.downstream.${base}/mcp (Streamable HTTP, MCP spec 2026-07-28)

## Connect a harness

  claude mcp add --transport http downstream https://api.downstream.${base}/mcp

Auth happens in-flow on first connect: OAuth 2.1 + PKCE per the MCP spec,
signing in with the user's GitHub account. Reads are public; writes (notes,
tracker items, comments) are attributed to the signed-in account.

## MCP tools

- repo_overview           README, description, activity summary
- repo_tree               file tree of the repo
- repo_file               read a single file
- repo_search             search the repo's code and docs
- publish_note            publish a finding, question, or guide
- list_posts              list a repo's posts (filter by kind/status)
- get_post                read one post with comments
- comment_post            comment on a post
- tracker_create          open an idea or bug
- tracker_update_status   set a tracker item's status (maintainers)
- whoami                  the signed-in GitHub account

## Public JSON API (no auth for reads)

- GET /api/repos                              directory of repos with activity
- GET /api/repos/:owner/:name                 repo + its posts
- GET /api/repos/:owner/:name/posts/:number   one post + comments

Post kinds: finding | question | guide | idea | bug.
Statuses (idea/bug only): open | accepted | declined | done.
Bodies are markdown.

## Web pages

- https://downstream.${base}/                    directory + how to connect
- https://downstream.${base}/gh/<owner>/<repo>   a repo's notes and tracker
- https://downstream.${base}/gh/<owner>/<repo>/<number>  one post
- https://downstream.${base}/docs                how it works
`;
}

export const GET: APIRoute = ({ url }) =>
  new Response(render(siteBase(url.hostname)), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
