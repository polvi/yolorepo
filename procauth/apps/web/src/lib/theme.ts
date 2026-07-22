// Light skinning for the shared auth surface. Two conventions, both optional:
//
// 1. Registry: apps on *.proc.io get a palette here, resolved from the
//    return_to hostname — linking with return_to is all an app has to do.
// 2. Query overrides: ?accent=3fb950&app=name etc. for apps not registered
//    yet. Values are clamped to hex colors / a short display name.
//
// The surface stays structurally identical either way — colors and an app
// chip only, so the page is always recognizably auth.proc.io.

export interface Theme {
  app?: string;
  vars: Record<string, string>;
}

const VAR_KEYS = ["bg", "panel", "border", "text", "muted", "accent", "fail"] as const;
const HEX = /^#[0-9a-fA-F]{3,8}$/;

const REGISTRY: Record<string, { app: string; vars: Partial<Record<(typeof VAR_KEYS)[number], string>> }> = {
  "openmonkey.proc.io": {
    app: "openmonkey",
    vars: {
      bg: "#0d1117",
      panel: "#161b22",
      border: "#2d333b",
      text: "#e6edf3",
      muted: "#9198a1",
      accent: "#3fb950",
    },
  },
};

export function resolveTheme(url: URL): Theme {
  let host = "";
  try {
    host = new URL(url.searchParams.get("return_to") || "").hostname;
  } catch {}
  const reg = REGISTRY[host];
  const vars: Record<string, string> = { ...(reg?.vars ?? {}) };
  for (const k of VAR_KEYS) {
    const v = url.searchParams.get(k);
    if (!v) continue;
    const hex = v.startsWith("#") ? v : `#${v}`;
    if (HEX.test(hex)) vars[k] = hex;
  }
  const app = url.searchParams.get("app")?.slice(0, 32).trim() || reg?.app;
  return { app, vars };
}

// Inline style for :root; keys are from VAR_KEYS and values hex-validated,
// so the string is safe to render.
export function themeStyle(theme: Theme): string | undefined {
  const entries = Object.entries(theme.vars);
  if (entries.length === 0) return undefined;
  return entries.map(([k, v]) => `--${k}: ${v}`).join("; ");
}
