//! The model checker (milestones M4–M6): state representation, spec wiring,
//! BFS search, and the [`run_check`] entry point that ties parsing, semantic
//! analysis, configuration, and checking into one `CheckRequest` →
//! `CheckResponse` call.

pub mod bfs;
pub mod spec;
pub mod state;

use crate::api::{
    ApiError, CheckRequest, CheckResponse, Diagnostic, Stats, Status, TraceState, Violation,
};
use crate::cfg::parse_cfg;
use crate::diag::{Category, Diag};
use crate::eval::Evaluator;
use crate::intern::Interner;
use crate::loc::FileId;
use crate::value::{fp::Fp64Table, ValueCtx};
use crate::ModuleResolver;

use bfs::{CheckBudget, Outcome, StopReason, ViolationKind};
use state::State;

/// Run a full model-checking request. `budget` supplies the embedder's
/// deadline callback and state cap (both optional).
pub fn run_check(req: &CheckRequest, budget: &CheckBudget) -> CheckResponse {
    let main_idx = match resolve_main(req) {
        Ok(i) => i,
        Err(msg) => return error_response(Status::ConfigError, "R0002", &msg),
    };
    let main = &req.modules[main_idx];
    let pairs: Vec<(String, String)> =
        req.modules.iter().map(|m| (m.name.clone(), m.source.clone())).collect();
    let resolver = crate::MapResolver { modules: &pairs };
    run_check_with_resolver(
        &main.name,
        &main.source,
        &req.config,
        &resolver,
        req.check_deadlock,
        budget,
    )
}

/// The checking pipeline against an arbitrary module resolver (the CLI and
/// the differential harness resolve sibling `.tla` files from disk).
pub fn run_check_with_resolver(
    main_name: &str,
    main_src: &str,
    config: &str,
    resolver: &dyn ModuleResolver,
    check_deadlock: Option<bool>,
    budget: &CheckBudget,
) -> CheckResponse {
    let main = MainRef { name: main_name };
    let mut interner = Interner::new();
    let analysis = match crate::sem::analyze(main.name, main_src, resolver, &mut interner) {
        Ok(a) => a,
        Err(diags) => {
            return CheckResponse {
                status: crate::api::status_for_diags(&diags),
                stats: None,
                violation: None,
                errors: diags.iter().map(|d| ApiError::from_diag(d, &main.name)).collect(),
                diagnostic: None,
                human_output: None,
            }
        }
    };

    // Config file (uses a large FileId so spans cannot collide with modules).
    let cfg = match parse_cfg(config, FileId(u32::MAX), &mut interner) {
        Ok(c) => c,
        Err(d) => return diag_response(&d, &main.name),
    };

    // Phase 1 constant binding (needs the interner mutable).
    let raw = match spec::bind_constants(&analysis, &cfg, &mut interner) {
        Ok(r) => r,
        Err(d) => return diag_response(&d, &main.name),
    };

    let fp_table = Fp64Table::new();
    let vctx = ValueCtx { interner: &interner, fp: &fp_table };
    let mut ev = Evaluator::new(&analysis, vctx);
    if let Some(bytes) = budget.eval_stack_bytes {
        ev.limits.max_stack_bytes = bytes;
    }
    if let Err(d) = spec::apply_bindings(&mut ev, &raw) {
        return diag_response(&d, &main.name);
    }
    // Lazy predicate sets ({x \in S : P}) evaluate their predicate through
    // this hook when the value layer needs membership or expansion.
    let ev = ev;
    let _lazy_guard = crate::value::install_lazy_eval(&ev);
    if let Err(d) = spec::check_assumptions(&ev) {
        return diag_response(&d, &main.name);
    }

    // A spec without variables: assumptions are the whole check (Java TLC
    // reports success with zero states).
    if analysis.vars.is_empty() {
        return CheckResponse {
            status: Status::Ok,
            stats: Some(Stats::default()),
            violation: None,
            errors: Vec::new(),
            diagnostic: None,
            human_output: Some(human_summary(&Stats::default(), "Model checking completed.")),
        };
    }

    let compiled = match spec::compile(&ev, &cfg) {
        Ok(c) => c,
        Err(d) => return diag_response(&d, &main.name),
    };
    if compiled.init.is_empty() {
        return error_response(
            Status::ConfigError,
            "C0025",
            "The configuration did not specify the initial state predicate.",
        );
    }
    if compiled.next.is_none() {
        return error_response(
            Status::ConfigError,
            "C0026",
            "The configuration did not specify the next-state relation.",
        );
    }
    let mut compiled = compiled;
    if let Some(cd) = check_deadlock {
        // The request-level flag only applies when the config file does not
        // set CHECK_DEADLOCK itself.
        if cfg.check_deadlock.is_none() {
            compiled.check_deadlock = cd;
        }
    }

    let result = bfs::run(&ev, &compiled, budget);
    render_result(&ev, result)
}

