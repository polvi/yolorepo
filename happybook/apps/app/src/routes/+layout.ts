// Static SPA: no SSR, no prerendered per-notebook pages. The one fallback
// shell is precacheable, which is what makes the app work offline.
export const ssr = false;
export const prerender = false;
export const csr = true;
