//! `tlc-diff compare <cases-root>`: run the Rust checker over every case in
//! `cases.toml` and compare outcome/state counts/trace length against the
//! Java-TLC-mined expectations.

use std::borrow::Cow;
use std::path::{Path, PathBuf};

use tlc_core::api::Status;
use tlc_core::check::bfs::CheckBudget;
use tlc_core::ModuleResolver;

/// One expected result from the manifest.
#[derive(Debug, Clone)]
pub struct Case {
    pub path: String,
    pub outcome: String,
    pub states_generated: Option<u64>,
    pub distinct_states: Option<u64>,
    pub trace_len: Option<u32>,
}

/// Minimal parser for the fixed-shape `cases.toml` the miner writes (no
/// external toml dependency needed).
pub fn parse_manifest(text: &str) -> Vec<Case> {
    let mut cases = Vec::new();
    let mut cur: Option<Case> = None;
    for line in text.lines() {
        let line = line.trim();
        if line == "[[case]]" {
            if let Some(c) = cur.take() {
                cases.push(c);
            }
            cur = Some(Case {
                path: String::new(),
                outcome: String::new(),
                states_generated: None,
                distinct_states: None,
                trace_len: None,
            });
            continue;
        }
        let Some(c) = cur.as_mut() else { continue };
        let Some((key, val)) = line.split_once('=') else { continue };
        let key = key.trim();
        let val = val.trim().trim_matches('"');
        match key {
            "path" => c.path = val.to_string(),
            "outcome" => c.outcome = val.to_string(),
            "states_generated" => c.states_generated = val.parse().ok(),
            "distinct_states" => c.distinct_states = val.parse().ok(),
            "trace_len" => c.trace_len = val.parse().ok(),
            _ => {}
        }
    }
    if let Some(c) = cur.take() {
        cases.push(c);
    }
    cases
}

struct DirResolver {
    dir: PathBuf,
}

impl ModuleResolver for DirResolver {
    fn resolve(&self, name: &str) -> Option<Cow<'_, str>> {
        std::fs::read_to_string(self.dir.join(format!("{name}.tla"))).ok().map(Cow::Owned)
    }
}

pub struct CaseResult {
    pub verdict: Verdict,
    pub detail: String,
}

#[derive(PartialEq, Eq, Clone, Copy, Debug)]
pub enum Verdict {
    Exact,
    Unsupported,
    Mismatch,
}

/// Map a Rust checker status onto the oracle's outcome buckets. Java wraps
/// configuration-file exceptions in EC 1000 ("unexpected exception"), which
/// the miner classified as EvalError — so ConfigError compares equal to an
/// expected EvalError.
fn status_bucket(s: Status) -> &'static str {
    match s {
        Status::Ok => "Ok",
        Status::InvariantViolation => "InvariantViolation",
        Status::Deadlock => "Deadlock",
        Status::EvalError | Status::ConfigError => "EvalError",
        Status::ParseError => "ParseError",
        Status::SemanticError => "SemanticError",
        Status::UnsupportedFeature => "Unsupported",
        Status::Timeout => "Timeout",
        Status::ResourceLimit => "ResourceLimit",
        Status::NotImplemented => "NotImplemented",
    }
}

pub fn run_case(root: &Path, case: &Case, timeout_secs: u64) -> CaseResult {
    let tla = root.join(&case.path);
    let cfg = tla.with_extension("cfg");
    let (src, cfg_src) = match (
        std::fs::read_to_string(&tla),
        std::fs::read_to_string(&cfg),
    ) {
        (Ok(a), Ok(b)) => (a, b),
        _ => {
            return CaseResult {
                verdict: Verdict::Mismatch,
                detail: "cannot read case files".to_string(),
            }
        }
    };
    let name = tla.file_stem().unwrap().to_string_lossy().into_owned();
    let resolver = DirResolver { dir: tla.parent().unwrap().to_path_buf() };
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(timeout_secs);
    let exceeded = move || std::time::Instant::now() >= deadline;
    let budget = CheckBudget {
        deadline_exceeded: Some(&exceeded),
        memory_exceeded: None,
        max_states: None,
        eval_stack_bytes: Some(6 * 1024 * 1024),
    };
    let resp = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        tlc_core::check::run_check_with_resolver(&name, &src, &cfg_src, &resolver, None, &budget)
    }));
    let resp = match resp {
        Ok(r) => r,
        Err(_) => {
            return CaseResult {
                verdict: Verdict::Mismatch,
                detail: "PANIC in checker".to_string(),
            }
        }
    };

    let got = status_bucket(resp.status);
    if got == "Unsupported" {
        let why = resp
            .errors
            .first()
            .map(|e| e.message.clone())
            .unwrap_or_else(|| "unsupported feature".to_string());
        return CaseResult { verdict: Verdict::Unsupported, detail: why };
    }
    let mut problems = Vec::new();
    if got != case.outcome {
        problems.push(format!("outcome: expected {}, got {}", case.outcome, got));
    }
    let stats = resp.stats.as_ref();
    if let (Some(want), Some(st)) = (case.states_generated, stats) {
        if st.states_generated != want {
            problems.push(format!("gen: expected {}, got {}", want, st.states_generated));
        }
    }
    if let (Some(want), Some(st)) = (case.distinct_states, stats) {
        if st.distinct_states != want {
            problems.push(format!("distinct: expected {}, got {}", want, st.distinct_states));
        }
    }
    if let Some(want) = case.trace_len {
        let got_len = resp.violation.as_ref().map(|v| v.trace.len() as u32).unwrap_or(0);
        if got_len != want {
            problems.push(format!("trace: expected {}, got {}", want, got_len));
        }
    }
    if problems.is_empty() {
        CaseResult { verdict: Verdict::Exact, detail: String::new() }
    } else {
        let mut detail = problems.join("; ");
        if got == "EvalError" || got == "SemanticError" || got == "ParseError" {
            if let Some(e) = resp.errors.first() {
                detail.push_str(&format!(" [{}: {}]", e.code, e.message.replace('\n', " ")));
            }
        }
        CaseResult { verdict: Verdict::Mismatch, detail }
    }
}

pub fn compare(root: &Path, filter: Option<&str>, timeout_secs: u64) -> std::process::ExitCode {
    let manifest = root.join("cases.toml");
    let text = match std::fs::read_to_string(&manifest) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("error: cannot read {}: {e}", manifest.display());
            return std::process::ExitCode::FAILURE;
        }
    };
    let cases = parse_manifest(&text);
    let mut exact = 0usize;
    let mut unsupported = 0usize;
    let mut mismatch = 0usize;
    let total = cases.iter().filter(|c| filter.is_none_or(|f| c.path.contains(f))).count();
    for case in &cases {
        if let Some(f) = filter {
            if !case.path.contains(f) {
                continue;
            }
        }
        let r = run_case(root, case, timeout_secs);
        match r.verdict {
            Verdict::Exact => {
                exact += 1;
                println!("PASS  {}", case.path);
            }
            Verdict::Unsupported => {
                unsupported += 1;
                println!("UNSUP {}  ({})", case.path, r.detail);
            }
            Verdict::Mismatch => {
                mismatch += 1;
                println!("FAIL  {}  {}", case.path, r.detail);
            }
        }
    }
    println!(
        "\n{exact}/{total} exact, {unsupported} unsupported (documented), {mismatch} mismatched"
    );
    if mismatch == 0 {
        std::process::ExitCode::SUCCESS
    } else {
        std::process::ExitCode::FAILURE
    }
}
