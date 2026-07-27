// Thin TypeScript shell: routing + JSON passthrough to the tlc-engine
// worker, reached over the ENGINE service binding so heavy checks run in
// their own isolate (with their own CPU budget) and never stall website
// requests served here. Checking requires an API key (AuthGravity identity
// + D1-stored keys — see auth.ts); the hub and account pages stay public.
import { handleMcp } from "./mcp";
import { landingHtml } from "./landing";
import { authenticateBearer } from "./auth";
import { handleAccount } from "./account";
import { hubIndex, hubPath, hubRaw, hubSpec, hubWins, publishSpec, reportWin } from "./hub";
import { tpxCallback, tpxClient, tpxJs } from "./tpx";
import { llmsTxt } from "./llms";

// RPC surface of the tlc-engine worker (engine/src/index.ts). The generated
// Env types the binding as a plain Fetcher, so name the methods here.
interface EngineBinding {
  parse(json: string): Promise<string>;
  check(json: string): Promise<string>;
}

/** Structured error for a request the engine itself could not survive. */
function engineFailure(): { status: string; errors: object[] } {
  return {
    status: "resource_limit",
    errors: [{
      code: "R0005",
      category: "request",
      message:
        "the check exhausted the engine's memory; reduce CONSTANT sizes, add a CONSTRAINT, or strengthen action guards",
    }],
  };
}

const keyHint = (origin: string) =>
  `mint an API key at ${origin}/account and send it as \`Authorization: Bearer <key>\``;

const HUB_SPEC_RE = /^\/hub\/([^/]+)\/([^/]+)$/;
const HUB_RAW_RE = /^\/hub\/([^/]+)\/([^/]+)\/(\d+)\.(tla|cfg)$/;

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    const engine = env.ENGINE as unknown as EngineBinding;

    if (request.method === "GET") {
      if (url.pathname === "/" || url.pathname === "/index.html") {
        return new Response(landingHtml(url), {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      if (url.pathname === "/account") return handleAccount(request, env);
      if (url.pathname === "/llms.txt") return llmsTxt(url.host);
      if (url.pathname === "/tpx/client") return tpxClient(request, env.DB);
      if (url.pathname === "/tpx/callback") return tpxCallback(url.host);
      if (url.pathname === "/tpx.js") return tpxJs();
      if (url.pathname === "/hub") return hubIndex(env.DB, url.host);
      if (url.pathname === "/hub/wins") return hubWins(env.DB, url.host);
      const specMatch = url.pathname.match(HUB_SPEC_RE);
      if (specMatch) {
        return hubSpec(
          env.DB,
          url.host,
          decodeURIComponent(specMatch[1]),
          decodeURIComponent(specMatch[2]),
        );
      }
      const rawMatch = url.pathname.match(HUB_RAW_RE);
      if (rawMatch) {
        return hubRaw(
          env.DB,
          decodeURIComponent(rawMatch[1]),
          decodeURIComponent(rawMatch[2]),
          Number(rawMatch[3]),
          rawMatch[4] as "tla" | "cfg",
        );
      }
    }

    if (request.method === "POST" && url.pathname.startsWith("/account")) {
      return handleAccount(request, env);
    }

    if (request.method !== "POST") {
      return Response.json(
        { status: "bad_request", errors: [{ code: "R0002", category: "request", message: "POST /parse, /check, or /mcp (see GET / for docs)" }] },
        { status: 405 },
      );
    }

    // Everything below runs the engine, which requires an API key.
    const user = await authenticateBearer(request, env.DB, (p) => ctx.waitUntil(p));

    const body = await request.text();

    // MCP endpoint (stateless Streamable HTTP): JSON-RPC over POST.
    if (url.pathname === "/mcp") {
      if (user === null || user === "invalid") {
        return Response.json(
          {
            jsonrpc: "2.0",
            id: null,
            error: {
              code: -32001,
              message: user === "invalid"
                ? `invalid bearer token (${keyHint(url.origin)})`
                : `authentication required (${keyHint(url.origin)})`,
            },
          },
          { status: 401 },
        );
      }
      return handleMcp(body, engine, {
        host: url.host,
        user,
        publish: (name, tla, cfg, stats, meta) => {
          ctx.waitUntil(publishSpec(env.DB, user.id, name, tla, cfg, stats, meta));
          return `${url.origin}${hubPath(user.id, name)}`;
        },
        reportWin: async (report) => {
          const result = await reportWin(env.DB, user.id, report);
          return result.ok
            ? { ...result, url: `${url.origin}${hubPath(user.id, report.spec)}#wins` }
            : result;
        },
      });
    }

    let result: string;
    switch (url.pathname) {
      case "/parse":
      case "/check":
        if (user === null || user === "invalid") {
          return Response.json(
            {
              status: "unauthorized",
              errors: [{
                code: "R0006",
                category: "request",
                message: user === "invalid"
                  ? `invalid API key; ${keyHint(url.origin)}`
                  : `authentication required; ${keyHint(url.origin)}`,
              }],
            },
            { status: 401 },
          );
        }
        try {
          result = await (url.pathname === "/parse" ? engine.parse(body) : engine.check(body));
        } catch {
          return Response.json(engineFailure(), { status: 200 });
        }
        break;
      default:
        return Response.json(
          { status: "bad_request", errors: [{ code: "R0003", category: "request", message: `unknown path ${url.pathname}` }] },
          { status: 404 },
        );
    }
    return new Response(result, { headers: { "Content-Type": "application/json" } });
  },
} satisfies ExportedHandler<Env>;
