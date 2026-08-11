export interface Env {
  DB: D1Database;
  BLOBS: R2Bucket;
  ASSETS: Fetcher;
  AUTH_ENDPOINT?: string;
  BASE_DOMAIN?: string;
  DEV_USER_ID?: string;
}

export type AppContext = {
  Bindings: Env;
  Variables: {
    userId: string;
  };
};

export function baseDomain(env: Env): string {
  return env.BASE_DOMAIN ?? 'proc.io';
}

export function authEndpoint(env: Pick<Env, 'AUTH_ENDPOINT'>): string {
  return env.AUTH_ENDPOINT ?? 'https://authgravity.proc.io';
}
