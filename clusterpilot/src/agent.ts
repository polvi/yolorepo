// The pi agent session.
//
// Built with an explicit ResourceLoader rather than the default discovery one:
// clusterpilot should behave identically no matter what extensions, skills, or
// AGENTS.md files happen to sit in the working directory, and the model's whole
// brief should be the cluster state we assembled.

import {
  createAgentSession,
  createExtensionRuntime,
  DefaultResourceLoader,
  getAgentDir,
  type ResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Config } from "./config.ts";
import { resolveModel } from "./model.ts";
import { SYSTEM_PROMPT } from "./prompt.ts";
import { makeProbeExtension } from "./tools.ts";

export interface RunAgentOptions {
  cfg: Config;
  prompt: string;
  /** Stream assistant text to stdout as it arrives. */
  stream?: boolean;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high";
  /** Overrides the planning prompt; the troubleshooter passes its own. */
  systemPrompt?: string;
}

export interface AgentOutcome {
  text: string;
  modelId: string;
  toolCalls: { name: string; ok: boolean }[];
}

export async function runAgent(opts: RunAgentOptions): Promise<AgentOutcome> {
  const { cfg, prompt } = opts;
  const { model, modelRuntime, loaded } = await resolveModel(cfg);

  // Extensions have to come from a real loader (they need the runtime), but we
  // want ours and nothing else, so we build a DefaultResourceLoader purely for
  // its extension machinery and stub the rest of the interface flat.
  const extensionHost = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    extensionFactories: [makeProbeExtension(cfg)],
  });
  await extensionHost.reload();

  const resourceLoader: ResourceLoader = {
    getExtensions: () => {
      try {
        return extensionHost.getExtensions();
      } catch {
        return { extensions: [], errors: [], runtime: createExtensionRuntime() };
      }
    },
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => opts.systemPrompt ?? SYSTEM_PROMPT,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };

  const { session } = await createAgentSession({
    cwd: process.cwd(),
    model,
    modelRuntime,
    thinkingLevel: opts.thinkingLevel ?? "medium",
    resourceLoader,
    // No filesystem tools: the plan is text, and every cluster fact the model
    // needs either came in the brief or comes back through `probe`.
    tools: ["probe"],
    sessionManager: SessionManager.inMemory(process.cwd()),
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: true },
      retry: { enabled: true, maxRetries: 2 },
    }),
  });

  const chunks: string[] = [];
  const toolCalls: { name: string; ok: boolean }[] = [];

  try {
    session.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        const delta = event.assistantMessageEvent.delta;
        chunks.push(delta);
        if (opts.stream) process.stdout.write(delta);
      } else if (event.type === "tool_execution_start") {
        if (opts.stream) process.stderr.write(`\n[probe] ${event.toolName}\n`);
      } else if (event.type === "tool_execution_end") {
        toolCalls.push({ name: event.toolName, ok: true });
      }
    });

    await session.prompt(prompt);
  } finally {
    session.dispose();
  }

  return { text: chunks.join(""), modelId: loaded.id, toolCalls };
}
