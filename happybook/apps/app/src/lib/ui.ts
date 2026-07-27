import { writable } from 'svelte/store';

/** Immersive reading mode: app chrome hidden, the document runs full-bleed. */
export const immersive = writable(false);
