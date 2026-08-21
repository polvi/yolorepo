// Model wiring.
//
// clusterpilot reads the same models.json pi itself reads (~/.pi/agent/
// models.json by default), so any provider you have registered there — the
// local llama.cpp server, a vLLM box on the dev cluster — is available with
// no clusterpilot-specific plumbing.
//
// Which model gets used:
//   CLUSTERPILOT_MODEL unset -> whatever the local llama.cpp server has loaded
//     right now, asked live via GET /models. llama-server holds one model at a
//     time and a swap costs tens of GB, so we never fight what is resident.
//   CLUSTERPILOT_MODEL set   -> "provider/model" or a bare model id, resolved
//     against models.json. A bare id must match exactly one model across all
//     providers; a bare provider name takes that provider's first model.
//
// Either way, the chosen server is asked what it actually serves before
// anything else, so a stale models.json or a swapped-in model surfaces here,
// not mid-plan.

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Config } from "./config.ts";

/** Provider id used when models.json does not describe what the server serves. */
const SYNTH_PROVIDER = "llama-cpp";

export interface ModelTarget {
  /** Provider id as registered in models.json (SYNTH_PROVIDER when synthesized). */
  providerId: string;
  modelId: string;
  /** OpenAI-compatible base URL of the server serving the model. */
  baseUrl: string;
  contextWindow: number;
  /** True when the model entry came from models.json; false when synthesized from /models. */
  fromCatalog: boolean;
}

interface ServedModel {
  id: string;
  contextWindow: number;
}

interface CatalogModel {
  id: string;
  contextWindow?: number;
  [key: string]: unknown;
}

interface CatalogProvider {
  baseUrl: string;
  models?: CatalogModel[];
  [key: string]: unknown;
}

function catalogPathFor(cfg: Config): string {
  return cfg.modelsJson ?? join(getAgentDir(), "models.json");
}

/**
 * Asks the server which models are resident. Throws with a usable message if
 * it is down.
 */
async function listServedModels(baseUrl: string, hint: string): Promise<ServedModel[]> {
  const url = `${baseUrl.replace(/\/$/, "")}/models`;
  let body: { data?: { id: string; meta?: { n_ctx?: number } }[] };

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    body = (await res.json()) as typeof body;
  } catch (err) {
    throw new Error(`No OpenAI-compatible server answering at ${url} (${(err as Error).message}). ${hint}`);
  }

  return (body.data ?? []).map((m) => ({ id: m.id, contextWindow: m.meta?.n_ctx ?? 32768 }));
}

/**
 * Reads the models.json pi itself reads. Absent is fine — clusterpilot then
 * synthesizes a provider from the live /models. Malformed is not, since pi
 * itself would refuse to start against it.
 */
async function readCatalog(path: string): Promise<Record<string, CatalogProvider> | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  const parsed = JSON.parse(raw) as { providers?: Record<string, CatalogProvider> };
  return parsed.providers;
}

/** Base URLs compare without a trailing slash or a /v1 suffix. */
function normalizeBase(url: string): string {
  return url.replace(/\/+$/, "").replace(/\/v1$/, "");
}

async function assertServing(baseUrl: string, modelId: string): Promise<void> {
  const served = await listServedModels(
    baseUrl,
    "Check the provider's baseUrl in models.json, or unset CLUSTERPILOT_MODEL to use the local server.",
  );
  if (!served.some((m) => m.id === modelId)) {
    const have = served.map((m) => m.id).join(", ") || "nothing";
    throw new Error(`Server at ${baseUrl} is up but does not serve '${modelId}'. Served: ${have}.`);
  }
}

/**
 * Works out which provider and model to use, and confirms the server actually
 * serves it. Does not build the pi runtime.
 */
