import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
export default {
  preprocess: vitePreprocess(),
  kit: {
    // Static SPA: one fallback shell, all routing client-side, so the
    // service worker can precache the entire app.
    adapter: adapter({ fallback: 'index.html' }),
  },
};
