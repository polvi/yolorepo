// /llms.txt rendered server-side so every domain reference matches the base
// domain the surface is actually being served on (proc.io upstream, the
// fork's domain on a fork).

import type { APIRoute } from "astro";
import { authgravityOrigin, stackBase } from "../lib/stack";

export const GET: APIRoute = ({ url }) => {
  const base = stackBase(url.hostname);
  const authg = authgravityOrigin(url.hostname);

  const body = `# auth.${base}

The shared, first-party auth surface for ${base} projects. Own UI over
AuthGravity's raw API (${authg}/llms.txt) — the hosted
AuthGravity pages are not used. Sessions are a \`session_id\` cookie on the
\`${base}\` registrable domain, so one sign-in is valid on every *.${base} app.

## Pages

- /login?return_to=<url>     passkey sign-in, 12-word account key fallback,
                             silent device-key auto sign-in
- /register?return_to=<url>  passkey or account-key registration (guided
                             12-word flow with paper-backup confirmation)
- /account                   credentials list, add recovery key, remove
                             credentials, sign out

return_to must be a local path or an https URL on ${base} / *.${base};
anything else falls back to /account.

## Theming (light skinning per project)

The surface adopts a project's colors two ways; structure never changes,
so the page is always recognizably auth.${base}:

1. Registry (preferred): apps on *.${base} register a palette in
   procauth/apps/web/src/lib/theme.ts keyed by their subdomain label.
   Linking with return_to is then enough — the palette is resolved from
   its hostname and rendered server-side (no flash).
2. Query overrides: ?app=<name>&accent=<hex>&bg=<hex>&panel=<hex>
   &border=<hex>&text=<hex>&muted=<hex>&fail=<hex>. Hex colors only
   (with or without #), app name shown as a chip, max 32 chars.
   Overrides win over the registry.

Theme params and return_to are carried across the login/register links.

## Integrating a ${base} app

- Link "Sign in" to https://auth.${base}/login?return_to=<back-to-your-app>
- Server-side session check: forward the incoming Cookie header to
  GET ${authg}/v1/whoami → {user_id} or 401.
- Client-side signed-in state: fetch the same endpoint with
  credentials: "include".
- Sign out: POST ${authg}/v1/logout with credentials,
  or send users to /account here.

Accounts are an AuthGravity UUID plus public keys only — no usernames, emails,
or passwords exist. Key your users table by the UUID.

## Source

Monorepo: idea-playground/procauth (Astro on Cloudflare Workers).
`;

  return new Response(body, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
};
