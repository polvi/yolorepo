export function llmsTxt(host: string): string {
  return `# Well Rooted Produce — Farm Map

Drone orthophoto of the Well Rooted Produce farm (20377 Swalley Road,
Bend, OR — https://www.wellrootedproduce.co/) served as a Cloud-Optimized
GeoTIFF and displayed with MapLibre GL. The browser reads the COG directly
via HTTP range requests; there is no tile server. This host is the initial
deployment; the map's eventual home is map.wellrootedproduce.co.

## Pages

- https://${host}/ - the map (pan/zoom, current-location control)

## API (no auth)

- GET https://${host}/cog/<name>.tif - COG bytes; supports HTTP Range
- Veggie-tagging game under /api/veggie/* (menu, claim, leaderboard.json,
  points.geojson) - see the repo's VEGGIE-GAME.md; scores at /leaderboard

Publishing is CLI-only (wrangler r2 object put); there is no write API on
this host.
`;
}