fn resolve_main(req: &CheckRequest) -> Result<usize, String> {
    match &req.main_module {
        Some(name) => req
            .modules
            .iter()
            .position(|m| &m.name == name)
            .ok_or_else(|| format!("mainModule `{name}` not found among supplied modules")),
        None if req.modules.len() == 1 => Ok(0),
        None => Err("mainModule required when multiple modules are supplied".to_string()),
    }
}

fn stats_of(r: &bfs::RunStats) -> Stats {
    Stats {
        states_generated: r.states_generated,
        distinct_states: r.distinct_states,
        initial_states: r.initial_states,
        depth: r.depth,
        queue_depth: r.queue_depth,
        elapsed_ms: 0,
    }
}

fn render_result(ev: &Evaluator, result: bfs::BfsResult) -> CheckResponse {
    let stats = stats_of(&result.stats);
    match result.outcome {
        Outcome::Ok => {
            let human = human_summary(&stats, "Model checking completed. No error has been found.");
            CheckResponse {
                status: Status::Ok,
                stats: Some(stats),
                violation: None,
                errors: Vec::new(),
                diagnostic: None,
                human_output: Some(human),
            }
        }
        Outcome::Violation { kind, name, trace } => {
            let (status, kind_str, msg) = match kind {
                ViolationKind::Invariant => (
                    Status::InvariantViolation,
                    "invariant",
                    format!("Invariant {name} is violated."),
                ),
                ViolationKind::ImpliedInit => (
                    Status::InvariantViolation,
                    "property",
                    format!("Property {name} is violated by the initial state."),
                ),
                ViolationKind::ImpliedAction => (
                    Status::InvariantViolation,
                    "action_property",
                    format!("Action property {name} is violated."),
                ),
            };
            let tr = render_trace(ev, &trace);
            let human = format!("{}\n{}{}", msg, render_trace_text(&tr), human_summary(&stats, ""));
            CheckResponse {
                status,
                stats: Some(stats),
                violation: Some(Violation { kind: kind_str.to_string(), name, trace: tr }),
                errors: Vec::new(),
                diagnostic: None,
                human_output: Some(human),
            }
        }
        Outcome::Deadlock { trace } => {
            let tr = render_trace(ev, &trace);
            let human = format!(
                "Deadlock reached.\n{}{}",
                render_trace_text(&tr),
                human_summary(&stats, "")
            );
            CheckResponse {
                status: Status::Deadlock,
                stats: Some(stats),
                violation: Some(Violation {
                    kind: "deadlock".to_string(),
                    name: "deadlock".to_string(),
                    trace: tr,
                }),
                errors: Vec::new(),
                diagnostic: None,
                human_output: Some(human),
            }
        }
        Outcome::Stopped { reason } => {
            let (status, why) = match reason {
                StopReason::Timeout => (Status::Timeout, "timeout"),
                StopReason::MaxStates => (Status::ResourceLimit, "state limit reached"),
                StopReason::Memory => (Status::ResourceLimit, "memory limit reached"),
            };
            let growth = &result.stats.level_growth;
            let growth_factor = growth_factor(growth);
            let hint = if growth_factor > 4.0 {
                format!(
                    "state count is growing ~{growth_factor:.0}x per level; reduce CONSTANT \
                     sizes, add a CONSTRAINT, or strengthen action guards"
                )
            } else {
                "the state space is large; reduce CONSTANT sizes or add a CONSTRAINT".to_string()
            };
            CheckResponse {
                status,
                stats: None,
                violation: None,
                errors: Vec::new(),
                diagnostic: Some(Diagnostic {
                    reason: why.to_string(),
                    states_generated: result.stats.states_generated,
                    distinct_states: result.stats.distinct_states,
                    depth_reached: result.stats.depth,
                    queue_depth: result.stats.queue_depth,
                    level_growth: growth.clone(),
                    growth_factor,
                    hint,
                }),
                human_output: None,
            }
        }
        Outcome::Error { diag, trace } => {
            let status = match diag.category {
                Category::Unsupported => Status::UnsupportedFeature,
                _ => Status::EvalError,
            };
            let tr = render_trace(ev, &trace);
            let human = format!("{}\n{}", diag.message, render_trace_text(&tr));
            CheckResponse {
                status,
                stats: Some(stats),
                violation: if tr.is_empty() {
                    None
                } else {
                    Some(Violation {
                        kind: "error".to_string(),
                        name: diag.code.to_string(),
                        trace: tr,
                    })
                },
                errors: vec![ApiError::from_diag(&diag, "")],
                diagnostic: None,
                human_output: Some(human),
            }
        }
    }
}

