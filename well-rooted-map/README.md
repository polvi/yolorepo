# well-rooted-map

The farm map for [Well Rooted Produce](https://www.wellrootedproduce.co/)
(20377 Swalley Road, Bend, OR): a drone orthophoto of the farm (flown
2026-08-13, processed with ODM) served as a Cloud-Optimized GeoTIFF from R2
and displayed with MapLibre GL. There is no tile server: the browser reads
tiles straight out of the COG with HTTP range requests via
`@geomatico/maplibre-cog-protocol`, and the worker only Range-proxies the
bytes from R2 (plus serves the static viewer).

Initial deployment lives at well-rooted-map.proc.io. The eventual home is
map.wellrootedproduce.co, whose DNS stays with its current provider:
`map.wellrootedproduce.co CNAME well-rooted-map.proc.io`, terminated on
Cloudflare as a SaaS custom hostname on the proc.io zone (custom hostname +
zone fallback origin, set up via the API), with a `map.wellrootedproduce.co/*`
route sending it to this worker. Nothing in the app hardcodes the host (the
viewer builds COG URLs from `location.origin`), so no code changes.

## Layout

- `apps/web/` — single Cloudflare worker: Hono routes (`/cog/<name>.tif`
  Range proxy, `/llms.txt`) in front of the vite-built MapLibre SPA.

## Preparing a COG

The viewer requires web-mercator COGs with the GoogleMapsCompatible tiling
scheme (the COG protocol does not reproject):

```sh
gdal_translate -of COG \
  -co TILING_SCHEME=GoogleMapsCompatible \
  -co COMPRESS=JPEG -co QUALITY=90 \
  -co NUM_THREADS=ALL_CPUS \
  input-orthophoto.tif output.tif
```

JPEG keeps the file ~6x smaller than DEFLATE; the alpha collar of the
orthophoto survives as an internal TIFF mask, which the COG protocol
renders as transparency.

**Zoom floor (memory guard).** The ortho layer sets `minzoom:
ORTHO_MIN_ZOOM` (`apps/web/src/farmmap.ts`), which stops MapLibre
requesting COG tiles below it. This is load-bearing: the COG protocol asks
geotiff for a tile's footprint in image pixels, and geotiff allocates
`windowWidth * windowHeight * bands` before clamping to the image, so the
per-tile allocation quadruples per zoom step out (~3 MB at z13, 201 MB at
z10, 3.2 GB at z8) and a fast zoom-out crashed the tab. The threshold
depends on the smallest overview: ours is 172px wide (~z15 by resolution).
Re-check it when replacing the imagery.

## Regions (labels for the maze, corn, flowers, ...)

`apps/web/src/public/regions.geojson` holds one Polygon Feature per area
with semantic properties `{ id, name, kind }`; the kind → color palette
lives in `apps/web/src/regions.ts` so restyling never touches the data.
Zoomed out, regions render as a tinted patchwork with labeled names; both
fade out past z~17.5 so the imagery stands alone up close.

To edit: open the map with `?edit` (e.g. well-rooted-map.proc.io/?edit),
draw polygons over the orthophoto with Terra Draw (click corners, click
the last corner again or press Enter to finish; Select mode drags
corners), name each region and pick its kind, then **Download
regions.geojson** and commit it at the path above. Nothing persists
server-side; the committed file is the source of truth.

Labels need glyphs: `apps/web/src/public/font/Noto Sans Regular/` vendors
the 0-511 PBF ranges (from demotiles.maplibre.org) so the raster style can
render text without any external font server. ASCII names only need
0-255; add more ranges if names ever use other scripts.

## Publishing

```sh
bunx wrangler r2 object put well-rooted-map-cogs/cogs/<name>.tif \
  --file <name>.tif --content-type image/tiff --remote
cd apps/web && bun run deploy
```

Update `ORTHO_BOUNDS` and the COG filename in `apps/web/src/main.ts` when
swapping the imagery (bounds come from `gdalinfo -json`'s `wgs84Extent`).
