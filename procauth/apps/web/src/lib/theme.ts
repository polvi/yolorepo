// Light skinning for the shared auth surface. Two conventions, both optional:
//
// 1. Registry: apps on the stack's base domain get a palette here, keyed by
//    their subdomain label and resolved from the return_to hostname —
//    linking with return_to is all an app has to do, on any base domain.
// 2. Query overrides: ?accent=3fb950&app=name etc. for apps not registered
//    yet. Values are clamped to hex colors / a short display name.
//
// The surface stays structurally identical either way — colors and an app
// chip only, so the page is always recognizably the auth surface.

export interface Theme {
  app?: string;
  vars: Record<string, string>;
}

const VAR_KEYS = ["bg", "panel", "border", "text", "muted", "accent", "fail"] as const;
const HEX = /^#[0-9a-fA-F]{3,8}$/;

// Keyed by the app's subdomain label (the first label of the return_to
// hostname), so registrations hold on any base domain.
const REGISTRY: Record<string, { app: string; vars: Partial<Record<(typeof VAR_KEYS)[number], string>> }> = {
  openmonkey: {
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
  forkable: {
    app: "forkable",
    vars: {
      bg: "#faf8f5",
      panel: "#ffffff",
      border: "#e5e0d8",
      text: "#1c1b1a",
      muted: "#8a857e",
      accent: "#c04e2a",
    },
  },
};

export function resolveTheme(url: URL): Theme {
  let host = "";
  try {
    host = new URL(url.searchParams.get("return_to") || "").hostname;
  } catch {}
  // First label wins (openmonkey.<base>); the second covers apps whose
  // return_to comes from a deeper host (app.happybook.<base>,
  // <site>.forkable.<base>).
  const labels = host.split(".");
  const reg = REGISTRY[labels[0] ?? ""] ?? REGISTRY[labels[1] ?? ""];
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
