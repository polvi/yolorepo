import { NS_PREFIX } from '@forkable/shared';

export function llmsTxt(apexOrigin: string, baseDomain: string): string {
  return `# forkable

Git-native, self-editing websites. Every site is a git repository of plain
static files (HTML/CSS/JS). The repository's main branch is served as the live
site at https://<site>.forkable.${baseDomain}/. Any visitor can edit a site by
talking to an LLM in an overlay panel; their changes become a per-user fork
(a git ref), previewed locally and saved to their account.

## How it works
- Each site is one git repo. main is the live site; refs/forks/<user> are drafts.
- Anonymous read access: clone any site with git over smart HTTP:
  git clone https://<site>.forkable.${baseDomain}${NS_PREFIX}/git
- Pushes require a signed-in session. Site owners push main; anyone pushes
  their own fork ref.
- Serving is directly from the repo: HEAD's tree is the site. No build step.

## Endpoints (per site origin, under the reserved ${NS_PREFIX}/ namespace)
- ${NS_PREFIX}/git/info/refs, git-upload-pack, git-receive-pack — smart HTTP
- ${NS_PREFIX}/api/me — session check
- ${NS_PREFIX}/api/site — site metadata (name, ownership, whether you have a fork)

## Apex (${apexOrigin})
- POST /api/sites {"name": "..."} — create a site (forks the seed site)
- GET /api/sites — list your sites
- DELETE /api/sites/:name — delete a site

Auth: passkeys via AuthGravity (https://authgravity.${baseDomain}), session
cookie shared across the ${baseDomain} stack. Inference: the editor calls TPX
(https://tokenpony.dev) directly from the browser; this backend holds no LLM
credentials.
`;
}
