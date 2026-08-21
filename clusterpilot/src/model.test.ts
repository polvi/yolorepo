import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { readPiDefault } from "./model.ts";

async function settingsWith(contents: string): Promise<Config> {
  const dir = await mkdtemp(join(tmpdir(), "cp-settings-"));
  const path = join(dir, "settings.json");
  await writeFile(path, contents);
  return { settingsJson: path } as Config;
}

describe("pi default provider/model", () => {
  test("reads defaultProvider and defaultModel", async () => {
    const cfg = await settingsWith(
      JSON.stringify({ theme: "light", defaultProvider: "proc", defaultModel: "qwen3.8-27b" }),
    );
    expect(await readPiDefault(cfg)).toEqual({ providerId: "proc", modelId: "qwen3.8-27b" });
  });

  test("absent settings.json is no preference, not an error", async () => {
    const cfg = { settingsJson: join(tmpdir(), "definitely-not-here", "settings.json") } as Config;
    expect(await readPiDefault(cfg)).toBeUndefined();
  });

  // A preference file should never be able to strand a cluster job, so a
  // corrupt or half-written settings.json degrades to "no preference".
  test("malformed JSON is no preference, not a throw", async () => {
    const cfg = await settingsWith("{ this is not json");
    expect(await readPiDefault(cfg)).toBeUndefined();
  });

  test("half a preference is no preference", async () => {
    const onlyProvider = await settingsWith(JSON.stringify({ defaultProvider: "proc" }));
    expect(await readPiDefault(onlyProvider)).toBeUndefined();

    const onlyModel = await settingsWith(JSON.stringify({ defaultModel: "qwen3.8-27b" }));
    expect(await readPiDefault(onlyModel)).toBeUndefined();
  });

  test("non-string or empty values are ignored", async () => {
    const wrongType = await settingsWith(JSON.stringify({ defaultProvider: 7, defaultModel: "x" }));
    expect(await readPiDefault(wrongType)).toBeUndefined();

    const empty = await settingsWith(JSON.stringify({ defaultProvider: "", defaultModel: "x" }));
    expect(await readPiDefault(empty)).toBeUndefined();
  });
});
