# molemap

Google Earth for the body. A local pipeline reconstructs a 3D map of your
skin from photos; this repo's web app is the viewer and record system:
stream the reconstruction, scrub a time slider across visits, zoom in, and
track individual moles as pins across time.

molemap measures change; it does not diagnose. Bring anything that changes
to a dermatologist.

## Layout

- `pipeline/` — local Rust CLI. Runs reconstruction on your machine and
  uploads only derived artifacts per visit: Gaussian splat (.sog/.ply),
  sparse point cloud PLY, preview.jpg, per-detection crops,
  detections.json, manifest.json.
- `apps/web/` — Cloudflare Worker (Hono + D1 + R2) serving the SPA viewer
  at molemap.\<base\>: streamed 3D body view, visit timeline, mole pins
  (manual and AI-proposed), per-mole passports, API tokens for the CLI.

## Capture protocol (summary)

- Orbit the subject at 2–3 heights with ~80% frame overlap.
- Hold breath during each orbit to keep the torso rigid.
- Diffuse, even light; avoid hard shadows and specular hotspots.

## Privacy

Raw photos never leave the machine that took them. The pipeline's
`workspace/` directory (photos, intermediates) is gitignored and local
only; the server ever sees only the derived artifacts listed above, stored
per-account and served only to that account.

## Install

- Web app: `bun install` here, `bun run configure` at the repo root (see
  FORKING.md), then `bun run dev` or `bun run deploy`.
- Pipeline CLI: see `pipeline/README.md`. Mint an API token in the web
  app under Settings; the CLI authenticates with `Authorization: Bearer mm_…`.
