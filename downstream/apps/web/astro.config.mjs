import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";

// Base domain comes from repo-root stack.generated.json (written by
// `bun run configure`); fall back to the upstream proc.io deployment when the
// repo has not been configured.
let baseDomain = "proc.io";
try {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const stack = JSON.parse(readFileSync(join(repoRoot, "stack.generated.json"), "utf8"));
  if (stack.baseDomain) baseDomain = stack.baseDomain;
} catch {
  // No stack.generated.json: keep the upstream default.
}

export default defineConfig({
  output: "server",
  adapter: cloudflare(),
  site: `https://downstream.${baseDomain}`,
});
