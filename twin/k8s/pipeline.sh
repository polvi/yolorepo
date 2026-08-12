#!/bin/bash
# COLMAP -> OpenSplat (CPU) -> SOG inside the runner pod. Mirrors
# twin/bin/build-splat.ts stage for stage and emits the same timings.json
# shape so laptop and server runs are directly comparable.
#
# env: ITERS (default 30000), MATCHER (exhaustive|sequential),
#      DOWNSCALE (default 2 — full-res training loads all photos into RAM
#      and is needlessly slow; ~2700px is standard splat resolution),
#      RESUME=1 (skip COLMAP stages when sparse/0 already exists)
set -euo pipefail

ITERS="${ITERS:-30000}"
MATCHER="${MATCHER:-exhaustive}"
DOWNSCALE="${DOWNSCALE:-2}"
SH_DEGREE="${SH_DEGREE:-3}"
DENSIFY_THRESH="${DENSIFY_THRESH:-0.0002}"
RESUME="${RESUME:-0}"
JOB=/work/job
IMAGES=$JOB/images
# Debian's COLMAP links Qt; without a display it aborts in
# QGuiApplication init unless told to render offscreen.
export QT_QPA_PLATFORM=offscreen

# Tools come baked into the twin-runner image; the /work/tools entries are
# the bootstrap.sh fallback for running on a stock debian image.
TOOLS=/work/tools
export PATH="$PATH:$TOOLS/OpenSplat/build:$TOOLS/bun/bin"
export LD_LIBRARY_PATH="${LD_LIBRARY_PATH:-}:$TOOLS/libtorch/lib"

mkdir -p "$JOB/colmap/sparse" "$JOB/dist"
declare -A T

stage() {
  local name=$1; shift
  echo; echo "[twin] $*"
  local t0=$SECONDS
  "$@"
  T[$name]=$((SECONDS - t0))
}

if [ "$RESUME" = 1 ] && [ -d "$JOB/colmap/sparse/0" ]; then
  echo '[twin] resuming: sparse model exists, skipping COLMAP stages'
else
  # use_gpu 0: GPU SIFT needs an OpenGL context, which a headless pod lacks —
  # and CPU SIFT across every core is the point of this runner anyway.
  stage extract colmap feature_extractor \
    --database_path "$JOB/colmap/db.db" --image_path "$IMAGES" \
    --ImageReader.single_camera 1 --ImageReader.camera_model SIMPLE_RADIAL \
    --SiftExtraction.use_gpu 0

  if [ "$MATCHER" = sequential ]; then
    stage match colmap sequential_matcher --database_path "$JOB/colmap/db.db" \
      --SequentialMatching.overlap 15 --SiftMatching.use_gpu 0
  else
    stage match colmap exhaustive_matcher --database_path "$JOB/colmap/db.db" \
      --SiftMatching.use_gpu 0
  fi

  stage map colmap mapper --database_path "$JOB/colmap/db.db" \
    --image_path "$IMAGES" --output_path "$JOB/colmap/sparse"
fi
[ -d "$JOB/colmap/sparse/0" ] || { echo '[twin] mapper produced no model'; exit 1; }

mkdir -p "$JOB/opensplat/project/sparse"
ln -sfn "$IMAGES" "$JOB/opensplat/project/images"
ln -sfn "$JOB/colmap/sparse/0" "$JOB/opensplat/project/sparse/0"
stage train opensplat "$JOB/opensplat/project" -n "$ITERS" -d "$DOWNSCALE" \
  --sh-degree "$SH_DEGREE" --densify-grad-thresh "$DENSIFY_THRESH" \
  -o "$JOB/opensplat/splat.ply"

if command -v splat-transform >/dev/null; then
  stage sog splat-transform "$JOB/opensplat/splat.ply" "$JOB/dist/scene.sog"
else
  stage sog bun x @playcanvas/splat-transform "$JOB/opensplat/splat.ply" "$JOB/dist/scene.sog"
fi

NIMG=$(find "$IMAGES" -maxdepth 1 -type f \( -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' \) | wc -l)
TOTAL=$((${T[extract]:-0} + ${T[match]:-0} + ${T[map]:-0} + ${T[train]:-0} + ${T[sog]:-0}))
cat > "$JOB/dist/timings.json" <<EOF
{
  "host": "$(hostname)",
  "runner": "k8s (opensplat CPU)",
  "ncpu": $(nproc),
  "images": $NIMG,
  "iters": $ITERS,
  "matcher": "$MATCHER",
  "mapper": "colmap",
  "downscale": $DOWNSCALE,
  "resumed": $([ "$RESUME" = 1 ] && echo true || echo false),
  "stages": {
    "extract": ${T[extract]:-0},
    "match": ${T[match]:-0},
    "map": ${T[map]:-0},
    "train": ${T[train]:-0},
    "sog": ${T[sog]:-0}
  },
  "total_s": $TOTAL
}
EOF
echo "[twin] done in ${TOTAL}s — dist/scene.sog + timings.json ready"
