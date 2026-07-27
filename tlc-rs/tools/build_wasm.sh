#!/usr/bin/env bash
# Build tlc-wasm for the Worker: cargo → wasm-bindgen → (optional) wasm-opt.
# Output lands in engine/build/.
set -euo pipefail
cd "$(dirname "$0")/.."

cargo build -p tlc-wasm --profile wasm-release --target wasm32-unknown-unknown

command -v wasm-bindgen >/dev/null || {
  echo "wasm-bindgen-cli not found: cargo install wasm-bindgen-cli" >&2
  exit 1
}
mkdir -p engine/build
wasm-bindgen target/wasm32-unknown-unknown/wasm-release/tlc_wasm.wasm \
  --out-dir engine/build --target bundler

# wasm-opt -Oz strips __wbindgen_start, which the bundler-target JS glue
# calls at import time — keep it only with the start section preserved.
if command -v wasm-opt >/dev/null; then
  wasm-opt -Oz --pass-arg=legalize-js-interface-exported-helpers     engine/build/tlc_wasm_bg.wasm -o engine/build/tlc_wasm_bg.opt.wasm 2>/dev/null     && node -e "
      const fs=require('fs');
      const m=new WebAssembly.Module(fs.readFileSync('engine/build/tlc_wasm_bg.opt.wasm'));
      const ok=WebAssembly.Module.exports(m).some(e=>e.name==='__wbindgen_start');
      process.exit(ok?0:1);" 2>/dev/null     && mv engine/build/tlc_wasm_bg.opt.wasm engine/build/tlc_wasm_bg.wasm     || { echo "wasm-opt dropped __wbindgen_start; using unoptimized module"; rm -f engine/build/tlc_wasm_bg.opt.wasm; }
fi
ls -lh engine/build/tlc_wasm_bg.wasm
