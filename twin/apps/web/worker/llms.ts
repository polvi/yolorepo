export function llmsTxt(host: string): string {
  return `# twin

High-resolution digital twins of real places: drone photogrammetry rendered
as Gaussian splats in the browser. Scenes are published from a local
pipeline (COLMAP -> OpenSplat -> SOG) and served read-only from R2.

## Pages

- https://${host}/ - published scene list
- https://${host}/s/<slug> - interactive 3D viewer for one scene

## API (read-only, no auth)

- GET https://${host}/api/scenes - { scenes: [{ slug, title, created, size }] }
- GET https://${host}/api/scenes/<slug> - scene metadata (title, file, size, sha256, rotXDeg)
- GET https://${host}/api/scenes/<slug>/artifact - splat bytes; supports HTTP Range

Publishing requires the repo CLI (twin/bin/publish.ts) and Cloudflare
credentials; there is no write API on this host.
`;
}
