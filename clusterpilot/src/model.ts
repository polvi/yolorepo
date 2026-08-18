// Model wiring for the local llama.cpp server.
//
// Clusterpilot asks the server which model is actually resident rather than
// naming one up front. llama-server holds one model at a time, so pinning a
// name in config just means fighting whatever is already loaded -- and the
// weights are tens of gigabytes, so a swap is not a cheap accident.

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Config } from "./config.ts";

const PROVIDER = "llama-cpp";

export interface LoadedModel {
  id: string;
  contextWindow: number;
}

/** Asks the server for its model list. Throws with a usable message if it is down. */
export async function detectLoadedModel(baseUrl: string): Promise<LoadedModel> {
  const url = `${baseUrl.replace(/\/$/, "")}/models`;
  let body: { data?: { id: string; meta?: { n_ctx?: number } }[] };

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    body = (await res.json()) as typeof body;
  } catch (err) {
    throw new Error(
      `No llama.cpp server answering at ${url} (${(err as Error).message}). Start it with pi-llama-up, or point LLAMA_BASE_URL somewhere else.`,
    );
  }

  const first = body.data?.[0];
  if (!first) throw new Error(`${url} returned no models; the server is up but nothing is loaded.`);

  return { id: first.id, contextWindow: first.meta?.n_ctx ?? 32768 };
}

/**
 * Builds a models.json describing just this provider and hands back a
 * ModelRuntime over it. Writing our own means clusterpilot works whether or not
 * ~/.pi/agent/models.json has been set up, and never depends on the ambient
 * pi configuration matching what the server currently holds.
 */
async function runtimeForLocalModel(cfg: Config, loaded: LoadedModel): Promise<ModelRuntime> {
  const dir = await mkdtemp(join(tmpdir(), "clusterpilot-"));
  const modelsPath = join(dir, "models.json");

  const models = {
    providers: {
      [PROVIDER]: {
        baseUrl: cfg.llamaBaseUrl,
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
            id: loaded.id,
            name: `${loaded.id} (local llama.cpp)`,
            reasoning: true,
            input: ["text"],
            contextWindow: loaded.contextWindow,
            // Plans are long; leave room for one without eating the whole window.
            maxTokens: Math.min(16384, Math.floor(loaded.contextWindow / 4)),
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

export async function resolveModel(cfg: Config) {
  const loaded = await detectLoadedModel(cfg.llamaBaseUrl);

  if (cfg.model && cfg.model !== loaded.id) {
    throw new Error(
      `Config asks for '${cfg.model}' but the server has '${loaded.id}' loaded. llama-server holds one model at a time; either drop the pin or restart the server with PI_LLAMA_ALIAS=${cfg.model}.`,
    );
  }

  const modelRuntime = await runtimeForLocalModel(cfg, loaded);
  const model = modelRuntime.getModel(PROVIDER, loaded.id);
  if (!model) throw new Error(`pi did not register ${PROVIDER}/${loaded.id}`);

  return { model, modelRuntime, loaded };
}
