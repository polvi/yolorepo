# well-rooted-map

The farm map for [Well Rooted Produce](https://www.wellrootedproduce.co/)
(20377 Swalley Road, Bend, OR): a drone orthophoto of the farm (flown
2026-08-13, processed with ODM) served as a Cloud-Optimized GeoTIFF from R2
and displayed with MapLibre GL. There is no tile server: the browser reads
tiles straight out of the COG with HTTP range requests via
`@geomatico/maplibre-cog-protocol`, and the worker only Range-proxies the
bytes from R2 (plus serves the static viewer).

Initial deployment lives at well-rooted-map.proc.io. The eventual home is
map.wellrootedproduce.co: once that zone is on Cloudflare, add a second
route for it in `apps/web/wrangler.template.jsonc`. Nothing in the app
hardcodes the host (the viewer builds COG URLs from `location.origin`), so
the domain move is route-only.

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

## Publishing

```sh
bunx wrangler r2 object put well-rooted-map-cogs/cogs/<name>.tif \
  --file <name>.tif --content-type image/tiff --remote
cd apps/web && bun run deploy
```

Update `ORTHO_BOUNDS` and the COG filename in `apps/web/src/main.ts` when
swapping the imagery (bounds come from `gdalinfo -json`'s `wgs84Extent`).
