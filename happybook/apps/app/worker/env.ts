export interface Env {
  ASSETS: Fetcher;
  DB?: D1Database;
  BLOBS?: R2Bucket;
  AUTH_ENDPOINT?: string;
  /** Set in .dev.vars only: bypasses AuthGravity locally, where its .proc.io cookie can never arrive. */
  DEV_USER_ID?: string;
}

export type AppContext = {
  Bindings: Env;
  Variables: { userId: string };
};
