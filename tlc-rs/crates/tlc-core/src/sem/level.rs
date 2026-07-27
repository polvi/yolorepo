//! Level checking — the minimal-correct subset of SANY's `LevelNode.java`.
//!
//! Levels form the 4-point lattice 0=constant < 1=state < 2=action <
//! 3=temporal. Every expression gets a synthesized level, bottom-up:
//!
//! - literals, constants, builtins, bound variables: 0
//! - state variables: 1
//! - `e'`: max(level(e), 2), and an error if level(e) > 1 (priming an
//!   action- or temporal-level expression — this is what rejects `x''`)
//! - `[A]_v` / `<<A>>_v`: max(level(A), level(v), 2)
//! - `WF_v(A)` / `SF_v(A)`, `\EE`/`\AA`, prefix `[]`/`<>`: 3
//! - `~>` / `-+->`: 3
//! - `ENABLED A`: 1 and `UNCHANGED v`: max(level(v), 2) — SANY's levels for
//!   these (a deliberate refinement of plain max-of-children)
//! - everything else: max of children, including bound domains
//!
//! Per definition we compute `(base_level, param_used)`: `param_used[i]` is
//! false when the body never mentions param i, so `level(Op(args)) =
//! max(base, max over used i of level(arg_i))`. This over-approximates
//! SANY's per-parameter level *weights* (a param only ever used under a
//! prime would justify capping its argument) but is sound: it can only
//! report a level that is too high, never too low.
//!
//! RECURSIVE definitions are handled by iterating each module's computation
//! to a fixpoint (levels and used-flags only grow, all values are <= 3, so
//! convergence is fast; a pass cap guards the loop). Diagnostics are only
//! emitted on the final, stable pass.

use crate::diag::{Category, Diag, Diagnostics};
use crate::loc::Span;
use crate::syntax::ast::{ExceptPathElem, ExprArena, ExprId, ExprKind, SourceFile, Unit};
use hashbrown::HashMap;

use super::resolve::{BinderKind, DefId, DefKind, ModuleId, Ref, Tables};

/// 0=constant, 1=state, 2=action, 3=temporal.
pub type Level = u8;

/// Level summary of one definition.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct DefLevel {
    pub base: Level,
    /// `param_used[i]` == false → param i never occurs in the body, so the
    /// corresponding argument cannot influence an application's level.
    pub param_used: Vec<bool>,
}

/// Compute expression levels for one module and fill in the levels of its
/// definitions. Modules must be processed dependencies-first so imported
/// definitions already carry their levels.
pub(crate) fn check_module(
    m: ModuleId,
    sf: &SourceFile,
    refs: &[Option<Ref>],
    tables: &Tables,
    def_levels: &mut Vec<DefLevel>,
    diags: &mut Diagnostics,
) -> Vec<Level> {
    // Map each definition body back to its DefId so LET definitions found
    // during the expression walk can be attributed (body ExprIds are unique).
    let mut body_def: HashMap<u32, DefId> = HashMap::new();
    let mine: Vec<DefId> = (0..tables.defs.len() as u32)
        .map(DefId)
        .filter(|d| tables.defs[d.0 as usize].module == m)
        .collect();
    for &d in &mine {
        if let Some(b) = tables.defs[d.0 as usize].body {
            body_def.insert(b.0, d);
        }
    }

    const MAX_PASSES: usize = 8;
    for _ in 0..MAX_PASSES {
        let snapshot: Vec<DefLevel> =
            mine.iter().map(|d| def_levels[d.0 as usize].clone()).collect();
        let mut lv = Leveler {
            arena: &sf.arena,
            refs,
            t: tables,
            dl: def_levels,
            body_def: &body_def,
            levels: vec![0; sf.arena.exprs.len()],
            at_stack: Vec::new(),
            diags: None,
        };
        lv.run(&sf.module.units);
        let stable = mine
            .iter()
            .zip(&snapshot)
            .all(|(d, old)| def_levels[d.0 as usize] == *old);
        if stable {
            break;
        }
    }
    // Final pass at the fixpoint, with diagnostics enabled.
    let mut lv = Leveler {
        arena: &sf.arena,
        refs,
        t: tables,
        dl: def_levels,
        body_def: &body_def,
        levels: vec![0; sf.arena.exprs.len()],
        at_stack: Vec::new(),
        diags: Some(diags),
    };
    lv.run(&sf.module.units);
    lv.levels
}

struct Leveler<'a> {
    arena: &'a ExprArena,
    refs: &'a [Option<Ref>],
    t: &'a Tables,
    dl: &'a mut Vec<DefLevel>,
    body_def: &'a HashMap<u32, DefId>,
    levels: Vec<Level>,
    /// Level of the EXCEPT base for each enclosing update value (`@`).
    at_stack: Vec<Level>,
    /// `None` during fixpoint iteration passes (no duplicate diagnostics).
    diags: Option<&'a mut Diagnostics>,
}

