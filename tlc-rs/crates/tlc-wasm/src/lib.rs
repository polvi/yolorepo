//! wasm-bindgen boundary: JSON string in, JSON string out. The TypeScript
//! Worker shell handles HTTP/auth and passes request bodies through.

use tlc_core::api::*;
use tlc_core::intern::Interner;
use tlc_core::MapResolver;
use wasm_bindgen::prelude::*;

fn resolve_main(req_modules: &[ModuleSource], main: &Option<String>) -> Result<usize, String> {
    match main {
        Some(name) => req_modules
            .iter()
            .position(|m| &m.name == name)
            .ok_or_else(|| format!("mainModule `{name}` not found among supplied modules")),
        None if req_modules.len() == 1 => Ok(0),
        None => Err("mainModule required when multiple modules are supplied".to_string()),
    }
}

#[wasm_bindgen]
pub fn parse(request_json: &str) -> String {
    let req: ParseRequest = match serde_json::from_str(request_json) {
        Ok(r) => r,
        Err(e) => return bad_request(format!("invalid request JSON: {e}")),
    };
    let main_idx = match resolve_main(&req.modules, &req.main_module) {
        Ok(i) => i,
        Err(m) => return bad_request(m),
    };
    let pairs: Vec<(String, String)> =
        req.modules.iter().map(|m| (m.name.clone(), m.source.clone())).collect();
    let resolver = MapResolver { modules: &pairs };
    let mut interner = Interner::new();
    let main = &req.modules[main_idx];
    let resp = match tlc_core::sem::analyze(&main.name, &main.source, &resolver, &mut interner) {
        Ok(_) => CheckResponse {
            status: Status::Ok,
            stats: None,
            violation: None,
            errors: Vec::new(),
            diagnostic: None,
            human_output: Some(format!("Semantic processing of module {} complete.", main.name)),
        },
        Err(diags) => CheckResponse {
            status: status_for_diags(&diags),
            stats: None,
            violation: None,
            errors: diags.iter().map(|d| ApiError::from_diag(d, &main.name)).collect(),
            diagnostic: None,
            human_output: None,
        },
    };
    serde_json::to_string(&resp).unwrap_or_else(|e| bad_request(e.to_string()))
}

#[wasm_bindgen]
pub fn check(request_json: &str) -> String {
    let req: CheckRequest = match serde_json::from_str(request_json) {
        Ok(r) => r,
        Err(e) => return bad_request(format!("invalid request JSON: {e}")),
    };
    // wasm32-unknown-unknown has no clock and we deliberately avoid js-sys;
    // the engine's budget is a state-count cap scaled from timeoutSeconds
    // (~150k generated states/second is a conservative single-threaded wasm
    // rate), while the Worker platform's cpu_ms limit is the hard wall-clock
    // guard.
    let timeout = u64::from(req.timeout_seconds.unwrap_or(30).clamp(1, 30));
    let budget = tlc_core::check::bfs::CheckBudget {
        deadline_exceeded: None,
        // Workers kills the whole isolate at 128 MiB and wasm linear memory
        // never shrinks, so stop gracefully once it reaches 64 MiB (1024
        // 64 KiB pages). Polled every ~4096 states, which leaves headroom
        // for allocation between polls and for collection-doubling spikes.
        memory_exceeded: Some(&memory_exceeded),
        max_states: Some(timeout.saturating_mul(150_000)),
        // Wasm stacks are small (~1 MiB by default); keep the evaluator's
        // conservative built-in byte budget rather than the native 6 MiB.
        eval_stack_bytes: None,
    };
    let resp = tlc_core::check::run_check(&req, &budget);
    serde_json::to_string(&resp).unwrap_or_else(|e| bad_request(e.to_string()))
}

#[cfg(target_arch = "wasm32")]
fn memory_exceeded() -> bool {
    const MEMORY_BUDGET_PAGES: usize = 1024; // 64 MiB of 64 KiB pages
    core::arch::wasm32::memory_size(0) > MEMORY_BUDGET_PAGES
}

#[cfg(not(target_arch = "wasm32"))]
fn memory_exceeded() -> bool {
    false
}

fn bad_request(message: String) -> String {
    serde_json::to_string(&CheckResponse {
        status: Status::ConfigError,
        stats: None,
        violation: None,
        errors: vec![ApiError {
            code: "R0001".into(),
            category: "request".into(),
            message,
            location: None,
        }],
        diagnostic: None,
        human_output: None,
    })
    .unwrap()
}
