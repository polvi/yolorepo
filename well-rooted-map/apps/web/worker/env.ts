export type Env = {
  COGS: R2Bucket;
  DB: D1Database;
  ASSETS: Fetcher;
  BASE_DOMAIN: string;
  // Secret (wrangler secret put WIPE_PASS): passphrase for /api/veggie/wipe.
  WIPE_PASS?: string;
};

export type AppContext = { Bindings: Env };
