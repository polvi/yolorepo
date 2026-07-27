// Optional authentication. Identity comes from AuthGravity (passkeys on
// authgravity.<baseDomain> — same registrable domain, so its session_id
// cookie is first-party here). We store only the stable user UUID it
// returns, plus SHA-256 hashes of API keys we mint for MCP bearer auth.

// Configured per deployment via the AUTH_ENDPOINT var (rendered from
// stack config by `bun run configure`); the proc.io deployment's endpoint
// doubles as the fallback for configs that predate the var.
const AUTHGRAVITY_FALLBACK = "https://authgravity.proc.io";

export function authgravityOrigin(env: { AUTH_ENDPOINT?: string }): string {
  return env.AUTH_ENDPOINT || AUTHGRAVITY_FALLBACK;
}

export interface AuthedUser {
  id: string;
  publish: boolean;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Mint a new API key: `tlck_` + 192 bits of entropy, base64url. */
export function generateApiKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const b64 = btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
  return `tlck_${b64}`;
}

/**
 * Resolve the signed-in browser session to an AuthGravity user UUID by
 * forwarding the incoming cookie header to /v1/whoami. Null when signed out.
 */
export async function whoami(request: Request, authgravity: string): Promise<string | null> {
  const cookie = request.headers.get("cookie");
  if (!cookie) return null;
  const res = await fetch(`${authgravity}/v1/whoami`, { headers: { cookie } });
  if (!res.ok) return null;
  const body = (await res.json()) as { user_id?: string };
  return typeof body.user_id === "string" ? body.user_id : null;
}

/**
 * Validate an optional `Authorization: Bearer tlck_...` header against the
 * api_keys table (lookup is by SHA-256 hash, so no plaintext at rest and no
 * timing-sensitive comparison). Returns:
 *  - null when no bearer token was presented (anonymous is fine),
 *  - "invalid" when one was presented but doesn't match,
 *  - the user otherwise.
 */
export async function authenticateBearer(
  request: Request,
  db: D1Database,
  waitUntil: (p: Promise<unknown>) => void,
): Promise<AuthedUser | "invalid" | null> {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const m = header.match(/^Bearer\s+(\S+)$/i);
  if (!m) return "invalid";
  const keyHash = await sha256Hex(m[1]);
  const row = await db
    .prepare(
      "SELECT u.id AS id, u.publish AS publish FROM api_keys k JOIN users u ON u.id = k.user_id WHERE k.key_hash = ?",
    )
    .bind(keyHash)
    .first<{ id: string; publish: number }>();
  if (!row) return "invalid";
  waitUntil(
    db
      .prepare("UPDATE api_keys SET last_used_at = datetime('now') WHERE key_hash = ?")
      .bind(keyHash)
      .run(),
  );
  return { id: row.id, publish: row.publish === 1 };
}