impl<'a> Leveler<'a> {
    fn err(&mut self, code: &'static str, msg: String, span: Span) {
        if let Some(diags) = self.diags.as_deref_mut() {
            diags.push(Diag::new(Category::Level, code, msg).with_span(span));
        }
    }

    fn run(&mut self, units: &[Unit]) {
        for unit in units {
            match unit {
                Unit::OpDef { def, .. } => {
                    if let Some(&d) = self.body_def.get(&def.body.0) {
                        self.compute_def(d);
                    }
                }
                Unit::FnDef { def, .. } => {
                    if let Some(&d) = self.body_def.get(&def.body.0) {
                        self.compute_def(d);
                    }
                }
                Unit::Assume { expr, .. } => {
                    let l = self.walk(*expr);
                    if l != 0 {
                        let span = self.arena.get(*expr).span;
                        self.err(
                            "L0002",
                            format!(
                                "ASSUME expression must be constant-level, but has \
                                 {} level {}",
                                level_name(l),
                                l
                            ),
                            span,
                        );
                    }
                }
                Unit::Theorem { expr, .. } => {
                    // Any level is legal in a THEOREM.
                    self.walk(*expr);
                }
                _ => {}
            }
        }
    }

    fn compute_def(&mut self, d: DefId) {
        let info = &self.t.defs[d.0 as usize];
        let Some(body) = info.body else { return };
        let mut base = 0;
        if let DefKind::Fn { domains, .. } = &info.kind {
            for &dom in domains {
                base = base.max(self.walk(dom));
            }
        }
        base = base.max(self.walk(body));
        self.dl[d.0 as usize].base = base;
    }

    /// Level of an `Apply`-like use of definition `d` with arguments `args`.
    fn apply_level(&mut self, d: DefId, args: &[ExprId]) -> Level {
        // Read the def's summary up front (fixpoint iteration makes stale
        // reads of a recursive def's own summary sound).
        let base = self.dl[d.0 as usize].base;
        let used = self.dl[d.0 as usize].param_used.clone();
        let mut level = base;
        for (i, &a) in args.iter().enumerate() {
            let la = self.walk(a);
            // Unknown params (unfilled RECURSIVE placeholder): assume used.
            if used.get(i).copied().unwrap_or(true) {
                level = level.max(la);
            }
        }
        level
    }

    fn ref_level(&mut self, r: Ref) -> Level {
        match r {
            Ref::Def(d) => self.dl[d.0 as usize].base,
            Ref::Var(_) => 1,
            Ref::Const(_) | Ref::Builtin(_) => 0,
            Ref::Param { def, index } => {
                self.dl[def.0 as usize].param_used[index as usize] = true;
                0
            }
            Ref::Binder(b) => match self.t.binders[b.0 as usize].kind {
                // `@` stands for part of the EXCEPT base value.
                BinderKind::ExceptAt => self.at_stack.last().copied().unwrap_or(0),
                _ => 0,
            },
        }
    }

    fn walk_max(&mut self, items: &[ExprId]) -> Level {
        let mut l = 0;
        for &i in items {
            l = l.max(self.walk(i));
        }
        l
    }

