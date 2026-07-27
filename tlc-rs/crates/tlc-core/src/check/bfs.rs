//! The breadth-first model checker — the port of
//! `tlc2/tool/ModelChecker.doInit`/`doNext` with the exact Java check
//! ordering:
//!
//! - init: per generated state — completeness, constraints (gating the
//!   fingerprint set and queue), then invariants and implied-inits on states
//!   not already seen;
//! - next: per generated successor — completeness, constraints, dedup,
//!   invariants on unseen states, implied actions on *every* transition,
//!   enqueue;
//! - deadlock: a dequeued state with zero generated successors;
//! - traces: in-memory fingerprint parent chain, re-executed to recover the
//!   concrete states (fingerprints are not invertible).

use hashbrown::HashMap;
use std::collections::VecDeque;

use crate::diag::{Category, Diag};
use crate::eval::action::Pred;
use crate::eval::eval::Evaluator;
use crate::value::Value;

use super::spec::CompiledSpec;
use super::state::State;

/// Injected stop conditions (the wasm/CLI deadline, state cap, and memory
/// cap). The deadline and memory callbacks are polled about every 4096
/// generated states.
pub struct CheckBudget<'a> {
    pub deadline_exceeded: Option<&'a dyn Fn() -> bool>,
    /// Polled alongside the deadline; a `true` stops the run with
    /// `StopReason::Memory` before the host kills the whole instance. The
    /// wasm embedder watches linear-memory size against the Workers isolate
    /// limit.
    pub memory_exceeded: Option<&'a dyn Fn() -> bool>,
    pub max_states: Option<u64>,
    /// Override for the evaluator's native-stack budget. Embedders on a big
    /// main thread (the CLI) can raise it for deeply recursive specs; wasm
    /// keeps the conservative default.
    pub eval_stack_bytes: Option<usize>,
}

impl Default for CheckBudget<'_> {
    fn default() -> Self {
        CheckBudget {
            deadline_exceeded: None,
            memory_exceeded: None,
            max_states: None,
            eval_stack_bytes: None,
        }
    }
}

#[derive(Debug, Default)]
pub struct RunStats {
    pub states_generated: u64,
    pub distinct_states: u64,
    pub initial_states: u64,
    pub depth: u32,
    pub queue_depth: u64,
    /// Distinct states discovered per BFS level (level 1 = init states).
    pub level_growth: Vec<u64>,
}

