// Ambient types for the wasm-bindgen build artifacts. Workers' CompiledWasm
// rule turns a .wasm import into an uninstantiated WebAssembly.Module.
declare module "*.wasm" {
  const wasmModule: WebAssembly.Module;
  export default wasmModule;
}

declare module "*/tlc_wasm_bg.js" {
  export function parse(requestJson: string): string;
  export function check(requestJson: string): string;
  export function __wbg_set_wasm(exports: unknown): void;
}
