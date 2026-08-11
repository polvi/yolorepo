// Stateless MCP endpoint, spec 2026-07-28 (downstream's plumbing): no
// handshake, every request self-describing via _meta, Mcp-Method/Mcp-Name
// headers verified against the body (HeaderMismatch -32020). Legacy
// initialize-era clients (2025-*) are still served per the spec's
// backward-compatibility window. Auth is a plain bt_ bearer token — the
// caller is the project owner's own coding agent, so no OAuth dance.

import { callTool, ToolError, TOOLS } from './tools';

export const PROTOCOL_VERSION = '2026-07-28';
const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];
const SERVER_INFO = { name: 'backtalk', version: '0.1.0' };
const META_PREFIX = 'io.modelcontextprotocol/';

type RpcRequest = { jsonrpc: '2.0'; id?: string | number; method?: string; params?: any };

const rpcError = (id: any, code: number, message: string, status: number, data?: unknown) =>
  Response.json(
    { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data !== undefined ? { data } : {}) } },
    { status }
  );

const rpcResult = (id: any, result: Record<string, unknown>) =>
  Response.json({
    jsonrpc: '2.0',
    id,
    result: { ...result, _meta: { [`${META_PREFIX}serverInfo`]: SERVER_INFO } },
  });

export async function handleMcp(db: D1Database, req: Request, userId: string): Promise<Response> {
  let body: RpcRequest;
  try {
    body = await req.json();
  } catch {
    return rpcError(null, -32700, 'parse error: body must be a JSON-RPC 2.0 message', 400);
  }
  if (Array.isArray(body)) return rpcError(null, -32600, 'batching is not supported', 400);
  if (body?.jsonrpc !== '2.0' || typeof body.method !== 'string') {
    return rpcError(body?.id, -32600, 'invalid JSON-RPC 2.0 request', 400);
  }

  // Header mirror verification (Streamable HTTP): body is source of truth.
  const hMethod = req.headers.get('Mcp-Method');
  if (hMethod && hMethod !== body.method) {
    return rpcError(body.id, -32020, `Mcp-Method header (${hMethod}) does not match body method (${body.method})`, 400);
  }
  const hName = req.headers.get('Mcp-Name');
  if (hName && body.method === 'tools/call' && hName !== body.params?.name) {
    return rpcError(body.id, -32020, `Mcp-Name header (${hName}) does not match tool name (${body.params?.name})`, 400);
  }

  // Notifications get 202 + no body.
  if (body.id === undefined || body.id === null) {
    return new Response(null, { status: 202 });
  }

  const meta = body.params?._meta ?? {};
  const version = meta[`${META_PREFIX}protocolVersion`];

  // Legacy era: initialize-based clients omit per-request _meta fields.
  if (body.method === 'initialize') {
    const requested = body.params?.protocolVersion;
    const negotiated = LEGACY_VERSIONS.includes(requested) ? requested : LEGACY_VERSIONS[0];
    return rpcResult(body.id, {
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
  }

  if (version !== undefined) {
    if (version !== PROTOCOL_VERSION && !LEGACY_VERSIONS.includes(version)) {
      return rpcError(body.id, -32022, `unsupported protocol version: ${version}`, 400, {
        supported: [PROTOCOL_VERSION, ...LEGACY_VERSIONS],
      });
    }
    if (version === PROTOCOL_VERSION && meta[`${META_PREFIX}clientCapabilities`] === undefined) {
      return rpcError(body.id, -32602, `${META_PREFIX}clientCapabilities is required in _meta`, 400);
    }
  }

  switch (body.method) {
    case 'ping':
      return rpcResult(body.id, { resultType: 'complete' });

    case 'tools/list':
      return rpcResult(body.id, {
        resultType: 'complete',
        tools: TOOLS,
        ttlMs: 3600_000,
        cacheScope: 'public',
      });

    case 'tools/call': {
      const name = body.params?.name;
      if (typeof name !== 'string') return rpcError(body.id, -32602, 'params.name is required', 400);
      try {
        const r = await callTool(db, userId, name, body.params?.arguments);
        return rpcResult(body.id, {
          resultType: 'complete',
          content: [{ type: 'text', text: r.text }],
          ...(r.structured !== undefined ? { structuredContent: r.structured } : {}),
        });
      } catch (e) {
        if (e instanceof ToolError) {
          // Tool-level failure: isError result, not a protocol error.
          return rpcResult(body.id, {
            resultType: 'complete',
            isError: true,
            content: [{ type: 'text', text: e.message }],
          });
        }
        console.error('tool crash', name, e);
        return rpcError(body.id, -32603, `internal error running ${name}`, 500);
      }
    }

    default:
      return rpcError(body.id, -32601, `method not found: ${body.method}`, 404);
  }
}
