import { createMiddleware } from 'hono/factory';
import type { AppContext } from './env';

export const requireUser = createMiddleware<AppContext>(async (c, next) => {
  if (c.env.DEV_USER_ID) {
    c.set('userId', c.env.DEV_USER_ID);
    await next();
    return;
  }

  const headers: Record<string, string> = {};
  const cookie = c.req.header('cookie');
  const authorization = c.req.header('authorization');
  if (cookie) headers['cookie'] = cookie;
  if (authorization) headers['authorization'] = authorization;
  if (!cookie && !authorization) return c.json({ error: 'unauthenticated' }, 401);

  const endpoint = c.env.AUTH_ENDPOINT ?? 'https://authgravity.proc.io';
  const res = await fetch(`${endpoint}/v1/whoami`, { headers });
  if (!res.ok) return c.json({ error: 'unauthenticated' }, 401);

  const { user_id } = (await res.json()) as { user_id: string };
  c.set('userId', user_id);
  await next();
});
