// Dev server: static files plus on-the-fly bundling of the demo TS entrypoint.

const root = import.meta.dir;

Bun.serve({
  port: 8321,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === '/demo/app.js') {
      const result = await Bun.build({ entrypoints: [root + '/demo/app.ts'], target: 'browser' });
      if (!result.success) {
        return new Response(result.logs.map(String).join('\n'), { status: 500 });
      }
      const bundle = result.outputs[0];
      if (!bundle) return new Response('no build output', { status: 500 });
      return new Response(await bundle.text(), {
        headers: { 'content-type': 'text/javascript' },
      });
    }
    const file = Bun.file(root + (path === '/' ? '/index.html' : path));
    return new Response(file);
  },
});

console.log('webmtp dev server on http://localhost:8321');
