// Minimal Ollama HTTP client. Durations are nanoseconds (Ollama convention).

const BASE = process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434";

export interface GenerateStats {
  model: string;
  total_duration: number;
  load_duration: number;
  prompt_eval_count: number;
  prompt_eval_duration: number;
  eval_count: number;
  eval_duration: number;
}

export async function listModels(): Promise<string[]> {
  const res = await fetch(`${BASE}/api/tags`);
  if (!res.ok) throw new Error(`ollama /api/tags: ${res.status}`);
  const body = (await res.json()) as { models?: { name: string }[] };
  return (body.models ?? []).map((m) => m.name);
}

export async function pull(model: string): Promise<void> {
  const res = await fetch(`${BASE}/api/pull`, {
    method: "POST",
    body: JSON.stringify({ model, stream: false }),
  });
  if (!res.ok) throw new Error(`ollama pull ${model}: ${res.status} ${await res.text()}`);
}

export async function generate(
  model: string,
  prompt: string,
  numPredict: number,
): Promise<GenerateStats> {
  const res = await fetch(`${BASE}/api/generate`, {
    method: "POST",
    body: JSON.stringify({
      model,
      prompt,
      stream: false,
      options: { num_predict: numPredict, temperature: 0.7, seed: 42 },
    }),
  });
  if (!res.ok) throw new Error(`ollama generate ${model}: ${res.status} ${await res.text()}`);
  return (await res.json()) as GenerateStats;
}

/** Unload the model so the next model's run starts from a clean slate. */
export async function unload(model: string): Promise<void> {
  await fetch(`${BASE}/api/generate`, {
    method: "POST",
    body: JSON.stringify({ model, keep_alive: 0 }),
  });
}
