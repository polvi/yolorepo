const root = import.meta.dir;

Bun.serve({
  port: 8321,
  fetch(req) {
    const path = new URL(req.url).pathname;
    const file = Bun.file(root + (path === '/' ? '/index.html' : path));
    return new Response(file);
  },
});

console.log('webmtp dev server on http://localhost:8321');
