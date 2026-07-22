import type { APIRoute } from "astro";

// Serves the latest code at openmonkey.proc.io/scripts/<slug>.user.js.
// Userscript managers (Userscripts for Safari, Tampermonkey, Violentmonkey)
// trigger their install flow on URLs ending in .user.js, so this link is the
// whole install story.
export const GET: APIRoute = async ({ params, locals }) => {
  const url = `https://api.openmonkey.proc.io/api/scripts/${params.slug}.user.js`;
  const binding = (locals as any)?.runtime?.env?.API;
  const res = binding ? await binding.fetch(new Request(url)) : await fetch(url);
  if (!res.ok) return new Response("not found", { status: 404 });
  return new Response(await res.text(), {
    headers: { "Content-Type": "text/javascript; charset=utf-8" },
  });
};

export const HEAD: APIRoute = async (ctx) => {
  const res = await GET(ctx);
  return new Response(null, { status: res.status, headers: res.headers });
};
