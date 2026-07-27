// Shared types and helpers for the OpenMonkey registry and web app.

export interface Script {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  author_id: string;
  author_handle: string | null;
  forked_from: string | null; // script id of the fork source
  created_at: string;
  latest_version?: number;
  install_count?: number;
}

export interface ScriptVersion {
  id: string;
  script_id: string;
  version: number;
  code: string;
  match_patterns: string[]; // parsed from @match / @include
  changelog: string | null;
  created_at: string;
}

export type ScanVerdict = "pass" | "warn" | "fail";

export interface ScanReport {
  id: string;
  version_id: string;
  reporter_id: string;
  reporter_handle: string | null;
  verdict: ScanVerdict;
  summary: string | null;
  model: string | null;
  created_at: string;
}

export const DEFAULT_TPX_ENDPOINT = "https://api.tokenpony.dev/v1";
export const DEFAULT_TPX_MODEL = "llama-3.3-70b";

// The canonical upstream deployment. These stay proc.io on purpose: they name
// the upstream registry, and forks derive their own origins from the serving
// hostname (see baseDomainFromHostname / rewriteUpstreamHosts below).
export const UPSTREAM_BASE_DOMAIN = "proc.io";
export const REGISTRY_URL = "https://api.openmonkey.proc.io";
export const SITE_URL = "https://openmonkey.proc.io";

// ---- Deployment-relative origins --------------------------------------------

// Strip an app's own subdomain prefix off the serving hostname to recover the
// base domain the whole stack hangs off of, e.g.
//   baseDomainFromHostname("openmonkey.example.dev", "openmonkey.") === "example.dev"
// Falls back to the upstream base domain for localhost and previews.
export function baseDomainFromHostname(hostname: string, appPrefix: string): string {
  return hostname.startsWith(appPrefix)
    ? hostname.slice(appPrefix.length)
    : UPSTREAM_BASE_DOMAIN;
}

// Userscript sources published to the upstream registry (including the
// dogfood scripts in userscripts/) reference the upstream hosts. When a fork
// serves those scripts, rewrite the hostnames to the fork's own equivalents
// at serve time. No-op when serving from the upstream base domain itself.
// Replacement order matters: longest / most specific hostname first, so
// api.openmonkey.* is not clobbered by the openmonkey.* replacement.
export function rewriteUpstreamHosts(code: string, baseDomain: string): string {
  if (!baseDomain || baseDomain === UPSTREAM_BASE_DOMAIN) return code;
  const replacements: Array<[string, string]> = [
    [`api.openmonkey.${UPSTREAM_BASE_DOMAIN}`, `api.openmonkey.${baseDomain}`],
    [`authgravity.${UPSTREAM_BASE_DOMAIN}`, `authgravity.${baseDomain}`],
    [`openmonkey.${UPSTREAM_BASE_DOMAIN}`, `openmonkey.${baseDomain}`],
    [`auth.${UPSTREAM_BASE_DOMAIN}`, `auth.${baseDomain}`],
  ];
  let out = code;
  for (const [from, to] of replacements) out = out.replaceAll(from, to);
  return out;
}

// ---- Userscript metadata block parsing -------------------------------------

export interface UserscriptMeta {
  name?: string;
  description?: string;
  version?: string;
  matches: string[]; // @match + @include values
}

export function parseUserscriptMeta(code: string): UserscriptMeta {
  const meta: UserscriptMeta = { matches: [] };
  const block = code.match(/\/\/\s*==UserScript==([\s\S]*?)\/\/\s*==\/UserScript==/);
  if (!block) return meta;
  for (const line of block[1].split("\n")) {
    const m = line.match(/^\s*\/\/\s*@(\S+)\s+(.+?)\s*$/);
    if (!m) continue;
    const [, key, value] = m;
    if (key === "name") meta.name = value;
    else if (key === "description") meta.description = value;
    else if (key === "version") meta.version = value;
    else if (key === "match" || key === "include") meta.matches.push(value);
  }
  return meta;
}

// Convert a @match / @include pattern into a RegExp for URL matching.
export function patternToRegExp(pattern: string): RegExp {
  if (pattern.startsWith("/") && pattern.endsWith("/") && pattern.length > 2) {
    return new RegExp(pattern.slice(1, -1));
  }
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp("^" + escaped + "$");
}

export function urlMatches(url: string, patterns: string[]): boolean {
  return patterns.some((p) => {
    try {
      return patternToRegExp(p).test(url);
    } catch {
      return false;
    }
  });
}

// ---- Security scan prompt ---------------------------------------------------

export const SCAN_SYSTEM_PROMPT = `You are a security auditor for browser userscripts. You receive the full source of a userscript that a user wants to install. Analyze it for behavior that could harm the user, including:

- exfiltration of cookies, tokens, form fields, keystrokes, or page content to third-party servers
- credential or payment-data harvesting
- injection of remote code (loading scripts from external URLs, eval of fetched content)
- cryptomining, click fraud, ad injection, affiliate hijacking
- obfuscated code whose purpose cannot be determined
- privilege abuse beyond what the script's stated purpose requires

Respond with ONLY a JSON object, no prose, in this exact shape:
{"verdict":"pass"|"warn"|"fail","summary":"<one or two sentences a non-expert can understand>","risks":["<specific risk>", ...]}

verdict rules:
- "pass": no meaningful risk found; behavior matches the stated purpose.
- "warn": something questionable or unnecessary for the stated purpose (broad matches, third-party requests that may be legitimate, minor data sharing) — the user should read the summary before deciding.
- "fail": clear evidence of malicious or deceptive behavior, remote code execution, or data exfiltration; or the code is too obfuscated to audit.`;

export function buildScanUserPrompt(name: string, code: string): string {
  return `Userscript name: ${name}\n\nSource:\n\`\`\`javascript\n${code}\n\`\`\``;
}

// ---- Script generation prompt ------------------------------------------------

export const GENERATE_SYSTEM_PROMPT = `You write browser userscripts. Output ONLY JavaScript source code for a single userscript, with a standard metadata block:

// ==UserScript==
// @name         <short name>
// @description  <one line>
// @version      1.0.0
// @match        <url pattern(s), as specific as possible>
// ==/UserScript==

Rules: plain JavaScript (no build steps, no imports, no external script loading), operate only on the matched page's DOM, request no data from third-party servers unless the user's description explicitly requires it. Wrap logic in an IIFE. No explanation text before or after the code.`;
