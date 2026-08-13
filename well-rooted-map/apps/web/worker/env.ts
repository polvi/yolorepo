export type Env = {
  COGS: R2Bucket;
  ASSETS: Fetcher;
  BASE_DOMAIN: string;
};

export type AppContext = { Bindings: Env };
