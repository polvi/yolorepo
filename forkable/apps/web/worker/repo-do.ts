import { DurableObject } from 'cloudflare:workers';

// Phase 0 stub. Implements only the /internal/* contract over plain DO
// key-value storage so serving, the dashboard, and fork-on-create work before
// the real git RepoDO (worker/git/repo-do.ts) lands behind the same seam.
// Swapped out in Phase 1 via the export in worker/index.ts.

const FILE_PREFIX = 'file:';

interface StubEnv {
  REPO: DurableObjectNamespace;
}

async function sha1hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', data as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class RepoDO extends DurableObject<StubEnv> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    switch (`${request.method} ${url.pathname}`) {
      case 'POST /internal/init':
        return this.init(await request.json());
      case 'GET /internal/file':
        return this.file(url, request);
      case 'GET /internal/refs':
        return this.refs();
      case 'GET /internal/export':
        return this.export();
      case 'POST /internal/import':
        return this.import(await request.json());
      case 'POST /internal/destroy':
        await this.ctx.storage.deleteAll();
        return Response.json({ ok: true });
      default:
        return Response.json({ error: 'not found' }, { status: 404 });
    }
  }

  private async init(body: { files: Record<string, string> }): Promise<Response> {
    for (const [path, content] of Object.entries(body.files)) {
      await this.ctx.storage.put(FILE_PREFIX + path, content);
    }
    await this.ctx.storage.put('initialized', Date.now());
    return Response.json({ ok: true });
  }

  private async listFiles(): Promise<Record<string, string>> {
    const entries = await this.ctx.storage.list<string>({ prefix: FILE_PREFIX });
    const files: Record<string, string> = {};
    for (const [key, value] of entries) files[key.slice(FILE_PREFIX.length)] = value;
    return files;
  }

  private async file(url: URL, request: Request): Promise<Response> {
    let path = (url.searchParams.get('path') ?? '').replace(/^\/+/, '');
    if (path === '' || path.endsWith('/')) path += 'index.html';

    let content = await this.ctx.storage.get<string>(FILE_PREFIX + path);
    if (content === undefined && !path.includes('.')) {
      path += '/index.html';
      content = await this.ctx.storage.get<string>(FILE_PREFIX + path);
    }
    if (content === undefined) return Response.json({ error: 'not found' }, { status: 404 });

    const bytes = new TextEncoder().encode(content);
    const oid = await sha1hex(bytes);
    const etag = `"${oid}"`;
    if (request.headers.get('if-none-match') === etag) {
      return new Response(null, { status: 304, headers: { ETag: etag } });
    }
    return new Response(bytes, {
      headers: { ETag: etag, 'X-Blob-Oid': oid, 'X-Resolved-Path': path },
    });
  }

  private async refs(): Promise<Response> {
    const initialized = await this.ctx.storage.get('initialized');
    const refs: Record<string, string> = {};
    if (initialized) refs['refs/heads/main'] = 'stub';
    return Response.json({ refs, head: 'refs/heads/main' });
  }

  private async export(): Promise<Response> {
    return Response.json({ files: await this.listFiles() });
  }

  private async import(body: { files: Record<string, string> }): Promise<Response> {
    return this.init(body);
  }
}