export async function resolveTarget(cfg: Config): Promise<ModelTarget> {
  const path = catalogPathFor(cfg);
  const catalog = await readCatalog(path);

  if (cfg.model) {
    const slash = cfg.model.indexOf("/");
    const providerName = slash >= 0 ? cfg.model.slice(0, slash) : undefined;
    const wanted = slash >= 0 ? cfg.model.slice(slash + 1) : cfg.model;

    if (!catalog) {
      throw new Error(
        `CLUSTERPILOT_MODEL is set to '${cfg.model}' but there is no models.json at ${path}. ` +
          `Run pi once to create it, or point CLUSTERPILOT_MODELS_JSON at one.`,
      );
    }

    const matches: { providerId: string; model: CatalogModel; baseUrl: string }[] = [];
    for (const [providerId, provider] of Object.entries(catalog)) {
      if (providerName && providerId !== providerName) continue;
      const model = provider.models?.find((m) => m.id === wanted);
      if (model) matches.push({ providerId, model, baseUrl: provider.baseUrl });
    }
    // A bare value that names a provider rather than a model: first model of
    // that provider. (Only for bare values — "proc/nope" is a typo, not a request for proc's first model.)
    if (matches.length === 0 && !providerName && catalog[wanted]?.models?.[0]) {
      const provider = catalog[wanted]!;
      const first = provider.models![0]!;
      matches.push({ providerId: wanted, model: first, baseUrl: provider.baseUrl });
    }
    const [match] = matches;
    if (!match) {
      const known = Object.entries(catalog)
        .flatMap(([providerId, provider]) => (provider.models ?? []).map((m) => `${providerId}/${m.id}`))
        .join(", ");
      throw new Error(`Model '${cfg.model}' not found in ${path}. Known models: ${known || "(none)"}.`);
    }
    if (matches.length > 1) {
      throw new Error(
        `Model '${cfg.model}' is ambiguous: ${matches.map((m) => `${m.providerId}/${m.model.id}`).join(", ")}. ` +
          `Use provider/model to disambiguate.`,
      );
    }

    await assertServing(match.baseUrl, match.model.id);
    return {
      providerId: match.providerId,
      modelId: match.model.id,
      baseUrl: match.baseUrl,
      contextWindow: match.model.contextWindow ?? 32768,
      fromCatalog: true,
    };
  }

  // No explicit model: whatever the local server has loaded.
  const served = await listServedModels(
    cfg.llamaBaseUrl,
    "Start it with pi-llama-up, or point LLAMA_BASE_URL somewhere else.",
  );
  const loaded = served[0];
  if (!loaded) {
    throw new Error(`${cfg.llamaBaseUrl} answered but has no model loaded. Start one with pi-llama-up.`);
  }

  // If the catalog describes this server and this model, prefer its entry: it
  // carries the real context window and your chosen sampling parameters.
  if (catalog) {
    for (const [providerId, provider] of Object.entries(catalog)) {
      if (normalizeBase(provider.baseUrl) !== normalizeBase(cfg.llamaBaseUrl)) continue;
      const model = provider.models?.find((m) => m.id === loaded.id);
      if (model) {
        return {
          providerId,
          modelId: loaded.id,
          baseUrl: provider.baseUrl,
          contextWindow: model.contextWindow ?? loaded.contextWindow,
          fromCatalog: true,
        };
      }
    }
  }

  return {
    providerId: SYNTH_PROVIDER,
    modelId: loaded.id,
    baseUrl: cfg.llamaBaseUrl,
    contextWindow: loaded.contextWindow,
    fromCatalog: false,
  };
}

export interface ResolvedModel {
  model: NonNullable<ReturnType<ModelRuntime["getModel"]>>;
  modelRuntime: ModelRuntime;
  target: ModelTarget;
}

/**
 * Resolves the model and builds the runtime that will serve it. When the
 * model is in models.json, the ambient file (and ambient auth.json) is used
 * as-is, so clusterpilot runs on exactly what pi runs on. Otherwise a minimal
 * one-model provider is synthesized from the live /models response.
 */
export async function resolveModel(cfg: Config): Promise<ResolvedModel> {
  const target = await resolveTarget(cfg);

  if (target.fromCatalog) {
    const runtime = await ModelRuntime.create({
      modelsPath: catalogPathFor(cfg),
      authPath: join(getAgentDir(), "auth.json"),
      // The availability refresh would just re-ask the server what we
      // already confirmed in resolveTarget.
      refreshOnCreate: false,
    });
    const model = runtime.getModel(target.providerId, target.modelId);
    if (model) return { model, modelRuntime: runtime, target };
  }

  // The server serves a model models.json does not (or no catalog exists at
  // all): synthesize a minimal provider for it.
  const runtime = await runtimeForSynthetic(target);
  const model = runtime.getModel(SYNTH_PROVIDER, target.modelId);
  if (!model) {
    throw new Error(`pi did not register ${SYNTH_PROVIDER}/${target.modelId}`);
  }

  return { model, modelRuntime: runtime, target };
}

/**
 * Builds a throwaway models.json with a single provider describing exactly
 * what the server said it serves. Used when models.json is absent or does not
 * describe the loaded model.
 */
async function runtimeForSynthetic(target: ModelTarget): Promise<ModelRuntime> {
  const dir = await mkdtemp(join(tmpdir(), "clusterpilot-"));
  const modelsPath = join(dir, "models.json");

  const models = {
    providers: {
      [SYNTH_PROVIDER]: {
        baseUrl: target.baseUrl,
        api: "openai-completions",
        apiKey: "none",
        compat: {
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
          supportsUsageInStreaming: true,
          maxTokensField: "max_tokens",
          thinkingFormat: "chat-template",
        },
        models: [
          {
            id: target.modelId,
            name: `${target.modelId} (detected via /models)`,
            reasoning: true,
            input: ["text"],
            contextWindow: target.contextWindow,
            // Plans are long; leave room for one without eating the whole window.
            maxTokens: Math.min(16384, Math.floor(target.contextWindow / 4)),
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            samplingParams: { temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0.0 },
          },
        ],
      },
    },
  };

  await writeFile(modelsPath, JSON.stringify(models, null, 2));
  return await ModelRuntime.create({ modelsPath, authPath: join(dir, "auth.json") });
}
