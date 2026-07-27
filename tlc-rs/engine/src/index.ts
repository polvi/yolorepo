// tlc-engine: the wasm checking engine as its own Worker, reached from the
// tlc web worker over a service binding. The split gives checking its own
// isolate with its own CPU budget, so a long synchronous BFS never stalls
// website requests that would otherwise share the checker's isolate.

// Workers' CompiledWasm rule imports a `WebAssembly.Module` (uninstantiated),
// so wire the wasm-bindgen glue manually: instantiate against the glue's
// import object, then hand the exports back via __wbg_set_wasm.
import { WorkerEntrypoint } from "cloudflare:workers";
import wasmModule from "../build/tlc_wasm_bg.wasm";
import * as bindgen from "../build/tlc_wasm_bg.js";

function instantiate(): WebAssembly.Instance {
  const inst = new WebAssembly.Instance(wasmModule, {
    "./tlc_wasm_bg.js": bindgen,
  });
  bindgen.__wbg_set_wasm(inst.exports);
  (inst.exports as { __wbindgen_start?: () => void }).__wbindgen_start?.();
  return inst;
}

let instance = instantiate();

// Wasm linear memory only grows, and the isolate (and its instance) is
// reused across requests, so one big check would otherwise pin the isolate
// near the 128 MiB kill threshold and fail every later request with
// "Invalid array buffer length". The engine self-limits at 64 MiB; reset
// well below that so a hot isolate always has full headroom.
const RESET_BYTES = 32 * 1024 * 1024;

function engineMemory(): WebAssembly.Memory {
  return instance.exports.memory as WebAssembly.Memory;
}

function resetEngine(): void {
  const old = engineMemory();
  instance = instantiate();
  // grow(0) detaches the old buffer, which is what invalidates the glue's
  // cached Uint8Array view; without it the glue would keep writing into the
  // abandoned instance's memory.
  old.grow(0);
}

// On a throw the instance may be poisoned (Rust abort leaves no way to
// recover) or the isolate arrived polluted from a previous request; reset
// and retry once on a fresh instance, and reset again before rethrowing so
// the next request starts clean either way. The rethrow crosses the service
// binding as a rejected promise, which the tlc worker maps to its
// resource_limit response.
function guarded(fn: (json: string) => string): (json: string) => string {
  return (json) => {
    try {
      return fn(json);
    } catch {
      resetEngine();
      try {
        return fn(json);
      } catch (err) {
        resetEngine();
        throw err;
      }
    } finally {
      if (engineMemory().buffer.byteLength > RESET_BYTES) resetEngine();
    }
  };
}

const parse = guarded((json) => bindgen.parse(json));
const check = guarded((json) => bindgen.check(json));

export default class TlcEngine extends WorkerEntrypoint {
  parse(json: string): string {
    return parse(json);
  }
  check(json: string): string {
    return check(json);
  }
  fetch(): Response {
    return new Response("tlc-engine is reachable via service binding only\n", {
      status: 404,
    });
  }
}
