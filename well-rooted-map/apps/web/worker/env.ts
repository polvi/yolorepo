export type Env = {
  COGS: R2Bucket;
  DB: D1Database;
  ASSETS: Fetcher;
  BASE_DOMAIN: string;
};

export type AppContext = { Bindings: Env };
