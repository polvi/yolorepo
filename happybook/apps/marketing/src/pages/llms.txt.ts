// llms.txt as a build-time endpoint so the app and marketing URLs follow the
// configured base domain instead of hardcoding proc.io.
import type { APIRoute } from 'astro';
import { appUrl, siteUrl } from '../lib/stack';

const body = `# Happybook

> Happybook is a progressive web app for building notebooks out of PDFs and EPUBs. Add a document to start a notebook, add more documents to it, highlight passages, and create cross-links between locations in different documents. Everything works offline; signing in (passkeys) syncs notebooks across devices.

## What it does

- Notebooks: each notebook is a collection of PDFs and EPUBs plus your highlights and links.
- Highlights: select text in a PDF or EPUB and highlight it; highlights persist per notebook.
- Cross-links: select text or a spot in one document and link it to a page, passage, or point in another document in the same notebook. Links are navigable in both directions.
- Offline-first: the app and your documents live on your device; no account is required to use it.
- Sync: sign in with a passkey to back up notebooks and sync them across devices.
- OPDS catalog: every signed-in account can enable a password-protected OPDS 1.2 catalog at ${appUrl}/api/opds (HTTP Basic; username is ignored but must be non-empty, password is a generated three-word phrase, case/space-insensitive). Works with KOReader and any OPDS client. Setup guide: ${siteUrl}/docs/koreader

## URLs

- App: ${appUrl}
- Marketing: ${siteUrl}

## Technical notes

- Local storage: IndexedDB for structured data, OPFS for document bytes (PDF and EPUB).
- Sync: last-write-wins record sync over HTTPS; document blobs are content-addressed by SHA-256.
- Auth: WebAuthn passkeys via AuthGravity; no passwords.
`;

export const GET: APIRoute = () =>
  new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
