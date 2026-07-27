// Stateless MCP server (Streamable HTTP transport) exposing the TLA+ checker
// as tools. Tools are pure functions over the wasm engine, so no sessions,
// no SSE streams, no Durable Objects — each POST is an independent JSON-RPC
// exchange, which the MCP spec permits for stateless servers.

import type { AuthedUser } from "./auth";
import type { CheckStats, SpecMeta, WinReport, WinResult } from "./hub";

type Json = Record<string, unknown>;

/** Auth context + publish hooks, wired up by index.ts. */
export interface McpContext {
  /** Hostname the request arrived on; names the hub in tool metadata. */
  host: string;
  /** Bearer-authenticated user; index.ts rejects unauthenticated calls. */
  user: AuthedUser;
  /** Fire-and-forget hub publish; returns the public URL of the spec. */
  publish: (name: string, tla: string, cfg: string, stats: CheckStats, meta: SpecMeta) => string;
  /** Awaited win report against a published spec; returns the wins URL. */
  reportWin: (report: WinReport) => Promise<WinResult & { url?: string }>;
}

interface RpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Json;
}

const PROTOCOL_VERSION = "2025-06-18";

const tools = (host: string) => [
  {
    name: "tlc_check",
    description:
      "Model-check a TLA+ specification (safety subset: invariants, [][A]_v action properties, deadlock). " +
      "Runs a finite-state breadth-first search and returns state counts, and on violation the shortest " +
      "counterexample trace. The run self-limits (default 30s worth of exploration); on timeout the result " +
      "includes a state-growth diagnostic explaining the blowup. Keep specs finite: small CONSTANT sets, " +
      "bounded number ranges.",
    inputSchema: {
      type: "object",
      properties: {
        spec: {
          type: "string",
          description: "Full TLA+ module source (---- MODULE Name ---- ... ====)",
        },
        config: {
          type: "string",
          description:
            "TLC configuration text: SPECIFICATION/INIT/NEXT, INVARIANT(S), PROPERTY(IES) for [][A]_v " +
            "properties, CONSTANT assignments (model values allowed), CONSTRAINT, CHECK_DEADLOCK TRUE|FALSE",
        },
        extra_modules: {
          type: "array",
          description: "Additional modules the spec EXTENDS (standard modules are built in)",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              source: { type: "string" },
            },
            required: ["name", "source"],
          },
        },
        timeout_seconds: {
          type: "integer",
          description: "Exploration budget in seconds, 1-30 (default 30)",
        },
        publish: {
          type: "boolean",
          description:
            `A passing check publishes the spec+config to ${host}/hub as the next generation of ` +
            "this module. Defaults to the account's publish setting; pass false to skip publishing " +
            "this call.",
        },
        description: {
          type: "string",
          description:
            "Hub metadata (shown publicly, max 500 chars): 1-2 sentences on what this spec models and " +
            "which properties it checks, e.g. 'Leases with bounded clock skew; checks at-most-one-holder.' " +
            "The hub is public, so describe the abstract algorithm/protocol only — no company, product, or " +
            "project names, no internal identifiers, URLs, or business specifics. The same goes for the " +
            "spec itself: use generic module/constant names when the design comes from private work. " +
            "Include this whenever publishing; the latest one supplied becomes the spec's description.",
        },
        changelog: {
          type: "string",
          description:
            "Hub metadata (shown publicly, max 500 chars): one line on what changed in the model since " +
            "the previous generation and why, e.g. 'Model retry after lease expiry; strengthened TypeOK.' " +
            "Same privacy rule as description: describe the design change in the abstract, never " +
            "confidential context. Ignored when the content is identical to the latest generation.",
        },
      },
      required: ["spec", "config"],
    },
  },
  {
    name: "tlc_parse",
    description:
      "Parse and semantically check a TLA+ module (syntax, name resolution, arity, level checking) " +
      "without model checking. Fast; use to validate a spec edit before running tlc_check.",
    inputSchema: {
      type: "object",
      properties: {
        spec: { type: "string", description: "Full TLA+ module source" },
        extra_modules: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              source: { type: "string" },
            },
            required: ["name", "source"],
          },
        },
      },
      required: ["spec"],
    },
  },
  {
    name: "tlc_report_win",
    description:
      "Report a win: model checking caught a real design or architecture bug. Use this after a " +
      "tlc_check invariant/property violation exposed a genuine flaw in the system being modeled " +
      "(not a typo in the spec itself), the design was corrected, and the fixed spec passed and " +
      "published. The win appears on the spec's hub page and in the public hub-wide wins list " +
      `(${host}/hub/wins). Requires a spec you've already published.`,
    inputSchema: {
      type: "object",
      properties: {
        spec: {
          type: "string",
          description: "Module name of your published spec the win belongs to (as used with tlc_check)",
        },
        title: {
          type: "string",
          description:
            "Public headline for the win (max 120 chars), e.g. 'Caught a lost-update race in the " +
            "lease handoff'. Same privacy rule as spec descriptions: abstract design language only, " +
            "no company, product, or project names.",
        },
        story: {
          type: "string",
          description:
            "Public write-up (max 2000 chars): what the design bug was, the counterexample scenario " +
            "the checker produced, and how the design changed to fix it. Describe the abstract " +
            "algorithm/protocol only — no confidential names, identifiers, or business context.",
        },
        invariant: {
          type: "string",
          description: "Name of the invariant or property whose violation exposed the bug (max 120 chars)",
        },
        gen: {
          type: "integer",
          description:
            "Generation embodying the corrected design (defaults to the spec's latest generation)",
        },
      },
      required: ["spec", "title", "story"],
    },
  },
];

