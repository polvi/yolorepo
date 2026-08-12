# twin

High-res digital twins of real places: drone photogrammetry rendered as
Gaussian splats in the browser, shared as a link. Live at twin.proc.io
(or `twin.<baseDomain>` on a fork).

The web side is deliberately tiny: a read-only Hono worker that Range-proxies
splat bytes out of R2 plus a three.js/[Spark](https://sparkjs.dev) viewer SPA.
All heavy lifting (reconstruction, training, compression) happens locally;
publishing is a CLI that writes three R2 objects in a checked order.

## Capture (what the scenes are made of)

Flown with a drone in two passes: an automated oblique mapping mission over
the whole parcel (nadir + four tilted grids, 80/75 overlap, ~40m AGL) and a
manual orbit pass around the structure with 2s interval shooting. Fixed
manual exposure, JPEG. 300–600 photos per scene is the sweet spot.

## Local pipeline

Prereqs (Apple Silicon):

- `brew install colmap` (and optionally [glomap](https://github.com/colmap/glomap), a much faster mapper)
- [OpenSplat](https://github.com/pierotofy/OpenSplat) built with `GPU_RUNTIME=MPS` (Metal)
- bun

Then:

```sh
bun twin/bin/build-splat.ts --images ~/flights/house-2026-08   # -> twin-work/dist/scene.sog
bun twin/bin/publish.ts house twin-work/dist/scene.sog --title "The House"
# -> https://twin.proc.io/s/house
```

`build-splat` runs COLMAP feature extraction/matching/mapping (glomap when
installed, with COLMAP's incremental mapper as default), trains a splat with
OpenSplat, and compresses it to `.sog` with `@playcanvas/splat-transform`.
Use `--matcher sequential` past ~400 photos. `publish` uploads via wrangler:
artifact, then `meta.json`, then `index.json` — that order is what makes
every listed scene fully readable, and it is model-checked in
[`specs/TwinPublish.tla`](specs/TwinPublish.tla). `--unlisted` publishes a
scene reachable only by its URL.

## Remote pipeline (k8s) + benchmark

One command runs both sides — the local Metal pipeline and the full server
round-trip (upload, CPU run on the proc-dev node's 96 cores, download) — and
prints a per-stage laptop-vs-server table:

```sh
bun twin/bin/bench.ts --images ~/flights/house-2026-08
```

Parallel by default (the remote side barely touches the laptop); pass
`--serial` to take laptop numbers on an idle machine. Each side logs to
`<work>/local.log` and `<work>/remote.log`. The server side alone is:

```sh
bun twin/bin/remote-splat.ts --images ~/flights/house-2026-08
```

This applies `k8s/` (namespace `twin`, a 200Gi zfs PVC, and a runner pod on
the custom `code.proc.io/polvi/twin-runner` image with the whole toolchain
baked in: colmap, libtorch CPU, OpenSplat CPU, bun, splat-transform), uploads
the photos, runs `k8s/pipeline.sh` (stage-for-stage identical to
`bin/build-splat.ts`), and downloads `scene.remote.sog` plus
`timings.remote.json`. Environment setup never lands in the timings: the
image is prebuilt, and on a stock-debian pod `bootstrap.sh` would run once
onto the PVC and is reported separately, outside the totals.

The image is built in-cluster with kaniko (monero-style, see proc-infra),
once per toolchain change:

```sh
kubectl apply -f twin/k8s/ns.yaml
# copy registry creds from the monero namespace (push for kaniko, pull for the pod)
for s in kaniko-push regcred; do
  kubectl -n monero get secret $s -o yaml | sed 's/namespace: monero/namespace: twin/' | kubectl apply -f -
done
kubectl -n twin create configmap twin-runner-dockerfile --from-file=Dockerfile=twin/k8s/Dockerfile
kubectl apply -f twin/k8s/kaniko-build.yaml   # pushes :cpu-v1 and :latest
```

Photos travel over the dedicated uploader (`bin/upload.ts` -> in-pod
`bin/upload-server.ts`), not kubectl: parallel HTTPS PUTs through the caddy
ingress at `twin-upload.<baseDomain>` (DNS: A record to the caddy
LoadBalancer, like odm), bearer-token auth, wyhash content addressing with a
server-side manifest — interrupted or repeated uploads resume and only send
what changed. The apiserver exec stream (tar over kubectl) topped out around
2 MB/s; kubectl now carries control traffic only.

Both runners emit the same `timings.json` shape, and `remote-splat` prints a
per-stage laptop-vs-server table at the end (upload/download counted on the
server side; that transfer is part of the real cost of offloading). Run
`build-splat` and `remote-splat` on the same photo set with the same
`--iters`/`--matcher` for a fair comparison. Note the asymmetry: the laptop
trains on Metal, the server trains on CPU — the node's A6000 is not exposed
to k8s yet (no nvidia device plugin on Talos), so expect the server to win
COLMAP stages on cores and lose training until that lands.

If a scene comes out upside down (splats inherit COLMAP's y-down frame; the
viewer rotates 180° about X by default), republish with `--rot-x 0`.

## Web app

```
apps/web/
  worker/   Hono: GET /api/scenes, /api/scenes/:slug, /api/scenes/:slug/artifact (Range), /llms.txt
  src/      SPA: / (scene list), /s/<slug> (fullscreen Spark viewer)
```

Dev loop from `apps/web/`: `bun install`, `bun run dev`, `bun run test`,
`bun run deploy`. `wrangler.jsonc` is generated — edit
`wrangler.template.jsonc` and run `bun run configure` at the repo root.
The bucket is created once with `bun x wrangler r2 bucket create twin-scenes`.

No auth anywhere: reads are public by design (scenes are meant to be shared),
and writes only happen through wrangler with the operator's Cloudflare
credentials.
