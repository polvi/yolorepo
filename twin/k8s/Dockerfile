# twin-runner: the full splat toolchain baked into one image so benchmark
# runs measure the pipeline, never environment bootstrap. Built in-cluster by
# kaniko-build.yaml (same pattern as proc-infra's monero images), pushed to
# code.proc.io/polvi/twin-runner.
FROM docker.io/library/debian:bookworm AS builder

RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      cmake build-essential git wget unzip ca-certificates libopencv-dev \
    && rm -rf /var/lib/apt/lists/*

# libtorch CPU, pinned; OpenSplat links against it.
RUN wget -q -O /tmp/libtorch.zip \
      'https://download.pytorch.org/libtorch/cpu/libtorch-cxx11-abi-shared-with-deps-2.4.0%2Bcpu.zip' \
    && unzip -qq /tmp/libtorch.zip -d /opt \
    && rm /tmp/libtorch.zip

RUN git clone --depth 1 https://github.com/pierotofy/OpenSplat /src/OpenSplat \
    && cmake -S /src/OpenSplat -B /src/OpenSplat/build \
         -DCMAKE_BUILD_TYPE=Release -DCMAKE_PREFIX_PATH=/opt/libtorch \
    && cmake --build /src/OpenSplat/build -j"$(nproc)" \
    && /src/OpenSplat/build/opensplat --version || true

FROM docker.io/library/debian:bookworm

RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      colmap libopencv-dev curl unzip ca-certificates procps \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /opt/libtorch /opt/libtorch
COPY --from=builder /src/OpenSplat/build/opensplat /usr/local/bin/opensplat
ENV LD_LIBRARY_PATH=/opt/libtorch/lib

# bun + a preinstalled splat-transform binary, so the sog stage never pays
# first-run package downloads inside a timed run. BUN_INSTALL must persist:
# `bun add -g` reads it at run time to decide the global bin dir.
ENV BUN_INSTALL=/usr/local
RUN curl -fsSL https://bun.sh/install | bash \
    && bun add -g @playcanvas/splat-transform \
    && command -v splat-transform

# Sanity: every pipeline tool resolves at build time, not first use.
RUN colmap -h >/dev/null 2>&1; command -v colmap opensplat bun splat-transform

WORKDIR /work
CMD ["sleep", "infinity"]