/** Module name from the `---- MODULE Name ----` header. */
function moduleName(source: string): string | null {
  const m = source.match(/^-{4,}\s*MODULE\s+(\w+)/m);
  return m ? m[1] : null;
}

function rpcResult(id: number | string | null | undefined, result: Json): Response {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, result });
}

function rpcError(id: number | string | null | undefined, code: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

function toolText(status: string, resp: Json): string {
  const human = typeof resp.humanOutput === "string" ? resp.humanOutput : "";
  const summary = human || `status: ${status}`;
  // Full JSON after the summary so the model can read structured details
  // (trace states, diagnostics) without a second call.
  return `${summary}\n\n${JSON.stringify(resp, null, 2)}`;
}

export async function handleMcp(
  body: string,
  engine: { parse: (json: string) => Promise<string>; check: (json: string) => Promise<string> },
  ctx: McpContext,
): Promise<Response> {
  let req: RpcRequest;
  try {
    req = JSON.parse(body);
  } catch {
    return rpcError(null, -32700, "parse error: request body is not JSON");
  }
  // Batch requests are removed in protocol 2025-06-18; reject them plainly.
  if (Array.isArray(req)) {
    return rpcError(null, -32600, "batch requests are not supported");
  }

  switch (req.method) {
    case "initialize":
      return rpcResult(req.id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: {
          name: "tlc",
          title: "TLA+ Model Checker",
          version: "0.1.0",
        },
        instructions:
          "TLA+ finite model checking (safety subset). Use tlc_parse to validate a spec, tlc_check to " +
          "model-check it. On invariant_violation read the trace in the result; on timeout read the " +
          "diagnostic hint and shrink CONSTANT bounds. Specs must be finite. " +
          `Passing checks are published to ${ctx.host}/hub ` +
          (ctx.user.publish
            ? "(your account setting: on; pass publish:false on a call to skip it). "
            : "only if the call sets publish:true (your account setting: off). ") +
          "When publishing, include the description and changelog arguments so the hub can explain " +
          "the spec and its evolution — the hub is public, so keep them (and the spec) free of " +
          "confidential names and business context; share the abstract design. " +
          "When a check's violation exposes a real bug in the system's design (not a spec typo) and " +
          "the corrected design passes, report it with tlc_report_win — it showcases the save on the " +
          `spec's hub page and at ${ctx.host}/hub/wins.`,
      });

    case "notifications/initialized":
    case "notifications/cancelled":
      // Notifications get 202 with no body per Streamable HTTP.
      return new Response(null, { status: 202 });

    case "ping":
      return rpcResult(req.id, {});

    case "tools/list":
      return rpcResult(req.id, { tools: tools(ctx.host) });

    case "tools/call": {
      const params = (req.params ?? {}) as { name?: string; arguments?: Json };
      const args = (params.arguments ?? {}) as {
        spec?: string;
        config?: string;
        extra_modules?: { name: string; source: string }[];
        timeout_seconds?: number;
        publish?: boolean;
        description?: string;
        changelog?: string;
        title?: string;
        story?: string;
        invariant?: string;
        gen?: number;
      };
      if (typeof args.spec !== "string" || args.spec.length === 0) {
        return rpcError(req.id, -32602, "missing required argument: spec");
      }
      // tlc_report_win takes a spec *name*, not module source; handle it
      // before the module-header parsing the engine tools share.
      if (params.name === "tlc_report_win") {
        if (typeof args.title !== "string" || typeof args.story !== "string") {
          return rpcError(req.id, -32602, "missing required argument: title and story");
        }
        const win = await ctx.reportWin({
          spec: args.spec,
          title: args.title,
          story: args.story,
          invariant: typeof args.invariant === "string" ? args.invariant : undefined,
          gen: typeof args.gen === "number" ? args.gen : undefined,
        });
        if (!win.ok) {
          return rpcResult(req.id, {
            content: [{ type: "text", text: win.error }],
            isError: true,
          });
        }
        return rpcResult(req.id, {
          content: [{
            type: "text",
            text: `win recorded against ${args.spec} gen ${win.gen}: ${win.url}`,
          }],
          structuredContent: { spec: args.spec, gen: win.gen, url: win.url },
          isError: false,
        });
      }
      const name = moduleName(args.spec);
      if (!name) {
        return rpcResult(req.id, {
          content: [{ type: "text", text: "spec has no `---- MODULE Name ----` header" }],
          isError: true,
        });
      }
      const modules = [
        { name, source: args.spec },
        ...(args.extra_modules ?? []),
      ];

      let raw: string;
      try {
        if (params.name === "tlc_parse") {
          raw = await engine.parse(JSON.stringify({ modules, mainModule: name }));
        } else if (params.name === "tlc_check") {
          if (typeof args.config !== "string" || args.config.length === 0) {
            return rpcError(req.id, -32602, "missing required argument: config");
          }
          raw = await engine.check(
            JSON.stringify({
              modules,
              mainModule: name,
              config: args.config,
              timeoutSeconds: args.timeout_seconds ?? 30,
            }),
          );
        } else {
          return rpcError(req.id, -32602, `unknown tool: ${params.name}`);
        }
      } catch {
        // The engine ran out of memory even on a fresh instance (tlc-engine
        // resets and retries once before letting the throw reach here).
        return rpcResult(req.id, {
          content: [{
            type: "text",
            text:
              "the check exhausted the engine's memory; reduce CONSTANT sizes, add a CONSTRAINT, " +
              "or strengthen action guards",
          }],
          isError: true,
        });
      }

      let resp: Json;
      try {
        resp = JSON.parse(raw);
      } catch {
        return rpcResult(req.id, {
          content: [{ type: "text", text: "engine returned malformed output" }],
          isError: true,
        });
      }
      const status = String(resp.status ?? "unknown");
      // Publish passing checks for authenticated users. The account flag is
      // the default; an explicit per-call `publish` argument overrides it.
      // Auth and the flag were read in this same request, so the decision
      // uses a consistent snapshot (specs/Hub.tla's SafePublish invariant).
      if (
        params.name === "tlc_check" &&
        status === "ok" &&
        (args.publish ?? ctx.user.publish)
      ) {
        const stats = (resp.stats ?? {}) as CheckStats;
        resp.published = ctx.publish(
          name,
          args.spec,
          args.config as string,
          { distinctStates: stats.distinctStates, depth: stats.depth },
          { description: args.description, changelog: args.changelog },
        );
      }
      // A violation/timeout is a *successful* check — the tool did its job.
      // isError is reserved for requests the engine couldn't process at all.
      const isError = status === "config_error" && Array.isArray(resp.errors)
        && (resp.errors as Json[]).some((e) => e.category === "request");
      return rpcResult(req.id, {
        content: [{ type: "text", text: toolText(status, resp) }],
        structuredContent: resp,
        isError,
      });
    }

    default:
      return rpcError(req.id, -32601, `method not found: ${req.method}`);
  }
}
