// First-party AuthGravity client: passkey ceremonies against the raw API.
// Account-key and device-key flows come from @authgravity/browser; WebAuthn
// ceremonies are the app's job, implemented here.

export const AUTHG = "https://authgravity.proc.io";

export interface VerifyResult {
  verified: boolean;
  user?: { id: string };
  error?: string;
}

const b64uToBuf = (s: string): ArrayBuffer => {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
};

const bufToB64u = (buf: ArrayBuffer): string =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

// Manual fallbacks for browsers without PublicKeyCredential JSON helpers
// (Safari gained them in 18.x and Safari is a first-class target here).
function parseCreationOptions(json: any): PublicKeyCredentialCreationOptions {
  const PKC = window.PublicKeyCredential as any;
  if (PKC?.parseCreationOptionsFromJSON) return PKC.parseCreationOptionsFromJSON(json);
  return {
    ...json,
    challenge: b64uToBuf(json.challenge),
    user: { ...json.user, id: b64uToBuf(json.user.id) },
    excludeCredentials: (json.excludeCredentials || []).map((c: any) => ({ ...c, id: b64uToBuf(c.id) })),
  };
}

function parseRequestOptions(json: any): PublicKeyCredentialRequestOptions {
  const PKC = window.PublicKeyCredential as any;
  if (PKC?.parseRequestOptionsFromJSON) return PKC.parseRequestOptionsFromJSON(json);
  return {
    ...json,
    challenge: b64uToBuf(json.challenge),
    allowCredentials: (json.allowCredentials || []).map((c: any) => ({ ...c, id: b64uToBuf(c.id) })),
  };
}

function credentialToJSON(cred: any): any {
  if (typeof cred.toJSON === "function") return cred.toJSON();
  const r = cred.response;
  const response: any = { clientDataJSON: bufToB64u(r.clientDataJSON) };
  if ("attestationObject" in r) {
    response.attestationObject = bufToB64u(r.attestationObject);
    if (typeof r.getTransports === "function") response.transports = r.getTransports();
  } else {
    response.authenticatorData = bufToB64u(r.authenticatorData);
    response.signature = bufToB64u(r.signature);
    if (r.userHandle) response.userHandle = bufToB64u(r.userHandle);
  }
  return {
    id: cred.id,
    rawId: bufToB64u(cred.rawId),
    type: cred.type,
    clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {},
    authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
    response,
  };
}

async function ceremony(phase: "register" | "login"): Promise<VerifyResult> {
  const optRes = await fetch(`${AUTHG}/v1/${phase}/options`, { credentials: "include" });
  if (!optRes.ok) return { verified: false, error: `options failed (${optRes.status})` };
  const options = await optRes.json();
  const cred =
    phase === "register"
      ? await navigator.credentials.create({ publicKey: parseCreationOptions(options) })
      : await navigator.credentials.get({ publicKey: parseRequestOptions(options) });
  if (!cred) return { verified: false, error: "ceremony cancelled" };
  const verifyRes = await fetch(`${AUTHG}/v1/${phase}/verify`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(credentialToJSON(cred)),
  });
  const data = await verifyRes.json().catch(() => ({}));
  if (!verifyRes.ok) return { verified: false, error: data.error || `verify failed (${verifyRes.status})` };
  return data;
}

export const passkeyRegister = () => ceremony("register");
export const passkeyLogin = () => ceremony("login");

export async function whoami(): Promise<{ user_id: string; amr?: string } | null> {
  try {
    const res = await fetch(`${AUTHG}/v1/whoami`, { credentials: "include" });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

export async function logout(): Promise<void> {
  await fetch(`${AUTHG}/v1/logout`, { method: "POST", credentials: "include" });
}

// This surface serves every proc.io app: return_to may be a local path or an
// https URL on proc.io / any *.proc.io subdomain. Anything else falls back.
export function safeReturnTo(fallback = "/account"): string {
  const raw = new URLSearchParams(location.search).get("return_to") || "";
  if (!raw) return fallback;
  try {
    const u = new URL(raw, location.origin);
    const local = u.origin === location.origin;
    const procio = u.protocol === "https:" && (u.hostname === "proc.io" || u.hostname.endsWith(".proc.io"));
    if ((local || procio) && !u.pathname.startsWith("//")) return local ? u.pathname + u.search + u.hash : u.href;
  } catch {}
  return fallback;
}

// Keep return_to and any theme params when moving between /login and /register.
export function withReturnTo(path: string): string {
  const current = new URLSearchParams(location.search);
  const kept = new URLSearchParams();
  for (const k of ["return_to", "app", "bg", "panel", "border", "text", "muted", "accent", "fail"]) {
    const v = current.get(k);
    if (v) kept.set(k, v);
  }
  const q = kept.toString();
  return q ? `${path}?${q}` : path;
}
