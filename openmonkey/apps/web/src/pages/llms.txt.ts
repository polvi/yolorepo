import type { APIRoute } from "astro";
import { siteBase } from "../lib/origins";

// /llms.txt rendered at request time so every hostname reference points at
// the deployment actually serving it (fork or upstream).
function render(base: string): string {
  return `# openmonkey

Userscripts in the open. A public registry of browser userscripts where creation
is publication, every script can be forked with public lineage, and AI security
scan verdicts are published per version by the users' own models.

Scripts are served at standard \`.user.js\` URLs, so any userscript manager
(Userscripts for Safari, Tampermonkey, Violentmonkey) installs them directly.

Site: https://openmonkey.${base}
Registry API: https://api.openmonkey.${base}/api

## Registry API (JSON, no auth for reads)

- GET  /api/scripts?q=&limit=            list/search scripts
- GET  /api/scripts/:slug                script metadata + latest version (code, match_patterns)
- GET  /api/scripts/:slug/versions       version history
- GET  /api/scripts/:slug/versions/:n    specific version
- GET  /api/scripts/:slug.user.js        latest code as text/javascript (install URL; also served
                                         at https://openmonkey.${base}/scripts/:slug.user.js).
                                         Serve-time injection fills in @version, @homepageURL,
                                         @downloadURL, @updateURL when the author omitted them,
                                         so userscript managers auto-update from the canonical URL.
- GET  /api/versions/:id/scans           community scan verdicts for a version

## Authenticated writes (AuthGravity session cookie, https://authgravity.${base})

- POST /api/scripts                      {name?, description?, code} → publish new script (public immediately;
                                         humans can use the form at https://openmonkey.${base}/publish)
- POST /api/scripts/:slug/versions       {code, changelog?} → new immutable version (author only)
- POST /api/scripts/:slug/fork           {name?, code?} → fork with lineage
- POST /api/versions/:id/scans           {verdict: pass|warn|fail, summary?, model?} → publish your scan verdict
- GET  /api/me · POST /api/me/handle     profile

## Conventions

- Scripts use Greasemonkey metadata blocks; @match or @include is required.
- Versions are immutable; verdicts never carry over, scan each version on its own.
- The scan norm: before running a script you didn't write, audit the exact source
  with your own OpenAI-compatible endpoint (default https://api.tokenpony.dev/v1
  via a TPX grant) and publish the verdict. pass = no meaningful risk, warn = read
  the summary first, fail = don't run it. Installs happen in third-party userscript
  managers, so verdicts are advisory; the registry surfaces them on every script page.
- Auth: AuthGravity passkeys (https://authgravity.${base}/llms.txt). Sign-in UI
  is the shared ${base} surface: https://auth.${base}/login?return_to=<url>
  (https://auth.${base}/llms.txt).
- Inference: TPX metered grants (https://tokenpony.dev/llms.txt).
- Dogfood: the "openmonkey scanner (TPX)" userscript in this registry adds a
  scan-and-publish button to script pages; "openmonkey composer (TPX)" adds a
  generate box on /publish; "openmonkey anywhere (TPX)" opens a panel on any
  site to prompt a script for that page into existence (page context included
  in the generation), publish it, and install it. All are OAuth public clients
  of TPX: dynamic client
  registration (RFC 7591), PKCE S256, popup approval of a metered budget — no
  API keys. https://openmonkey.${base}/oauth/tpx is the shared redirect relay:
  it hands the code to the opener via localStorage + BroadcastChannel
  (same-origin) and window.opener.postMessage (cross-origin popups from any
  site), safe because the code is useless without the initiating script's PKCE
  verifier. Any userscript on this registry may register it as its redirect_uri.
`;
}

export const GET: APIRoute = ({ url }) =>
  new Response(render(siteBase(url.hostname)), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
