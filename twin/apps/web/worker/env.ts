export type Env = {
  SCENES: R2Bucket;
  ASSETS: Fetcher;
  BASE_DOMAIN: string;
};

export type AppContext = { Bindings: Env };
