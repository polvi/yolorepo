import { execSync } from 'node:child_process';
import { sveltekit } from '@sveltejs/kit/vite';
import { SvelteKitPWA } from '@vite-pwa/sveltekit';
import { defineConfig } from 'vite';

const gitSha = (() => {
  try {
    return execSync('git rev-parse --short HEAD').toString().trim();
  } catch {
    return 'dev';
  }
})();
const builtAt = new Date().toISOString().slice(0, 16).replace('T', ' ');

export default defineConfig({
  define: {
    __BUILD_VERSION__: JSON.stringify(`${gitSha} · ${builtAt}`),
  },
  plugins: [
    sveltekit(),
    SvelteKitPWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      kit: { adapterFallback: 'index.html' },
      manifest: {
        name: 'Happybook',
        short_name: 'Happybook',
        description: 'Notebooks made of PDFs: highlight, cross-link, offline-first.',
        display: 'standalone',
        start_url: '/',
        theme_color: '#c2542e',
        background_color: '#faf7f2',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // The pdf.js worker chunk is >1MB and must be precached or offline
        // PDF rendering dies.
        maximumFileSizeToCacheInBytes: 8_000_000,
        globPatterns: ['**/*.{js,mjs,css,html,svg,png,woff2}'],
        // adapter-static writes the fallback shell after the SW manifest is
        // globbed, so precache it explicitly; the revision busts per build.
        additionalManifestEntries: [{ url: '/', revision: String(Date.now()) }],
        // The sync client owns its own retry semantics; a caching service
        // worker in front of /api causes phantom-success bugs.
        navigateFallback: '/',
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [],
      },
    }),
  ],
});
