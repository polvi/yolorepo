#!/bin/bash
# Idempotent toolchain bootstrap for the twin runner pod (debian:bookworm).
# Everything expensive lands in /work (the PVC), so pod restarts only redo
# the cheap apt layer. Safe to re-run; every step checks before doing.
set -euo pipefail

TOOLS=/work/tools
mkdir -p "$TOOLS"

if ! command -v colmap >/dev/null; then
  echo '[bootstrap] apt packages (colmap, opencv, build tools)…'
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
    colmap libopencv-dev cmake build-essential git wget unzip curl ca-certificates \
    >/dev/null
fi

if [ ! -d "$TOOLS/libtorch" ]; then
  echo '[bootstrap] libtorch (CPU)…'
  wget -q -O /tmp/libtorch.zip \
    'https://download.pytorch.org/libtorch/cpu/libtorch-cxx11-abi-shared-with-deps-2.4.0%2Bcpu.zip'
  unzip -qq /tmp/libtorch.zip -d "$TOOLS"
  rm /tmp/libtorch.zip
fi

if [ ! -x "$TOOLS/OpenSplat/build/opensplat" ]; then
  echo '[bootstrap] building OpenSplat (CPU)…'
  [ -d "$TOOLS/OpenSplat" ] || git clone -q --depth 1 https://github.com/pierotofy/OpenSplat "$TOOLS/OpenSplat"
  cmake -S "$TOOLS/OpenSplat" -B "$TOOLS/OpenSplat/build" \
    -DCMAKE_BUILD_TYPE=Release -DCMAKE_PREFIX_PATH="$TOOLS/libtorch" >/dev/null
  cmake --build "$TOOLS/OpenSplat/build" -j"$(nproc)" >/dev/null
fi

if [ ! -x "$TOOLS/bun/bin/bun" ]; then
  echo '[bootstrap] bun…'
  curl -fsSL https://bun.sh/install | BUN_INSTALL="$TOOLS/bun" bash >/dev/null 2>&1
fi

echo "[bootstrap] ready: colmap $(colmap -h 2>&1 | head -1 || true), opensplat + bun on PVC"
