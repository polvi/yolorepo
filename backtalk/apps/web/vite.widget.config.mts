import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// The embeddable widget is a second build target: a single self-contained
// IIFE served as /w.js from the same worker's assets. Runs AFTER the SPA
// build (emptyOutDir false) so both land in dist/.
export default defineConfig({
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: false,
    lib: {
      entry: resolve(__dirname, 'src/widget/index.ts'),
      formats: ['iife'],
      name: 'backtalkWidget',
      fileName: () => 'w.js',
    },
    minify: true,
  },
});
