export function llmsTxt(hostname: string): string {
  const origin = `https://${hostname}`;
  return `# molemap

Google Earth for the body: a 3D map of your skin over time. A local pipeline
CLI reconstructs each "visit" from photos on your own machine and uploads only
derived artifacts (Gaussian splat, sparse point cloud, preview, per-detection
crops, detections.json, manifest.json). This site is the viewer and record
system: streamed 3D body view, a time slider across visits, and mole pins
(manual + AI-proposed) tracked across visits.

molemap measures change; it does not diagnose. Anything that changes belongs
in front of a dermatologist.

## Privacy

Raw photos never leave the machine that took them. The server stores only the
derived artifacts above, per account, served only to that account.

## Auth

Accounts are passkeys via ${origin.replace(/^https:\/\/molemap\./, 'https://auth.')}
(AuthGravity, https://authgravity.org). Browser API routes under ${origin}/api
use the session cookie; the pipeline CLI uses \`Authorization: Bearer mm_...\`
tokens minted under Settings. There is no public read API.

## Pipeline API sketch

- POST /api/visits {id, captured_at, manifest} — idempotent by client UUID
- POST /api/visits/:id/artifacts {sha256, kind, size, label} -> {needed}
- PUT  /api/visits/:id/artifacts/:sha256 — raw bytes, server re-hashes
- POST /api/visits/:id/finalize — verifies uploads, runs mole matching
- GET  /api/artifacts/:sha256 — range-capable artifact reads

Built on Cloudflare Workers. An Infinite Logic PBC (https://infinitelogic.org)
playground project.
`;
}
