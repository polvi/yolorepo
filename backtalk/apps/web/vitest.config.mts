import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// Separate from vite.config.mts: the app build roots at src/, but tests live
// in test/ against the worker's pure modules.
export default defineConfig({
  test: {
    dir: resolve(__dirname, 'test'),
  },
});
