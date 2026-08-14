import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  root: resolve(__dirname, 'src'),
  resolve: {
    alias: {
      // The package's exports map serves a UMD build under the "browser"
      // condition; vite picks it and the named `cogProtocol` import becomes
      // undefined at runtime. Pin the real ESM build.
      '@geomatico/maplibre-cog-protocol': resolve(
        __dirname,
        'node_modules/@geomatico/maplibre-cog-protocol/dist/esm/index.js'
      ),
    },
  },
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'src/index.html'),
        leaderboard: resolve(__dirname, 'src/leaderboard.html'),
        tag: resolve(__dirname, 'src/tag.html'),
      },
    },
  },
});
