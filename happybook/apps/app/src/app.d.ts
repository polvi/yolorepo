/// <reference types="vite-plugin-pwa/svelte" />

declare global {
  // Injected by Vite `define` in vite.config.ts: "<git sha> · <build time>".
  const __BUILD_VERSION__: string;

  namespace App {
    // interface Error {}
    // interface Locals {}
    // interface PageData {}
    // interface PageState {}
    // interface Platform {}
  }
}

export {};
