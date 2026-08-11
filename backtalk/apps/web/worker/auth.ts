import { createMiddleware } from 'hono/factory';
import type { AppContext } from './env';
import { authEndpoint } from './env';
import { randomBase64Url, sha256Hex } from './hash';

export const TOKEN_PREFIX = 'bt_';
const BEARER_RE = /^Bearer\s+(bt_\S+)$/i;

// Cookie session (passkeys via AuthGravity) or a bt_ API token minted for
// the MCP server / coding agents. bt_ tokens are resolved locally by sha256
// hash and are NEVER forwarded to procauth.
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
// bt_ token can never list, mint, or revoke tokens.
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

/** Mint a new API token: `bt_` + 192 bits of entropy, base64url. */
export function generateApiToken(): string {
  return `${TOKEN_PREFIX}${randomBase64Url(24)}`;
}

/** Non-secret project ingest key: `pk_` + 96 bits, base64url. */
export function generatePublicKey(): string {
  return `pk_${randomBase64Url(12)}`;
}
