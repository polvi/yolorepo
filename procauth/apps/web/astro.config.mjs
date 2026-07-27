import { readFileSync } from "node:fs";
import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";

// Base domain comes from the repo-root stack.generated.json written by
// `bun run configure`; checked-out defaults fall back to proc.io.
let baseDomain = "proc.io";
try {
  const stack = JSON.parse(readFileSync(new URL("../../../stack.generated.json", import.meta.url), "utf8"));
  if (stack.baseDomain) baseDomain = stack.baseDomain;
} catch {}

export default defineConfig({
  output: "server",
  adapter: cloudflare(),
  site: `https://auth.${baseDomain}`,
});
