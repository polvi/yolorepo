#!/bin/bash
# COLMAP -> OpenSplat (CPU) -> SOG inside the runner pod. Mirrors
# twin/bin/build-splat.ts stage for stage and emits the same timings.json
# shape so laptop and server runs are directly comparable.
#
# env: ITERS (default 30000), MATCHER (exhaustive|sequential)
set -euo pipefail

ITERS="${ITERS:-30000}"
MATCHER="${MATCHER:-exhaustive}"
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
[ -d "$JOB/colmap/sparse/0" ] || { echo '[twin] mapper produced no model'; exit 1; }

mkdir -p "$JOB/opensplat/project/sparse"
ln -sfn "$IMAGES" "$JOB/opensplat/project/images"
ln -sfn "$JOB/colmap/sparse/0" "$JOB/opensplat/project/sparse/0"
stage train opensplat "$JOB/opensplat/project" -n "$ITERS" -o "$JOB/opensplat/splat.ply"

if command -v splat-transform >/dev/null; then
  stage sog splat-transform "$JOB/opensplat/splat.ply" "$JOB/dist/scene.sog"
else
  stage sog bun x @playcanvas/splat-transform "$JOB/opensplat/splat.ply" "$JOB/dist/scene.sog"
fi

NIMG=$(find "$IMAGES" -maxdepth 1 -type f \( -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' \) | wc -l)
TOTAL=$((T[extract] + T[match] + T[map] + T[train] + T[sog]))
cat > "$JOB/dist/timings.json" <<EOF
{
  "host": "$(hostname)",
  "runner": "k8s (opensplat CPU)",
  "ncpu": $(nproc),
  "images": $NIMG,
  "iters": $ITERS,
  "matcher": "$MATCHER",
  "mapper": "colmap",
  "stages": {
    "extract": ${T[extract]},
    "match": ${T[match]},
    "map": ${T[map]},
    "train": ${T[train]},
    "sog": ${T[sog]}
  },
  "total_s": $TOTAL
}
EOF
echo "[twin] done in ${TOTAL}s — dist/scene.sog + timings.json ready"
