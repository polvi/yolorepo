import { createMiddleware } from 'hono/factory';
import type { AppContext } from './env';
import { authEndpoint } from './env';

export const TOKEN_PREFIX = 'gb_';
const BEARER_RE = /^Bearer\s+(gb_\S+)$/i;

// Cookie session (passkeys via AuthGravity) or a gb_ host token minted in the
// dashboard for the runner. gb_ tokens are resolved locally by sha256 hash and
// are NEVER forwarded to procauth.
export const requireUserOrToken = createMiddleware<AppContext>(async (c, next) => {
  const bearer = c.req.header('authorization')?.match(BEARER_RE);
  const userId = bearer
    ? await resolveTokenUser(bearer[1]!, c.env.DB, (p) => c.executionCtx.waitUntil(p))
    : await resolveCookieUser(c.req.raw, c.env);
  if (!userId) return c.json({ error: 'unauthenticated' }, 401);
  c.set('userId', userId);
  await next();
});

// Cookie-session auth only. Token management routes use this so a stolen
// gb_ token can never list, mint, or revoke tokens.
export const requireCookieUser = createMiddleware<AppContext>(async (c, next) => {
  const userId = await resolveCookieUser(c.req.raw, c.env);
  if (!userId) return c.json({ error: 'unauthenticated' }, 401);
  c.set('userId', userId);
  await next();
});

export async function resolveCookieUser(
  req: Request,
  env: { AUTH_ENDPOINT?: string; DEV_USER_ID?: string }
): Promise<string | null> {
  if (env.DEV_USER_ID) return env.DEV_USER_ID;

  const cookie = req.headers.get('cookie');
  if (!cookie) return null;
  const res = await fetch(`${authEndpoint(env)}/v1/whoami`, { headers: { cookie } });
  if (!res.ok) return null;
  const { user_id } = (await res.json()) as { user_id: string };
  return user_id;
}

export async function resolveTokenUser(
  token: string,
  db: D1Database,
  waitUntil: (p: Promise<unknown>) => void
): Promise<string | null> {
  const hash = await sha256Hex(token);
  const row = await db
    .prepare('SELECT user_id FROM api_tokens WHERE token_hash = ?')
    .bind(hash)
    .first<{ user_id: string }>();
  if (!row) return null;
  waitUntil(
    db
      .prepare('UPDATE api_tokens SET last_used_at = ? WHERE token_hash = ?')
      .bind(Date.now(), hash)
      .run()
  );
  return row.user_id;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Mint a new host token: `gb_` + 192 bits of entropy, base64url. */
export function generateApiToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const b64 = btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
  return `${TOKEN_PREFIX}${b64}`;
}
