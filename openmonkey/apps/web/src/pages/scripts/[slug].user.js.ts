import type { APIRoute } from "astro";
import { rewriteUpstreamHosts } from "@openmonkey/shared";
import { apiOrigin, siteBase } from "../../lib/origins";

// Serves the latest code at openmonkey.<base>/scripts/<slug>.user.js.
// Userscript managers (Userscripts for Safari, Tampermonkey, Violentmonkey)
// trigger their install flow on URLs ending in .user.js, so this link is the
// whole install story. The api origin is derived from the serving hostname,
// and upstream hostnames in the script body are rewritten to this
// deployment's equivalents (a no-op on the upstream proc.io deployment).
export const GET: APIRoute = async ({ params, locals, url }) => {
  const apiUrl = `${apiOrigin(url.hostname)}/api/scripts/${params.slug}.user.js`;
  const binding = (locals as any)?.runtime?.env?.API;
  const res = binding ? await binding.fetch(new Request(apiUrl)) : await fetch(apiUrl);
  if (!res.ok) return new Response("not found", { status: 404 });
  const code = rewriteUpstreamHosts(await res.text(), siteBase(url.hostname));
  return new Response(code, {
    headers: { "Content-Type": "text/javascript; charset=utf-8" },
  });
};

export const HEAD: APIRoute = async (ctx) => {
  const res = await GET(ctx);
  return new Response(null, { status: res.status, headers: res.headers });
};
