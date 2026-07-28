import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Client bundles served from the reserved /__forkable__/ namespace on site
// origins: the injected widget, the editor panel page, and the fork-preview
// service worker. All ES modules (the SW is registered with type: 'module').
export default defineConfig({
  root: resolve(__dirname, 'src'),
  base: '/__forkable__/',
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    modulePreload: false,
    rollupOptions: {
      input: {
        widget: resolve(__dirname, 'src/widget/main.ts'),
        sw: resolve(__dirname, 'src/sw/main.ts'),
        panel: resolve(__dirname, 'src/panel/index.html'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
