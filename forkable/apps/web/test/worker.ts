// Self-contained test worker: exports the real RepoDO and a minimal router
// that forwards /repo/<name>/<rest> to the DO. It simulates the front worker's
// auth responsibility: incoming X-Fk-* headers are stripped, then re-set from
// the test-provided X-Test-User / X-Test-Owner headers.

export { RepoDO } from '../worker/git/repo-do';

interface Env {
  REPO: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/repo\/([^/]+)(\/.*)?$/);
    if (!m) return new Response('not found', { status: 404 });
    const [, name, rest = '/'] = m;

    const headers = new Headers(request.headers);
    headers.delete('X-Fk-User');
    headers.delete('X-Fk-Owner');
    const testUser = headers.get('X-Test-User');
    const testOwner = headers.get('X-Test-Owner');
    if (testUser) headers.set('X-Fk-User', testUser);
    if (testOwner) headers.set('X-Fk-Owner', testOwner);

    const stub = env.REPO.get(env.REPO.idFromName(name));
    const body =
      request.method === 'GET' || request.method === 'HEAD'
        ? undefined
        : await request.arrayBuffer();
    return stub.fetch(`https://repo${rest}${url.search}`, {
      method: request.method,
      headers,
      body,
    });
  },
};
