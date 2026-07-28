import { createMiddleware } from 'hono/factory';
import type { AppContext } from './env';
import { authEndpoint } from './env';

export const requireUser = createMiddleware<AppContext>(async (c, next) => {
  const userId = await resolveUser(c.req.raw, c.env);
  if (!userId) return c.json({ error: 'unauthenticated' }, 401);
  c.set('userId', userId);
  await next();
});

export async function resolveUser(
  req: Request,
  env: { AUTH_ENDPOINT?: string; DEV_USER_ID?: string }
): Promise<string | null> {
  if (env.DEV_USER_ID) return env.DEV_USER_ID;

  const headers: Record<string, string> = {};
  const cookie = req.headers.get('cookie');
  const authorization = req.headers.get('authorization');
  if (cookie) headers['cookie'] = cookie;
  if (authorization) headers['authorization'] = authorization;
  if (!cookie && !authorization) return null;

  const res = await fetch(`${authEndpoint(env)}/v1/whoami`, { headers });
  if (!res.ok) return null;
  const { user_id } = (await res.json()) as { user_id: string };
  return user_id;
}