fn growth_factor(levels: &[u64]) -> f64 {
    // Geometric mean of the last few level-over-level ratios.
    let ratios: Vec<f64> = levels
        .windows(2)
        .rev()
        .take(3)
        .filter(|w| w[0] > 0)
        .map(|w| w[1] as f64 / w[0] as f64)
        .collect();
    if ratios.is_empty() {
        1.0
    } else {
        let product: f64 = ratios.iter().product();
        product.powf(1.0 / ratios.len() as f64)
    }
}

fn render_trace(ev: &Evaluator, trace: &[State]) -> Vec<TraceState> {
    trace
        .iter()
        .enumerate()
        .map(|(i, s)| {
            let mut vars = Vec::new();
            for (vi, slot) in s.vals.iter().enumerate() {
                let name = ev.vctx.interner.str(ev.analysis.vars[vi].name).to_string();
                let val = match slot {
                    Some(v) => v.display(&ev.vctx),
                    None => "?".to_string(),
                };
                vars.push((name, val));
            }
            TraceState {
                n: i as u32 + 1,
                action: if i == 0 { "Initial predicate".to_string() } else { String::new() },
                pretty: s.pretty(ev.analysis, &ev.vctx),
                state: vars,
            }
        })
        .collect()
}

fn render_trace_text(trace: &[TraceState]) -> String {
    let mut out = String::new();
    for t in trace {
        if t.action.is_empty() {
            out.push_str(&format!("State {}:\n{}\n", t.n, t.pretty.trim_end()));
        } else {
            out.push_str(&format!("State {}: <{}>\n{}\n", t.n, t.action, t.pretty.trim_end()));
        }
    }
    out
}

fn human_summary(stats: &Stats, headline: &str) -> String {
    let mut out = String::new();
    if !headline.is_empty() {
        out.push_str(headline);
        out.push('\n');
    }
    out.push_str(&format!(
        "{} states generated, {} distinct states found, {} states left on queue.\n",
        stats.states_generated, stats.distinct_states, stats.queue_depth
    ));
    out.push_str(&format!("The depth of the complete state graph search is {}.\n", stats.depth));
    out
}

fn diag_response(d: &Diag, module_name: &str) -> CheckResponse {
    let status = match d.category {
        Category::Unsupported => Status::UnsupportedFeature,
        Category::Config => Status::ConfigError,
        Category::Eval => Status::EvalError,
        Category::Syntax => Status::ParseError,
        _ => Status::SemanticError,
    };
    CheckResponse {
        status,
        stats: None,
        violation: None,
        errors: vec![ApiError::from_diag(d, module_name)],
        diagnostic: None,
        human_output: Some(d.message.clone()),
    }
}

fn error_response(status: Status, code: &'static str, message: &str) -> CheckResponse {
    CheckResponse {
        status,
        stats: None,
        violation: None,
        errors: vec![ApiError {
            code: code.to_string(),
            category: "config".to_string(),
            message: message.to_string(),
            location: None,
        }],
        diagnostic: None,
        human_output: Some(message.to_string()),
    }
}

struct MainRef<'a> {
    name: &'a str,
}
