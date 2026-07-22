// OpenMonkey background worker: registry client, TPX scanning, install store.
/* global chrome, browser */
const ext = typeof browser !== "undefined" ? browser : chrome;

const REGISTRY = "https://api.openmonkey.proc.io/api";
const DEFAULTS = {
  tpxEndpoint: "https://api.tokenpony.dev/v1",
  tpxKey: "",
  tpxModel: "llama-3.3-70b",
};

const SCAN_SYSTEM_PROMPT = `You are a security auditor for browser userscripts. You receive the full source of a userscript that a user wants to install. Analyze it for behavior that could harm the user, including:

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
- "warn": something questionable or unnecessary for the stated purpose (broad matches, third-party requests that may be legitimate, minor data sharing) - the user should read the summary before deciding.
- "fail": clear evidence of malicious or deceptive behavior, remote code execution, or data exfiltration; or the code is too obfuscated to audit.`;

const GENERATE_SYSTEM_PROMPT = `You write browser userscripts. Output ONLY JavaScript source code for a single userscript, with a standard metadata block:

// ==UserScript==
// @name         <short name>
// @description  <one line>
// @version      1.0.0
// @match        <url pattern(s), as specific as possible>
// ==/UserScript==

Rules: plain JavaScript (no build steps, no imports, no external script loading), operate only on the matched page's DOM, request no data from third-party servers unless the user's description explicitly requires it. Wrap logic in an IIFE. No explanation text before or after the code.`;

// ---- settings & storage ------------------------------------------------------

async function getSettings() {
  const stored = await ext.storage.local.get("settings");
  return { ...DEFAULTS, ...(stored.settings || {}) };
}

async function getInstalled() {
  const stored = await ext.storage.local.get("installed");
  return stored.installed || {};
}

async function setInstalled(installed) {
  await ext.storage.local.set({ installed });
}

// ---- registry client -----------------------------------------------------------

async function registry(path, init = {}) {
  const res = await fetch(REGISTRY + path, { credentials: "include", ...init });
  if (!res.ok) {
    const err = new Error(`registry ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function whoami() {
  try {
    const { user } = await registry("/me");
    return user;
  } catch {
    return null;
  }
}

// ---- TPX inference ---------------------------------------------------------------

async function tpxChat(messages, maxTokens) {
  const s = await getSettings();
  if (!s.tpxKey) throw new Error("no_tpx_key");
  const res = await fetch(`${s.tpxEndpoint.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${s.tpxKey}`,
    },
    body: JSON.stringify({
      model: s.tpxModel,
      messages,
      max_tokens: maxTokens || 2048,
      stream: false,
    }),
  });
  if (!res.ok) throw new Error(`tpx_${res.status}`);
  const data = await res.json();
  return { text: data.choices?.[0]?.message?.content ?? "", model: s.tpxModel };
}

function extractJson(text) {
  const stripped = text.replace(/^```(json)?\s*|\s*```$/g, "").trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("scan_unparseable");
  return JSON.parse(stripped.slice(start, end + 1));
}

async function scanCode(name, code) {
  const { text, model } = await tpxChat(
    [
      { role: "system", content: SCAN_SYSTEM_PROMPT },
      { role: "user", content: `Userscript name: ${name}\n\nSource:\n\`\`\`javascript\n${code}\n\`\`\`` },
    ],
    1024
  );
  const parsed = extractJson(text);
  if (!["pass", "warn", "fail"].includes(parsed.verdict)) throw new Error("scan_unparseable");
  return { verdict: parsed.verdict, summary: parsed.summary || "", risks: parsed.risks || [], model };
}

// ---- install flow -----------------------------------------------------------------
// The invariant (model-checked in specs/OpenMonkey.tla): a foreign (non-author)
// script version is never stored as runnable without a scan of exactly that
// version that passed, or warned with an explicit user override. fail never installs.

async function installScript({ slug, override = false }) {
  const { script, version } = await registry(`/scripts/${encodeURIComponent(slug)}`);
  if (!version) throw new Error("no_version");
  const me = await whoami();
  const isAuthor = !!me && me.id === script.author_id;

  let scan = null;
  if (!isAuthor) {
    scan = await scanCode(script.name, version.code);
    if (scan.verdict === "fail") {
      return { status: "blocked", scan, script };
    }
    if (scan.verdict === "warn" && !override) {
      return { status: "needs_override", scan, script };
    }
    // Publish the verdict to the registry (transparency; best-effort).
    if (me) {
      registry(`/versions/${version.id}/scans`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ verdict: scan.verdict, summary: scan.summary, model: scan.model }),
      }).catch(() => {});
    }
  }

  const installed = await getInstalled();
  installed[script.id] = {
    scriptId: script.id,
    slug: script.slug,
    name: script.name,
    author: script.author_handle,
    version: version.version,
    versionId: version.id,
    code: version.code,
    matches: JSON.parse(version.match_patterns),
    enabled: true,
    isAuthor,
    scan,
    overridden: !isAuthor && scan && scan.verdict === "warn",
    installedAt: new Date().toISOString(),
  };
  await setInstalled(installed);
  fetch(`${REGISTRY}/scripts/${encodeURIComponent(slug)}/installed`, { method: "POST" }).catch(() => {});
  return { status: "installed", scan, script };
}

// ---- publish / generate --------------------------------------------------------------

async function publishScript({ code, name, description }) {
  const { script } = await registry("/scripts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, name, description }),
  });
  // Author installs their own creation directly; no scan needed.
  await installScript({ slug: script.slug });
  return script;
}

async function generateScript(description) {
  const { text } = await tpxChat(
    [
      { role: "system", content: GENERATE_SYSTEM_PROMPT },
      { role: "user", content: description },
    ],
    4096
  );
  return text.replace(/^```(javascript|js)?\s*\n?|\n?```\s*$/g, "");
}

async function forkScript({ slug, code, name }) {
  const { script } = await registry(`/scripts/${encodeURIComponent(slug)}/fork`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, name }),
  });
  await installScript({ slug: script.slug });
  return script;
}

// ---- URL matching for the injector ------------------------------------------------------

function patternToRegExp(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp("^" + escaped + "$");
}

async function scriptsForUrl(url) {
  const installed = await getInstalled();
  return Object.values(installed).filter((s) => {
    if (!s.enabled) return false;
    return s.matches.some((p) => {
      try {
        return patternToRegExp(p).test(url);
      } catch {
        return false;
      }
    });
  });
}

// ---- message router ---------------------------------------------------------------------

ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handlers = {
    getForUrl: () => scriptsForUrl(msg.url),
    install: () => installScript(msg),
    publish: () => publishScript(msg),
    generate: () => generateScript(msg.description),
    fork: () => forkScript(msg),
    list: () => getInstalled(),
    whoami: () => whoami(),
    getSettings: () => getSettings(),
    saveSettings: async () => {
      await ext.storage.local.set({ settings: msg.settings });
      return { ok: true };
    },
    remove: async () => {
      const installed = await getInstalled();
      delete installed[msg.scriptId];
      await setInstalled(installed);
      return { ok: true };
    },
    toggle: async () => {
      const installed = await getInstalled();
      if (installed[msg.scriptId]) {
        installed[msg.scriptId].enabled = !installed[msg.scriptId].enabled;
        await setInstalled(installed);
      }
      return { ok: true };
    },
  };
  const handler = handlers[msg.type];
  if (!handler) return false;
  handler()
    .then((result) => sendResponse({ ok: true, result }))
    .catch((e) => sendResponse({ ok: false, error: String(e && e.message ? e.message : e) }));
  return true; // async response
});
