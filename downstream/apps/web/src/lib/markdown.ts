// Markdown rendering for user-authored post/comment bodies. Raw HTML is
// escaped (never passed through), and link/image URLs are restricted to safe
// protocols, so bodies cannot inject markup or script into the page.

import { marked } from "marked";

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const SAFE_LINK = /^(https?:|mailto:|#|\/)/i;
const SAFE_IMAGE = /^https?:/i;

marked.use({
  gfm: true,
  renderer: {
    // Escape raw HTML (block and inline) instead of emitting it.
    html(token: any) {
      return escapeHtml(token.text ?? token.raw ?? "");
    },
    link(token: any) {
      const href = (token.href ?? "").trim();
      const text = this.parser.parseInline(token.tokens);
      if (!SAFE_LINK.test(href)) return text;
      const title = token.title ? ` title="${escapeHtml(token.title)}"` : "";
      return `<a href="${escapeHtml(href)}"${title} rel="nofollow noopener">${text}</a>`;
    },
    image(token: any) {
      const href = (token.href ?? "").trim();
      if (!SAFE_IMAGE.test(href)) return escapeHtml(token.text ?? "");
      return `<img src="${escapeHtml(href)}" alt="${escapeHtml(token.text ?? "")}" loading="lazy" />`;
    },
  },
});

export function renderMarkdown(src: string): string {
  return marked.parse(src ?? "", { async: false }) as string;
}