pub enum Outcome {
    Ok,
    Violation { kind: ViolationKind, name: String, trace: Vec<State> },
    Deadlock { trace: Vec<State> },
    /// Budget exhausted (deadline, state cap, or memory cap).
    Stopped { reason: StopReason },
    /// A user-level evaluation error, with the trace to the state whose
    /// processing failed when one is known.
    Error { diag: Diag, trace: Vec<State> },
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ViolationKind {
    Invariant,
    /// A state-level PROPERTY violated by an initial state.
    ImpliedInit,
    /// A `[][A]_v` PROPERTY violated by a transition.
    ImpliedAction,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum StopReason {
    Timeout,
    MaxStates,
    Memory,
}

pub struct BfsResult {
    pub outcome: Outcome,
    pub stats: RunStats,
}

/// Internal signal used to abort init-state streaming; converted before
/// returning to the caller.
const STOP_CODE: &str = "E9999";

fn stop_diag() -> Diag {
    Diag::new(Category::Eval, STOP_CODE, "checking stopped")
}

pub fn run(ev: &Evaluator, spec: &CompiledSpec, budget: &CheckBudget) -> BfsResult {
    let mut chk = Checker {
        ev,
        spec,
        budget,
        fps: HashMap::new(),
        queue: VecDeque::new(),
        stats: RunStats::default(),
        outcome: None,
        budget_tick: 0,
    };
    chk.run();
    BfsResult { outcome: chk.outcome.unwrap_or(Outcome::Ok), stats: chk.stats }
}

struct Checker<'a, 'b> {
    ev: &'b Evaluator<'a>,
    spec: &'b CompiledSpec,
    budget: &'b CheckBudget<'b>,
    /// fp -> parent fp (an init state's parent is itself).
    fps: HashMap<u64, u64>,
    queue: VecDeque<(State, u64, u32)>,
    stats: RunStats,
    outcome: Option<Outcome>,
    budget_tick: u32,
}

impl Checker<'_, '_> {
    fn run(&mut self) {
        if let Err(stop) = self.do_init() {
            debug_assert_eq!(stop.code, STOP_CODE);
            return;
        }
        let Some(next) = &self.spec.next else {
            // No next-state relation: only initial states were checked.
            self.stats.queue_depth = self.queue.len() as u64;
            return;
        };
        while let Some((state, fp, level)) = self.queue.pop_front() {
            self.stats.depth = self.stats.depth.max(level);
            if self.check_budget().is_err() {
                break;
            }
            if self.do_next(next, &state, fp, level).is_err() {
                break;
            }
        }
        self.stats.queue_depth = self.queue.len() as u64;
    }

    /// Record the final outcome and signal the search to stop.
    fn stop(&mut self, outcome: Outcome) -> Result<(), Diag> {
        if self.outcome.is_none() {
            self.outcome = Some(outcome);
        }
        Err(stop_diag())
    }

    fn check_budget(&mut self) -> Result<(), Diag> {
        if let Some(max) = self.budget.max_states {
            if self.stats.states_generated >= max {
                return self.stop(Outcome::Stopped { reason: StopReason::MaxStates });
            }
        }
        if let Some(f) = self.budget.deadline_exceeded {
            if f() {
                return self.stop(Outcome::Stopped { reason: StopReason::Timeout });
            }
        }
        if let Some(f) = self.budget.memory_exceeded {
            if f() {
                return self.stop(Outcome::Stopped { reason: StopReason::Memory });
            }
        }
        Ok(())
    }

    /// Budget check amortized to roughly every 4096 generated states.
    fn tick_budget(&mut self) -> Result<(), Diag> {
        self.budget_tick += 1;
        if self.budget_tick >= 4096 {
            self.budget_tick = 0;
            self.check_budget()
        } else {
            Ok(())
        }
    }

    /// Is `state` within the model (CONSTRAINTs — `Tool.isInModel`)?
    fn is_in_model(&self, state: &State) -> Result<bool, Diag> {
        for p in &self.spec.constraints {
            if !self.eval_state_pred(p, state)? {
                return Ok(false);
            }
        }
        Ok(true)
    }

    /// `Tool.isInActions`: ACTION_CONSTRAINTs over the transition.
    fn is_in_actions(&self, s0: &State, s1: &State) -> Result<bool, Diag> {
        for p in &self.spec.action_constraints {
            if !self.eval_action_pred(p, s0, s1)? {
                return Ok(false);
            }
        }
        Ok(true)
    }

    /// Evaluate a state predicate against one (complete) state.
    fn eval_state_pred(&self, p: &Pred, state: &State) -> Result<bool, Diag> {
        let (r, _, _) = self.ev.with_states(state.clone(), State::null(), || {
            let v = self.ev.eval(p.module, p.expr, &p.ctx)?;
            self.ev.expect_bool(&v, &format!("the predicate {}", p.name))
        });
        r
    }

    /// Evaluate an action predicate against a transition (s0, s1).
    fn eval_action_pred(&self, p: &Pred, s0: &State, s1: &State) -> Result<bool, Diag> {
        let (r, _, _) = self.ev.with_states(s0.clone(), s1.clone(), || {
            let v = self.ev.eval(p.module, p.expr, &p.ctx)?;
            self.ev.expect_bool(&v, &format!("the action property {}", p.name))
        });
        r
    }

    // ---- init (ModelChecker.doInit + DoInitFunctor) ------------------------

    fn do_init(&mut self) -> Result<(), Diag> {
        // Split-borrow dance: the emit closure needs &mut self while `ev`
        // stays shared — stream states into per-call handling.
        let ev = self.ev;
        let init_preds = self.spec.init.clone();
        let this = &mut *self;
        let mut emit = |state: &State| -> Result<(), Diag> { this.on_init_state(state) };
        let r = ev.enumerate_init_states(&init_preds, &mut emit);
        match r {
            Ok(()) => Ok(()),
            Err(d) if d.code == STOP_CODE => Err(d),
            Err(d) => {
                // Evaluation failed while generating init states.
                self.stop(Outcome::Error { diag: d, trace: Vec::new() })
            }
        }
    }

    fn on_init_state(&mut self, state: &State) -> Result<(), Diag> {
        self.stats.initial_states += 1;
        self.stats.states_generated += 1;
        self.tick_budget()?;
        // isGoodState: every declared variable must have a value.
        if !state.all_assigned() {
            let missing = state.unassigned(self.ev.analysis, &self.ev.vctx).join(", ");
            let d = Diag::new(
                Category::Eval,
                "E1251",
                format!(
                    "The following variable{} not assigned by the initial predicate: {}.",
                    if missing.contains(',') { "s are" } else { " is" },
                    missing
                ),
            );
            return self.stop(Outcome::Error { diag: d, trace: vec![state.clone()] });
        }
        let in_model = match self.is_in_model(state) {
            Ok(b) => b,
            Err(d) => return self.stop(Outcome::Error { diag: d, trace: vec![state.clone()] }),
        };
        let mut seen = false;
        if in_model {
            let fp = match state.fingerprint(&self.ev.vctx) {
                Ok(fp) => fp,
                Err(d) => {
                    return self.stop(Outcome::Error { diag: d, trace: vec![state.clone()] })
                }
            };
            seen = self.fps.contains_key(&fp);
            if !seen {
                self.fps.insert(fp, fp);
                self.stats.distinct_states += 1;
                bump_level(&mut self.stats.level_growth, 1);
                self.queue.push_back((state.clone(), fp, 1));
            }
        }
        if !seen {
            let spec = self.spec;
            for inv in &spec.invariants {
                match self.eval_state_pred(inv, state) {
                    Ok(true) => {}
                    Ok(false) => {
                        return self.stop(Outcome::Violation {
                            kind: ViolationKind::Invariant,
                            name: inv.name.clone(),
                            trace: vec![state.clone()],
                        })
                    }
                    Err(d) => {
                        return self.stop(Outcome::Error { diag: d, trace: vec![state.clone()] })
                    }
                }
            }
            for p in &spec.implied_inits {
                match self.eval_state_pred(p, state) {
                    Ok(true) => {}
                    Ok(false) => {
                        return self.stop(Outcome::Violation {
                            kind: ViolationKind::ImpliedInit,
                            name: p.name.clone(),
                            trace: vec![state.clone()],
                        })
                    }
                    Err(d) => {
                        return self.stop(Outcome::Error { diag: d, trace: vec![state.clone()] })
                    }
                }
            }
        }
        Ok(())
    }

    // ---- next (ModelChecker.doNext) ----------------------------------------

    fn do_next(&mut self, next: &Pred, cur: &State, cur_fp: u64, level: u32) -> Result<(), Diag> {
        // Generate the complete successor list first (Java collects a
        // StateVec per action before processing it); a generation error
        // reports the trace to the current state without counting the
        // partial successors, exactly like doNextFailed.
        let spec = self.spec;
        let mut succs: Vec<State> = Vec::new();
        {
            let ev = self.ev;
            let mut emit = |s: &State| -> Result<(), Diag> {
                succs.push(s.clone());
                Ok(())
            };
            if let Err(d) = ev.enumerate_next_states(next, cur, &mut emit) {
                let trace = self.reconstruct_trace(cur_fp);
                return self.stop(Outcome::Error { diag: d, trace });
            }
        }
        // TLC 2.19 counts a successor when it is *processed* (verified
        // against the oracle: a violation found mid-list leaves the rest of
        // the list uncounted), unlike newer ModelChecker revisions that
        // count the whole StateVec upfront.
        let deadlocked = succs.is_empty();

        for succ in &succs {
            self.stats.states_generated += 1;
            self.tick_budget()?;
            if !succ.all_assigned() {
                let missing = succ.unassigned(self.ev.analysis, &self.ev.vctx).join(", ");
                let d = Diag::new(
                    Category::Eval,
                    "E1252",
                    format!(
                        "Successor state is not completely specified by action {} (variable{} \
                         {}).",
                        next.name,
                        if missing.contains(',') { "s" } else { "" },
                        missing
                    ),
                );
                let mut trace = self.reconstruct_trace(cur_fp);
                trace.push(succ.clone());
                return self.stop(Outcome::Error { diag: d, trace });
            }
            let in_model = match self.is_in_model(succ).and_then(|b| {
                Ok(b && self.is_in_actions(cur, succ)?)
            }) {
                Ok(b) => b,
                Err(d) => {
                    let mut trace = self.reconstruct_trace(cur_fp);
                    trace.push(succ.clone());
                    return self.stop(Outcome::Error { diag: d, trace });
                }
            };
            let mut unseen = true;
            let mut fp = 0u64;
            if in_model {
                fp = match succ.fingerprint(&self.ev.vctx) {
                    Ok(fp) => fp,
                    Err(d) => {
                        let mut trace = self.reconstruct_trace(cur_fp);
                        trace.push(succ.clone());
                        return self.stop(Outcome::Error { diag: d, trace });
                    }
                };
                unseen = !self.fps.contains_key(&fp);
                if unseen {
                    self.fps.insert(fp, cur_fp);
                    self.stats.distinct_states += 1;
                    bump_level(&mut self.stats.level_growth, level + 1);
                }
            }
            // Invariants on states not seen before (doNextCheckInvariants).
            if unseen {
                for inv in &spec.invariants {
                    match self.eval_state_pred(inv, succ) {
                        Ok(true) => {}
                        Ok(false) => {
                            let mut trace = self.reconstruct_trace(cur_fp);
                            trace.push(succ.clone());
                            return self.stop(Outcome::Violation {
                                kind: ViolationKind::Invariant,
                                name: inv.name.clone(),
                                trace,
                            });
                        }
                        Err(d) => {
                            let mut trace = self.reconstruct_trace(cur_fp);
                            trace.push(succ.clone());
                            return self.stop(Outcome::Error { diag: d, trace });
                        }
                    }
                }
            }
            // Implied actions on every transition, seen or not
            // (doNextCheckImplied).
            for p in &spec.implied_actions {
                match self.eval_action_pred(p, cur, succ) {
                    Ok(true) => {}
                    Ok(false) => {
                        let mut trace = self.reconstruct_trace(cur_fp);
                        trace.push(succ.clone());
                        return self.stop(Outcome::Violation {
                            kind: ViolationKind::ImpliedAction,
                            name: p.name.clone(),
                            trace,
                        });
                    }
                    Err(d) => {
                        let mut trace = self.reconstruct_trace(cur_fp);
                        trace.push(succ.clone());
                        return self.stop(Outcome::Error { diag: d, trace });
                    }
                }
            }
            if in_model && unseen {
                self.queue.push_back((succ.clone(), fp, level + 1));
            }
        }

        if deadlocked && self.spec.check_deadlock {
            let trace = self.reconstruct_trace(cur_fp);
            return self.stop(Outcome::Deadlock { trace });
        }
        Ok(())
    }

    // ---- trace reconstruction (TLCTrace by fingerprint replay) -------------

    /// Recover the concrete states along the parent-fingerprint chain ending
    /// at `fp` by re-executing the spec (BFS guarantees this is a shortest
    /// path). Falls back to an empty trace if replay fails (it cannot, unless
    /// evaluation is nondeterministic).
    fn reconstruct_trace(&self, fp: u64) -> Vec<State> {
        // Walk fp -> parent chain to the root.
        let mut chain = vec![fp];
        let mut cur = fp;
        while let Some(&parent) = self.fps.get(&cur) {
            if parent == cur {
                break;
            }
            chain.push(parent);
            cur = parent;
        }
        chain.reverse();
        self.replay_chain(&chain).unwrap_or_default()
    }

    fn replay_chain(&self, chain: &[u64]) -> Option<Vec<State>> {
        let ev = self.ev;
        let first_fp = *chain.first()?;
        // Find the init state with the first fingerprint.
        let mut found: Option<State> = None;
        {
            let mut emit = |s: &State| -> Result<(), Diag> {
                if found.is_none()
                    && s.all_assigned()
                    && s.fingerprint(&ev.vctx).ok() == Some(first_fp)
                {
                    found = Some(s.clone());
                    return Err(stop_diag());
                }
                Ok(())
            };
            let _ = ev.enumerate_init_states(&self.spec.init, &mut emit);
        }
        let mut states = vec![found?];
        for &want in &chain[1..] {
            let cur = states.last()?.clone();
            let next = self.spec.next.as_ref()?;
            let mut found: Option<State> = None;
            {
                let mut emit = |s: &State| -> Result<(), Diag> {
                    if found.is_none()
                        && s.all_assigned()
                        && s.fingerprint(&ev.vctx).ok() == Some(want)
                    {
                        found = Some(s.clone());
                        return Err(stop_diag());
                    }
                    Ok(())
                };
                let _ = ev.enumerate_next_states(next, &cur, &mut emit);
            }
            states.push(found?);
        }
        Some(states)
    }
}

fn bump_level(levels: &mut Vec<u64>, level: u32) {
    let idx = (level - 1) as usize;
    if levels.len() <= idx {
        levels.resize(idx + 1, 0);
    }
    levels[idx] += 1;
}

/// Render a value for humans (re-exported convenience for the API layer).
pub fn display_value(ev: &Evaluator, v: &Value) -> String {
    v.display(&ev.vctx)
}