    fn walk(&mut self, e: ExprId) -> Level {
        let expr = self.arena.get(e);
        let span = expr.span;
        let level = match &expr.kind {
            ExprKind::Num(_) | ExprKind::Str(_) => 0,

            ExprKind::Ident(_) => match self.refs[e.0 as usize] {
                Some(r) => self.ref_level(r),
                None => 0, // builtin op reference or unresolved (error already reported)
            },

            ExprKind::Paren(inner) => self.walk(*inner),

            ExprKind::Prefix(op, a) => {
                if let Some(Ref::Def(d)) = self.refs[e.0 as usize] {
                    self.apply_level(d, &[*a])
                } else {
                    match *op {
                        "[]" | "<>" => {
                            self.walk(*a);
                            3
                        }
                        // ENABLED A is a state predicate regardless of A.
                        "ENABLED" => {
                            self.walk(*a);
                            1
                        }
                        // UNCHANGED v == v' = v: action level.
                        "UNCHANGED" => self.walk(*a).max(2),
                        _ => self.walk(*a),
                    }
                }
            }
            ExprKind::Postfix(op, a) => {
                if let Some(Ref::Def(d)) = self.refs[e.0 as usize] {
                    self.apply_level(d, &[*a])
                } else if *op == "'" {
                    let la = self.walk(*a);
                    if la > 1 {
                        self.err(
                            "L0001",
                            format!(
                                "cannot prime an expression of {} level (priming is \
                                 only legal on constant- or state-level expressions)",
                                level_name(la)
                            ),
                            span,
                        );
                    }
                    la.max(2)
                } else {
                    self.walk(*a)
                }
            }
            ExprKind::Infix(op, l, r) => {
                if let Some(Ref::Def(d)) = self.refs[e.0 as usize] {
                    self.apply_level(d, &[*l, *r])
                } else {
                    match *op {
                        "~>" | "-+->" => {
                            self.walk(*l);
                            self.walk(*r);
                            3
                        }
                        _ => self.walk(*l).max(self.walk(*r)),
                    }
                }
            }
            ExprKind::Times(items) => self.walk_max(items),

            ExprKind::Apply(_, _, args) => match self.refs[e.0 as usize] {
                Some(Ref::Def(d)) => self.apply_level(d, args),
                Some(Ref::Param { def, index }) => {
                    self.dl[def.0 as usize].param_used[index as usize] = true;
                    self.walk_max(args)
                }
                Some(r) => self.ref_level(r).max(self.walk_max(args)),
                None => self.walk_max(args),
            },

            ExprKind::Junction(_, items) => self.walk_max(items),

            ExprKind::Quant { bounds, body, .. } => {
                let mut l = self.walk(*body);
                for b in bounds {
                    l = l.max(self.walk(b.domain));
                }
                l
            }
            ExprKind::UnboundedQuant { body, .. } => self.walk(*body),
            ExprKind::TemporalQuant { body, .. } => {
                self.walk(*body);
                3
            }

            ExprKind::Choose { domain, body, .. } => {
                let mut l = self.walk(*body);
                if let Some(d) = domain {
                    l = l.max(self.walk(*d));
                }
                l
            }

            ExprKind::SetEnum(items) => self.walk_max(items),
            ExprKind::SetFilter { bound, pred } => self.walk(bound.domain).max(self.walk(*pred)),
            ExprKind::SetMap { expr, bounds } => {
                let mut l = self.walk(*expr);
                for b in bounds {
                    l = l.max(self.walk(b.domain));
                }
                l
            }
            ExprKind::FnConstructor { bounds, body } => {
                let mut l = self.walk(*body);
                for b in bounds {
                    l = l.max(self.walk(b.domain));
                }
                l
            }

            ExprKind::FnApply { f, args } => self.walk(*f).max(self.walk_max(args)),
            ExprKind::FnSet { domain, range } => self.walk(*domain).max(self.walk(*range)),
            ExprKind::Record(fields) | ExprKind::RecordSet(fields) => {
                let mut l = 0;
                for (_, _, v) in fields {
                    l = l.max(self.walk(*v));
                }
                l
            }
            ExprKind::RecordField(base, _, _) => self.walk(*base),

            ExprKind::Except { base, updates } => {
                let lb = self.walk(*base);
                let mut l = lb;
                self.at_stack.push(lb);
                for u in updates {
                    for elem in &u.path {
                        if let ExceptPathElem::Index(idx) = elem {
                            l = l.max(self.walk_max(idx));
                        }
                    }
                    l = l.max(self.walk(u.value));
                }
                self.at_stack.pop();
                l
            }

            ExprKind::Tuple(items) => self.walk_max(items),

            ExprKind::If { cond, then, els } => {
                self.walk(*cond).max(self.walk(*then)).max(self.walk(*els))
            }
            ExprKind::Case(arms) => {
                let mut l = 0;
                for (guard, body) in arms {
                    if let Some(g) = guard {
                        l = l.max(self.walk(*g));
                    }
                    l = l.max(self.walk(*body));
                }
                l
            }

            ExprKind::Let { defs, body } => {
                // Compute the LET definitions' levels; the LET's own level is
                // its body's (definitions contribute through their uses).
                for u in defs {
                    let b = match u {
                        Unit::OpDef { def, .. } => Some(def.body),
                        Unit::FnDef { def, .. } => Some(def.body),
                        _ => None,
                    };
                    if let Some(b) = b {
                        if let Some(&d) = self.body_def.get(&b.0) {
                            self.compute_def(d);
                        }
                    }
                }
                self.walk(*body)
            }

            ExprKind::ActionSubscript { action, subscript, .. } => {
                self.walk(*action).max(self.walk(*subscript)).max(2)
            }
            ExprKind::Fairness { subscript, action, .. } => {
                self.walk(*subscript);
                self.walk(*action);
                3
            }

            ExprKind::Lambda { body, .. } => self.walk(*body),
            ExprKind::Label { body, .. } => self.walk(*body),
        };
        self.levels[e.0 as usize] = level;
        level
    }
}

fn level_name(l: Level) -> &'static str {
    match l {
        0 => "constant",
        1 => "state",
        2 => "action",
        _ => "temporal",
    }
}
