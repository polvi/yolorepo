// Server-side helper: call the registry API via service binding when deployed,
// falling back to the public URL in local dev. The api origin is derived from
// the incoming request's hostname so a fork talks to its own api worker (and
// the api, which derives the base domain from the URL it is fetched with,
// injects the right hosts into served scripts).

import { apiOrigin } from "./origins";

export async function apiFetch(astro: { locals: any; url: URL }, path: string): Promise<any> {
  const url = `${apiOrigin(astro.url.hostname)}/api${path}`;
  const binding = astro.locals?.runtime?.env?.API;
  const res = binding ? await binding.fetch(new Request(url)) : await fetch(url);
  if (!res.ok) return null;
  return res.json();
}
