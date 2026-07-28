import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    include: ['test/**/*.test.ts'],
    poolOptions: {
      workers: {
        // SQLite-backed Durable Objects trip the isolated-storage stack pop
        // (known vitest-pool-workers issue: lingering .sqlite-shm files), so
        // storage is shared and every test uses a unique repo name instead.
        isolatedStorage: false,
        singleWorker: true,
        wrangler: { configPath: './test/wrangler.test.jsonc' },
      },
    },
  },
});
