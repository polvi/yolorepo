//! The service/CLI API schema — one serde type set shared by the native CLI
//! (`--json`), the wasm entry points, and the tlc-diff harness.

use crate::diag::Diag;
use serde::{Deserialize, Serialize};

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ModuleSource {
    pub name: String,
    pub source: String,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ParseRequest {
    pub modules: Vec<ModuleSource>,
    #[serde(default)]
    pub main_module: Option<String>,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CheckRequest {
    pub modules: Vec<ModuleSource>,
    #[serde(default)]
    pub main_module: Option<String>,
    /// Raw `.cfg` text.
    pub config: String,
    #[serde(default)]
    pub timeout_seconds: Option<u32>,
    #[serde(default)]
    pub check_deadlock: Option<bool>,
}

#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Ok,
    InvariantViolation,
    Deadlock,
    ParseError,
    SemanticError,
    ConfigError,
    EvalError,
    UnsupportedFeature,
    Timeout,
    ResourceLimit,
    NotImplemented,
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub states_generated: u64,
    pub distinct_states: u64,
    pub initial_states: u64,
    pub depth: u32,
    pub queue_depth: u64,
    pub elapsed_ms: u64,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TraceState {
    pub n: u32,
    pub action: String,
    /// Variable name → TLA+-rendered value.
    pub state: Vec<(String, String)>,
    pub pretty: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Violation {
    pub kind: String,
    pub name: String,
    pub trace: Vec<TraceState>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic {
    pub reason: String,
    pub states_generated: u64,
    pub distinct_states: u64,
    pub depth_reached: u32,
    pub queue_depth: u64,
    /// Distinct states discovered per BFS level — the state-blowup signal.
    pub level_growth: Vec<u64>,
    pub growth_factor: f64,
    pub hint: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ApiError {
    pub code: String,
    pub category: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<ApiLocation>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ApiLocation {
    pub module: String,
    pub line: u32,
    pub column: u32,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CheckResponse {
    pub status: Status,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stats: Option<Stats>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub violation: Option<Violation>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub errors: Vec<ApiError>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diagnostic: Option<Diagnostic>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub human_output: Option<String>,
}

impl ApiError {
    pub fn from_diag(d: &Diag, module_name: &str) -> ApiError {
        ApiError {
            code: d.code.to_string(),
            category: format!("{:?}", d.category).to_lowercase(),
            message: d.message.clone(),
            location: d.span.map(|s| ApiLocation {
                module: module_name.to_string(),
                line: s.start.line,
                column: s.start.col,
            }),
        }
    }
}

pub fn status_for_diags(diags: &[Diag]) -> Status {
    use crate::diag::Category;
    if diags.iter().any(|d| d.category == Category::Unsupported) {
        Status::UnsupportedFeature
    } else if diags.iter().any(|d| d.category == Category::Syntax) {
        Status::ParseError
    } else if diags.iter().any(|d| d.category == Category::Config) {
        Status::ConfigError
    } else {
        Status::SemanticError
    }
}
