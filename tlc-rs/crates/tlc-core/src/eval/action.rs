//! Init/next-state structural enumeration — the port of
//! `Tool.getInitStates`/`getInitStatesAppl`, `Tool.getNextStates`/
//! `getNextStatesAppl`, and `Tool.processUnchanged`
//! (`tlc2/tool/impl/Tool.java`).
//!
//! An init or next-state formula is traversed *structurally*: `x = e` binds
//! an unassigned variable, `x \in S` enumerates, conjuncts become a
//! continuation list ([`Acts`], the `ActionItemList` analog), disjuncts
//! branch, `UNCHANGED` copies from the current state, and everything else is
//! evaluated as a boolean guard. Variable bindings use strict
//! bind–recurse–unbind discipline through [`Evaluator::with_bind_s0`] /
//! `with_bind_s1` so backtracking can never leak a binding.
//!
//! The partial state under construction lives in the evaluator's ambient
//! [`StateEnv`](super::eval::StateEnv): `s0` during init enumeration, `s1`
//! during next-state enumeration (with `s0` the complete predecessor), so
//! ordinary expression evaluation inside guards reads exactly the states
//! Java's `eval(pred, c, s0, s1, ...)` would.

use std::rc::Rc;

use crate::check::state::State;
use crate::diag::Diag;
use crate::sem::{DefKind, ModuleId, Ref, VarId};
use crate::syntax::ast::{ExprId, ExprKind, JunctionKind, QuantKind, SubscriptKind};
use crate::value::Value;

use super::context::{Binding, Ctx, CtxKey, LazyExpr, OpBinding};
use super::eval::{eval_err, Evaluator, Override};

/// A named predicate with the context it was compiled in — the analog of a
/// TLC `Action` (init conjunct, the next-state relation, an invariant, ...).
#[derive(Clone)]
pub struct Pred {
    pub name: String,
    pub module: ModuleId,
    pub expr: ExprId,
    pub ctx: Ctx,
}

/// Continuation-item kinds (`tlc2/tool/IActionItemList`).
#[derive(Clone, Copy, PartialEq, Eq)]
enum ActKind {
    /// An ordinary conjunct still to be established.
    Pred,
    /// `UNCHANGED e` still to be processed.
    Unchanged,
    /// The subscript of `<<A>>_e`: must have changed.
    Changed,
}

/// Persistent continuation list (`ActionItemList`): conjuncts still to be
/// processed, shared across disjunction branches.
#[derive(Clone)]
struct Acts(Option<Rc<Frame>>);

struct Frame {
    kind: ActKind,
    m: ModuleId,
    e: ExprId,
    ctx: Ctx,
    next: Acts,
}

impl Acts {
    fn empty() -> Acts {
        Acts(None)
    }

    fn cons(&self, kind: ActKind, m: ModuleId, e: ExprId, ctx: Ctx) -> Acts {
        Acts(Some(Rc::new(Frame { kind, m, e, ctx, next: self.clone() })))
    }
}

/// Streaming receiver for generated states (the `IStateFunctor` analog). The
/// callback may return an error to abort enumeration (used by the checker to
/// stop on a violation).
pub type Emit<'e> = &'e mut dyn FnMut(&State) -> Result<(), Diag>;

impl<'a> Evaluator<'a> {
    // ---- public entry points ----------------------------------------------

    /// Enumerate the states satisfying the conjunction of `preds`
    /// (`Tool.getInitStates(IStateFunctor)`): each generated state is passed
    /// to `emit` as it is found, in Java's generation order.
    pub fn enumerate_init_states(&self, preds: &[Pred], emit: Emit) -> Result<(), Diag> {
        if preds.is_empty() {
            return Ok(());
        }
        let nvars = self.analysis.vars.len();
        let (r, _, _) = self.with_states(State::empty(nvars), State::null(), || {
            let mut acts = Acts::empty();
            for p in preds[1..].iter().rev() {
                acts = acts.cons(ActKind::Pred, p.module, p.expr, p.ctx.clone());
            }
            let mut emit = emit;
            self.init_states(preds[0].module, preds[0].expr, &acts, &preds[0].ctx, &mut emit)
        });
        r
    }

    /// Enumerate the successors of `s0` under the action `next`
    /// (`Tool.getNextStates`), streaming each generated successor (possibly
    /// incomplete — the checker performs the `isGoodState` check).
    pub fn enumerate_next_states(&self, next: &Pred, s0: &State, emit: Emit) -> Result<(), Diag> {
        let nvars = self.analysis.vars.len();
        let (r, _, _) = self.with_states(s0.clone(), State::empty(nvars), || {
            let mut emit = emit;
            self.next_states(next.module, next.expr, &Acts::empty(), &next.ctx, &mut emit)
        });
        r
    }

    // ---- shared plumbing ---------------------------------------------------

    /// Bind `s0[v]` (init enumeration) around `f`, unbinding on every exit
    /// path.
    fn with_bind_s0<R>(
        &self,
        v: VarId,
        val: Value,
        f: impl FnOnce() -> Result<R, Diag>,
    ) -> Result<R, Diag> {
        self.senv.borrow_mut().s0.bind(v, val);
        let r = f();
        self.senv.borrow_mut().s0.unbind(v);
        r
    }

    /// Bind `s1[v]` (next-state enumeration) around `f`.
    fn with_bind_s1<R>(
        &self,
        v: VarId,
        val: Value,
        f: impl FnOnce() -> Result<R, Diag>,
    ) -> Result<R, Diag> {
        self.senv.borrow_mut().s1.bind(v, val);
        let r = f();
        self.senv.borrow_mut().s1.unbind(v);
        r
    }

    /// `Tool.getVar`: does `e` (in context `c`) denote a state variable?
    /// Sees through parentheses, labels, and formal parameters bound to
    /// lazily-captured argument expressions.
    fn state_var(&self, m: ModuleId, e: ExprId, c: &Ctx) -> Option<VarId> {
        match &self.arena(m).get(e).kind {
            ExprKind::Paren(inner) => self.state_var(m, *inner, c),
            ExprKind::Label { body, .. } => self.state_var(m, *body, c),
            ExprKind::Ident(_) => match self.analysis.expr_ref(m, e)? {
                Ref::Var(v) => Some(v),
                Ref::Param { def, index } => match c.lookup(CtxKey::Param { def, index })? {
                    Binding::LazyExpr(lx) => self.state_var(lx.module, lx.expr, &lx.ctx),
                    _ => None,
                },
                _ => None,
            },
            _ => None,
        }
    }

    /// `Tool.getPrimedVar`: does `e` denote `x'` for a state variable `x`?
    /// Sees through formal parameters lazily bound to a primed expression
    /// (`Op(s')` with `var = val` inside `Op`).
    fn primed_var(&self, m: ModuleId, e: ExprId, c: &Ctx) -> Option<VarId> {
        match &self.arena(m).get(e).kind {
            ExprKind::Paren(inner) => self.primed_var(m, *inner, c),
            ExprKind::Label { body, .. } => self.primed_var(m, *body, c),
            ExprKind::Postfix("'", inner) => self.state_var(m, *inner, c),
            ExprKind::Ident(_) => match self.analysis.expr_ref(m, e)? {
                Ref::Param { def, index } => match c.lookup(CtxKey::Param { def, index })? {
                    Binding::LazyExpr(lx) => self.primed_var(lx.module, lx.expr, &lx.ctx),
                    _ => None,
                },
                _ => None,
            },
            _ => None,
        }
    }

    /// The context for descending into a definition's body during
    /// enumeration: arity-0 arguments are bound *lazily* (Java
    /// `getOpContext(opDef, args, c, true)` wraps them in `LazyValue`s), so
    /// action-level arguments are traversed structurally at their use sites.
    pub(crate) fn lazy_op_ctx(
        &self,
        d: crate::sem::DefId,
        m: ModuleId,
        args: &[ExprId],
        arg_ctx: &Ctx,
        base_ctx: &Ctx,
    ) -> Result<Ctx, Diag> {
        let info = &self.analysis.defs[d.0 as usize];
        if args.len() != info.params.len() {
            return Err(eval_err(
                "E1293",
                format!(
                    "internal error: '{}' applied to {} argument(s), expected {}",
                    self.str(info.name),
                    args.len(),
                    info.params.len()
                ),
            ));
        }
        let mut c1 = base_ctx.clone();
        for (i, a) in args.iter().enumerate() {
            let key = CtxKey::Param { def: d, index: i as u32 };
            if info.params[i].arity == 0 {
                let lx = Rc::new(LazyExpr {
                    module: m,
                    expr: *a,
                    ctx: arg_ctx.clone(),
                    cell: std::cell::RefCell::new(None),
                });
                c1 = c1.bind(key, Binding::LazyExpr(lx));
            } else {
                c1 = c1.bind(key, Binding::Op(self.op_arg(m, *a, arg_ctx)?));
            }
        }
        Ok(c1)
    }

    /// How an `Ident`/`Apply` node should be handled by the enumerators.
    fn resolve_action_target(
        &self,
        m: ModuleId,
        e: ExprId,
        args: &[ExprId],
        c: &Ctx,
    ) -> Result<Target, Diag> {
        match self.analysis.expr_ref(m, e) {
            Some(Ref::Def(d)) => {
                match self.def_overrides.get(&d) {
                    Some(Override::Def(t)) => {
                        let info = &self.analysis.defs[t.0 as usize];
                        let body = self.def_body(*t)?;
                        let c1 = self.lazy_op_ctx(*t, m, args, c, &Ctx::empty())?;
                        return Ok(Target::Descend { m: info.module, e: body, c: c1 });
                    }
                    Some(Override::Val(_)) | Some(Override::Fn(_)) => return Ok(Target::Eval),
                    None => {}
                }
                if self.native_defs.contains_key(&d) {
                    return Ok(Target::Eval);
                }
                if let Some(Binding::Lazy(lz)) = c.lookup(CtxKey::Def(d)) {
                    // A LET definition: descend into its body in the captured
                    // context (Java's LazyValue branch).
                    let info = &self.analysis.defs[lz.def.0 as usize];
                    if matches!(info.kind, DefKind::Op) && info.params.is_empty() {
                        let body = self.def_body(lz.def)?;
                        return Ok(Target::Descend { m: info.module, e: body, c: lz.ctx.clone() });
                    }
                    return Ok(Target::Eval);
                }
                let info = &self.analysis.defs[d.0 as usize];
                if !matches!(info.kind, DefKind::Op) {
                    return Ok(Target::Eval);
                }
                let body = self.def_body(d)?;
                let c1 = self.lazy_op_ctx(d, m, args, c, c)?;
                Ok(Target::Descend { m: info.module, e: body, c: c1 })
            }
            Some(Ref::Param { def, index }) => match c.lookup(CtxKey::Param { def, index }) {
                Some(Binding::LazyExpr(lx)) if args.is_empty() => {
                    Ok(Target::Descend { m: lx.module, e: lx.expr, c: lx.ctx.clone() })
                }
                Some(Binding::Op(OpBinding::Def { def: d2, ctx })) => {
                    let info = &self.analysis.defs[d2.0 as usize];
                    if !matches!(info.kind, DefKind::Op) {
                        return Ok(Target::Eval);
                    }
                    let body = self.def_body(*d2)?;
                    let c1 = self.lazy_op_ctx(*d2, m, args, c, ctx)?;
                    Ok(Target::Descend { m: info.module, e: body, c: c1 })
                }
                _ => Ok(Target::Eval),
            },
            Some(Ref::Const(k)) => match self.const_substs.get(&k) {
                Some(&d) => {
                    let info = &self.analysis.defs[d.0 as usize];
                    if !matches!(info.kind, DefKind::Op) {
                        return Ok(Target::Eval);
                    }
                    let body = self.def_body(d)?;
                    let c1 = self.lazy_op_ctx(d, m, args, c, &Ctx::empty())?;
                    Ok(Target::Descend { m: info.module, e: body, c: c1 })
                }
                None => Ok(Target::Eval),
            },
            _ => Ok(Target::Eval),
        }
    }

    // ---- init-state enumeration (getInitStates / getInitStatesAppl) -------

    fn init_states(
        &self,
        m: ModuleId,
        e: ExprId,
        acts: &Acts,
        c: &Ctx,
        emit: Emit,
    ) -> Result<(), Diag> {
        let expr = self.arena(m).get(e);
        let span = expr.span;
        match &expr.kind {
            ExprKind::Paren(inner) => self.init_states(m, *inner, acts, c, emit),
            ExprKind::Label { body, .. } => self.init_states(m, *body, acts, c, emit),
            ExprKind::Let { defs, body } => {
                let c1 = self.let_ctx(m, defs, c);
                self.init_states(m, *body, acts, &c1, emit)
            }
            ExprKind::Junction(JunctionKind::Conj, items) => {
                let mut acts1 = acts.clone();
                for i in items[1..].iter().rev() {
                    acts1 = acts1.cons(ActKind::Pred, m, *i, c.clone());
                }
                self.init_states(m, items[0], &acts1, c, emit)
            }
            ExprKind::Junction(JunctionKind::Disj, items) => {
                for i in items {
                    self.init_states(m, *i, acts, c, emit)?;
                }
                Ok(())
            }
            ExprKind::Infix("\\land", l, r) => {
                let acts1 = acts.cons(ActKind::Pred, m, *r, c.clone());
                self.init_states(m, *l, &acts1, c, emit)
            }
            ExprKind::Infix("\\lor", l, r) => {
                self.init_states(m, *l, acts, c, emit)?;
                self.init_states(m, *r, acts, c, emit)
            }
            ExprKind::Infix("=>", l, r) => {
                let lv = self.eval(m, *l, c)?;
                if self.expect_bool(&lv, "P => Q").map_err(|d| d.with_span(span))? {
                    self.init_states(m, *r, acts, c, emit)
                } else {
                    self.run_init_acts(acts, emit)
                }
            }
            ExprKind::Infix("=", l, r) => {
                if let Some(v) = self.state_var(m, *l, c) {
                    let lval = self.senv.borrow().s0.get(v).cloned();
                    let rval = self.eval(m, *r, c)?;
                    match lval {
                        None => self.with_bind_s0(v, rval, || self.run_init_acts(acts, emit)),
                        Some(lv) => {
                            if lv.tla_eq(&rval, &self.vctx).map_err(|d| d.with_span(span))? {
                                self.run_init_acts(acts, emit)
                            } else {
                                Ok(())
                            }
                        }
                    }
                } else {
                    self.init_bool_guard(m, e, acts, c, emit)
                }
            }
            ExprKind::Infix("\\in", l, r) => {
                if let Some(v) = self.state_var(m, *l, c) {
                    let lval = self.senv.borrow().s0.get(v).cloned();
                    let rval = self.eval(m, *r, c)?;
                    match lval {
                        None => {
                            let elems = rval
                                .expanded_elems(&self.vctx, self.limits.enum_limit)
                                .map_err(|d| {
                                    d.note(
                                        "in computing initial states, the right side of \\in \
                                         must be enumerable",
                                        Some(span),
                                    )
                                })?;
                            for elem in elems {
                                self.with_bind_s0(v, elem, || self.run_init_acts(acts, emit))?;
                            }
                            Ok(())
                        }
                        Some(lv) => {
                            if self.value_member(&rval, &lv).map_err(|d| d.with_span(span))? {
                                self.run_init_acts(acts, emit)
                            } else {
                                Ok(())
                            }
                        }
                    }
                } else {
                    self.init_bool_guard(m, e, acts, c, emit)
                }
            }
            ExprKind::Infix("\\subseteq", l, r) => {
                if let Some(v) = self.state_var(m, *l, c) {
                    let lval = self.senv.borrow().s0.get(v).cloned();
                    let rval = self.eval(m, *r, c)?;
                    let subsets = Value::Subset(Rc::new(rval));
                    match lval {
                        None => {
                            let elems = subsets
                                .expanded_elems(&self.vctx, self.limits.enum_limit)
                                .map_err(|d| d.with_span(span))?;
                            for elem in elems {
                                self.with_bind_s0(v, elem, || self.run_init_acts(acts, emit))?;
                            }
                            Ok(())
                        }
                        Some(lv) => {
                            if self.value_member(&subsets, &lv).map_err(|d| d.with_span(span))? {
                                self.run_init_acts(acts, emit)
                            } else {
                                Ok(())
                            }
                        }
                    }
                } else {
                    self.init_bool_guard(m, e, acts, c, emit)
                }
            }
            ExprKind::Quant { kind: QuantKind::Exists, bounds, body } => {
                let slots = self.slots_for_bounds(m, bounds, c)?;
                self.for_each_combo(&slots, c, span, |c1| {
                    self.init_states(m, *body, acts, c1, emit)?;
                    Ok(true)
                })
            }
            ExprKind::Quant { kind: QuantKind::Forall, bounds, body } => {
                let slots = self.slots_for_bounds(m, bounds, c)?;
                let mut ctxs: Vec<Ctx> = Vec::new();
                self.for_each_combo(&slots, c, span, |c1| {
                    ctxs.push(c1.clone());
                    Ok(true)
                })?;
                match ctxs.split_first() {
                    None => self.run_init_acts(acts, emit),
                    Some((c1, rest)) => {
                        let mut acts1 = acts.clone();
                        for c2 in rest {
                            acts1 = acts1.cons(ActKind::Pred, m, *body, c2.clone());
                        }
                        self.init_states(m, *body, &acts1, c1, emit)
                    }
                }
            }
            ExprKind::If { cond, then, els } => {
                let g = self.eval(m, *cond, c)?;
                let taken = self
                    .expect_bool(&g, "the condition of an IF")
                    .map_err(|d| d.with_span(span))?;
                self.init_states(m, if taken { *then } else { *els }, acts, c, emit)
            }
            ExprKind::Case(arms) => {
                let mut other = None;
                for (guard, body) in arms {
                    match guard {
                        None => other = Some(*body),
                        Some(g) => {
                            let gv = self.eval(m, *g, c)?;
                            if self
                                .expect_bool(&gv, "a guard condition of a CASE")
                                .map_err(|d| d.with_span(span))?
                            {
                                return self.init_states(m, *body, acts, c, emit);
                            }
                        }
                    }
                }
                match other {
                    Some(body) => self.init_states(m, body, acts, c, emit),
                    None => Err(eval_err(
                        "E1211",
                        "In computing initial states, TLC encountered a CASE with no \
                         conditions true."
                            .into(),
                    )
                    .with_span(span)),
                }
            }
            ExprKind::Ident(_) => match self.resolve_action_target(m, e, &[], c)? {
                Target::Descend { m: m2, e: e2, c: c2 } => {
                    self.init_states(m2, e2, acts, &c2, emit)
                }
                Target::Eval => self.init_bool_guard(m, e, acts, c, emit),
            },
            ExprKind::Apply(_, _, args) => match self.resolve_action_target(m, e, args, c)? {
                Target::Descend { m: m2, e: e2, c: c2 } => {
                    self.init_states(m2, e2, acts, &c2, emit)
                }
                Target::Eval => self.init_bool_guard(m, e, acts, c, emit),
            },
            _ => self.init_bool_guard(m, e, acts, c, emit),
        }
    }

    /// The default case: evaluate `e` as a boolean guard; on `TRUE` continue
    /// with the remaining conjuncts, on `FALSE` prune this branch.
    fn init_bool_guard(
        &self,
        m: ModuleId,
        e: ExprId,
        acts: &Acts,
        c: &Ctx,
        emit: Emit,
    ) -> Result<(), Diag> {
        let v = self.eval(m, e, c)?;
        let b = self
            .expect_bool(&v, "the init-state relation")
            .map_err(|d| d.with_span(self.arena(m).get(e).span))?;
        if b {
            self.run_init_acts(acts, emit)
        } else {
            Ok(())
        }
    }

    fn run_init_acts(&self, acts: &Acts, emit: Emit) -> Result<(), Diag> {
        match &acts.0 {
            None => {
                let st = self.senv.borrow().s0.clone();
                emit(&st)
            }
            Some(f) => {
                // The allAssigned fast path (Tool.getInitStates on
                // ActionItemList, MAK 05/25/2018): once every variable has a
                // value, remaining conjuncts are plain boolean conditions —
                // evaluating them (instead of structural traversal) avoids
                // generating duplicate states from disjunctions, and the
                // generated-state counts depend on it.
                if self.senv.borrow().s0.all_assigned() {
                    let mut cur = f;
                    loop {
                        let v = self.eval(cur.m, cur.e, &cur.ctx)?;
                        if !self.expect_bool(&v, "the initial predicate").map_err(|d| {
                            d.with_span(self.arena(cur.m).get(cur.e).span)
                        })? {
                            return Ok(());
                        }
                        match &cur.next.0 {
                            Some(n) => cur = n,
                            None => {
                                let st = self.senv.borrow().s0.clone();
                                return emit(&st);
                            }
                        }
                    }
                }
                self.init_states(f.m, f.e, &f.next, &f.ctx, emit)
            }
        }
    }

    // ---- next-state enumeration (getNextStates / getNextStatesAppl) -------

    fn next_states(
        &self,
        m: ModuleId,
        e: ExprId,
        acts: &Acts,
        c: &Ctx,
        emit: Emit,
    ) -> Result<(), Diag> {
        let expr = self.arena(m).get(e);
        let span = expr.span;
        match &expr.kind {
            ExprKind::Paren(inner) => self.next_states(m, *inner, acts, c, emit),
            ExprKind::Label { body, .. } => self.next_states(m, *body, acts, c, emit),
            ExprKind::Let { defs, body } => {
                let c1 = self.let_ctx(m, defs, c);
                self.next_states(m, *body, acts, &c1, emit)
            }
            ExprKind::Junction(JunctionKind::Conj, items) => {
                let mut acts1 = acts.clone();
                for i in items[1..].iter().rev() {
                    acts1 = acts1.cons(ActKind::Pred, m, *i, c.clone());
                }
                self.next_states(m, items[0], &acts1, c, emit)
            }
            ExprKind::Junction(JunctionKind::Disj, items) => {
                for i in items {
                    self.next_states(m, *i, acts, c, emit)?;
                }
                Ok(())
            }
            ExprKind::Infix("\\land", l, r) => {
                let acts1 = acts.cons(ActKind::Pred, m, *r, c.clone());
                self.next_states(m, *l, &acts1, c, emit)
            }
            ExprKind::Infix("\\lor", l, r) => {
                self.next_states(m, *l, acts, c, emit)?;
                self.next_states(m, *r, acts, c, emit)
            }
            ExprKind::Infix("=>", l, r) => {
                let lv = self.eval(m, *l, c)?;
                if self.expect_bool(&lv, "P => Q").map_err(|d| d.with_span(span))? {
                    self.next_states(m, *r, acts, c, emit)
                } else {
                    self.run_next_acts(acts, emit)
                }
            }
            ExprKind::Infix("=", l, r) => {
                if let Some(v) = self.primed_var(m, *l, c) {
                    let lval = self.senv.borrow().s1.get(v).cloned();
                    let rval = self.eval(m, *r, c)?;
                    match lval {
                        None => self.with_bind_s1(v, rval, || self.run_next_acts(acts, emit)),
                        Some(lv) => {
                            if lv.tla_eq(&rval, &self.vctx).map_err(|d| d.with_span(span))? {
                                self.run_next_acts(acts, emit)
                            } else {
                                Ok(())
                            }
                        }
                    }
                } else {
                    self.next_bool_guard(m, e, acts, c, emit)
                }
            }
            ExprKind::Infix("\\in", l, r) => {
                if let Some(v) = self.primed_var(m, *l, c) {
                    let lval = self.senv.borrow().s1.get(v).cloned();
                    let rval = self.eval(m, *r, c)?;
                    match lval {
                        None => {
                            let elems = rval
                                .expanded_elems(&self.vctx, self.limits.enum_limit)
                                .map_err(|d| {
                                    d.note(
                                        "in computing next states, the right side of \\in \
                                         must be enumerable",
                                        Some(span),
                                    )
                                })?;
                            for elem in elems {
                                self.with_bind_s1(v, elem, || self.run_next_acts(acts, emit))?;
                            }
                            Ok(())
                        }
                        Some(lv) => {
                            if self.value_member(&rval, &lv).map_err(|d| d.with_span(span))? {
                                self.run_next_acts(acts, emit)
                            } else {
                                Ok(())
                            }
                        }
                    }
                } else {
                    self.next_bool_guard(m, e, acts, c, emit)
                }
            }
            ExprKind::Infix("\\subseteq", l, r) => {
                if let Some(v) = self.primed_var(m, *l, c) {
                    let lval = self.senv.borrow().s1.get(v).cloned();
                    let rval = self.eval(m, *r, c)?;
                    let subsets = Value::Subset(Rc::new(rval));
                    match lval {
                        None => {
                            let elems = subsets
                                .expanded_elems(&self.vctx, self.limits.enum_limit)
                                .map_err(|d| d.with_span(span))?;
                            for elem in elems {
                                self.with_bind_s1(v, elem, || self.run_next_acts(acts, emit))?;
                            }
                            Ok(())
                        }
                        Some(lv) => {
                            if self.value_member(&subsets, &lv).map_err(|d| d.with_span(span))? {
                                self.run_next_acts(acts, emit)
                            } else {
                                Ok(())
                            }
                        }
                    }
                } else {
                    self.next_bool_guard(m, e, acts, c, emit)
                }
            }
            ExprKind::Quant { kind: QuantKind::Exists, bounds, body } => {
                let slots = self.slots_for_bounds(m, bounds, c)?;
                self.for_each_combo(&slots, c, span, |c1| {
                    self.next_states(m, *body, acts, c1, emit)?;
                    Ok(true)
                })
            }
            ExprKind::Quant { kind: QuantKind::Forall, bounds, body } => {
                let slots = self.slots_for_bounds(m, bounds, c)?;
                let mut ctxs: Vec<Ctx> = Vec::new();
                self.for_each_combo(&slots, c, span, |c1| {
                    ctxs.push(c1.clone());
                    Ok(true)
                })?;
                match ctxs.split_first() {
                    None => self.run_next_acts(acts, emit),
                    Some((c1, rest)) => {
                        let mut acts1 = acts.clone();
                        for c2 in rest {
                            acts1 = acts1.cons(ActKind::Pred, m, *body, c2.clone());
                        }
                        self.next_states(m, *body, &acts1, c1, emit)
                    }
                }
            }
            ExprKind::If { cond, then, els } => {
                let g = self.eval(m, *cond, c)?;
                let taken = self
                    .expect_bool(&g, "the condition of an IF")
                    .map_err(|d| d.with_span(span))?;
                self.next_states(m, if taken { *then } else { *els }, acts, c, emit)
            }
            ExprKind::Case(arms) => {
                let mut other = None;
                for (guard, body) in arms {
                    match guard {
                        None => other = Some(*body),
                        Some(g) => {
                            let gv = self.eval(m, *g, c)?;
                            if self
                                .expect_bool(&gv, "a guard condition of a CASE")
                                .map_err(|d| d.with_span(span))?
                            {
                                return self.next_states(m, *body, acts, c, emit);
                            }
                        }
                    }
                }
                match other {
                    Some(body) => self.next_states(m, body, acts, c, emit),
                    None => Err(eval_err(
                        "E1211",
                        "In computing next states, TLC encountered a CASE with no conditions \
                         true."
                            .into(),
                    )
                    .with_span(span)),
                }
            }
            // `[A]_e` == A \/ e' = e: enumerate A's successors, then the
            // stuttering branch (Tool OPCODE_sa).
            ExprKind::ActionSubscript { kind: SubscriptKind::Square, action, subscript } => {
                self.next_states(m, *action, acts, c, emit)?;
                self.process_unchanged(m, *subscript, acts, c, emit)
            }
            // `<<A>>_e` == A /\ e' /= e (Tool OPCODE_aa).
            ExprKind::ActionSubscript { kind: SubscriptKind::Angle, action, subscript } => {
                let acts1 = acts.cons(ActKind::Changed, m, *subscript, c.clone());
                self.next_states(m, *action, &acts1, c, emit)
            }
            ExprKind::Prefix("UNCHANGED", v) => self.process_unchanged(m, *v, acts, c, emit),
            ExprKind::Ident(_) => match self.resolve_action_target(m, e, &[], c)? {
                Target::Descend { m: m2, e: e2, c: c2 } => {
                    self.next_states(m2, e2, acts, &c2, emit)
                }
                Target::Eval => self.next_bool_guard(m, e, acts, c, emit),
            },
            ExprKind::Apply(_, _, args) => match self.resolve_action_target(m, e, args, c)? {
                Target::Descend { m: m2, e: e2, c: c2 } => {
                    self.next_states(m2, e2, acts, &c2, emit)
                }
                Target::Eval => self.next_bool_guard(m, e, acts, c, emit),
            },
            _ => self.next_bool_guard(m, e, acts, c, emit),
        }
    }

    fn next_bool_guard(
        &self,
        m: ModuleId,
        e: ExprId,
        acts: &Acts,
        c: &Ctx,
        emit: Emit,
    ) -> Result<(), Diag> {
        let v = self.eval(m, e, c)?;
        let b = self
            .expect_bool(&v, "the next-state relation")
            .map_err(|d| d.with_span(self.arena(m).get(e).span))?;
        if b {
            self.run_next_acts(acts, emit)
        } else {
            Ok(())
        }
    }

    fn run_next_acts(&self, acts: &Acts, emit: Emit) -> Result<(), Diag> {
        match &acts.0 {
            None => {
                let st = self.senv.borrow().s1.clone();
                emit(&st)
            }
            // The allAssigned fast path (Tool.getNextStatesAllAssigned):
            // with every primed variable bound, remaining PRED conjuncts are
            // boolean conditions; UNCHANGED items still route through
            // processUnchanged (for the changed-while-UNCHANGED warning).
            Some(f) if self.senv.borrow().s1.all_assigned() => {
                let mut cur = f;
                loop {
                    match cur.kind {
                        ActKind::Pred => {
                            let v = self.eval(cur.m, cur.e, &cur.ctx)?;
                            if !self.expect_bool(&v, "the next-state relation").map_err(|d| {
                                d.with_span(self.arena(cur.m).get(cur.e).span)
                            })? {
                                return Ok(());
                            }
                        }
                        ActKind::Unchanged => {
                            return self.process_unchanged(cur.m, cur.e, &cur.next, &cur.ctx, emit)
                        }
                        ActKind::Changed => {
                            let v0 = self.eval(cur.m, cur.e, &cur.ctx)?;
                            let v1 = self.eval_primed(cur.m, cur.e, &cur.ctx)?;
                            if v0.tla_eq(&v1, &self.vctx).map_err(|d| {
                                d.with_span(self.arena(cur.m).get(cur.e).span)
                            })? {
                                return Ok(());
                            }
                        }
                    }
                    match &cur.next.0 {
                        Some(n) => cur = n,
                        None => {
                            let st = self.senv.borrow().s1.clone();
                            return emit(&st);
                        }
                    }
                }
            }
            Some(f) => match f.kind {
                ActKind::Pred => self.next_states(f.m, f.e, &f.next, &f.ctx, emit),
                ActKind::Unchanged => self.process_unchanged(f.m, f.e, &f.next, &f.ctx, emit),
                ActKind::Changed => {
                    // The subscript of `<<A>>_e` must have changed
                    // (Tool.getNextStates0's CHANGED kind).
                    let v0 = self.eval(f.m, f.e, &f.ctx)?;
                    let v1 = self.eval_primed(f.m, f.e, &f.ctx)?;
                    if !v0
                        .tla_eq(&v1, &self.vctx)
                        .map_err(|d| d.with_span(self.arena(f.m).get(f.e).span))?
                    {
                        self.run_next_acts(&f.next, emit)
                    } else {
                        Ok(())
                    }
                }
            },
        }
    }

    // ---- UNCHANGED (processUnchanged) --------------------------------------

    fn process_unchanged(
        &self,
        m: ModuleId,
        e: ExprId,
        acts: &Acts,
        c: &Ctx,
        emit: Emit,
    ) -> Result<(), Diag> {
        let expr = self.arena(m).get(e);
        let span = expr.span;
        // A state variable: copy its value from s0 (or verify agreement).
        if let Some(v) = self.state_var(m, e, c) {
            let val0 = self.senv.borrow().s0.get(v).cloned().ok_or_else(|| {
                eval_err(
                    "E1240",
                    format!(
                        "In evaluation, the identifier {} is either undefined or not an \
                         operator.",
                        self.str(self.analysis.vars[v.0 as usize].name)
                    ),
                )
                .with_span(span)
            })?;
            let val1 = self.senv.borrow().s1.get(v).cloned();
            return match val1 {
                None => self.with_bind_s1(v, val0, || self.run_next_acts(acts, emit)),
                Some(v1) => {
                    if val0.tla_eq(&v1, &self.vctx).map_err(|d| d.with_span(span))? {
                        self.run_next_acts(acts, emit)
                    } else {
                        self.warnings.borrow_mut().push(format!(
                            "The variable {} was changed while it is specified as UNCHANGED",
                            self.str(self.analysis.vars[v.0 as usize].name)
                        ));
                        Ok(())
                    }
                }
            };
        }
        match &expr.kind {
            ExprKind::Paren(inner) => self.process_unchanged(m, *inner, acts, c, emit),
            ExprKind::Label { body, .. } => self.process_unchanged(m, *body, acts, c, emit),
            // UNCHANGED <<a, b, ...>> distributes over the tuple
            // (processUnchangedImplTuple).
            ExprKind::Tuple(items) => match items.split_first() {
                None => self.run_next_acts(acts, emit),
                Some((first, rest)) => {
                    let mut acts1 = acts.clone();
                    for i in rest.iter().rev() {
                        acts1 = acts1.cons(ActKind::Unchanged, m, *i, c.clone());
                    }
                    self.process_unchanged(m, *first, &acts1, c, emit)
                }
            },
            // A 0-arity definition (or LET/lazy binding): descend into its
            // body (processUnchangedImpl0Arity).
            ExprKind::Ident(_) => {
                match self.analysis.expr_ref(m, e) {
                    Some(Ref::Def(d))
                        if !self.native_defs.contains_key(&d)
                            && !self.def_overrides.contains_key(&d) =>
                    {
                        if let Some(Binding::Lazy(lz)) = c.lookup(CtxKey::Def(d)) {
                            let info = &self.analysis.defs[lz.def.0 as usize];
                            if matches!(info.kind, DefKind::Op) && info.params.is_empty() {
                                let body = self.def_body(lz.def)?;
                                let ctx = lz.ctx.clone();
                                return self
                                    .process_unchanged(info.module, body, acts, &ctx, emit);
                            }
                            return self.verify_unchanged(m, e, acts, c, emit);
                        }
                        let info = &self.analysis.defs[d.0 as usize];
                        if matches!(info.kind, DefKind::Op) && info.params.is_empty() {
                            let body = self.def_body(d)?;
                            return self.process_unchanged(info.module, body, acts, c, emit);
                        }
                        self.verify_unchanged(m, e, acts, c, emit)
                    }
                    Some(Ref::Param { def, index }) => {
                        match c.lookup(CtxKey::Param { def, index }) {
                            Some(Binding::LazyExpr(lx)) => {
                                let lx = lx.clone();
                                self.process_unchanged(lx.module, lx.expr, acts, &lx.ctx, emit)
                            }
                            _ => self.verify_unchanged(m, e, acts, c, emit),
                        }
                    }
                    _ => self.verify_unchanged(m, e, acts, c, emit),
                }
            }
            _ => self.verify_unchanged(m, e, acts, c, emit),
        }
    }

    /// `Tool.verifyUnchanged`: evaluate the expression against s0 and s1 and
    /// require equality, without synthesizing bindings.
    fn verify_unchanged(
        &self,
        m: ModuleId,
        e: ExprId,
        acts: &Acts,
        c: &Ctx,
        emit: Emit,
    ) -> Result<(), Diag> {
        let v0 = self.eval(m, e, c)?;
        let v1 = self.eval_primed(m, e, c)?;
        if v0.tla_eq(&v1, &self.vctx).map_err(|d| d.with_span(self.arena(m).get(e).span))? {
            self.run_next_acts(acts, emit)
        } else {
            Ok(())
        }
    }
}

/// Resolution outcome for `Ident`/`Apply` nodes in the enumerators.
enum Target {
    /// A user definition (or lazily-bound argument): traverse its body
    /// structurally in the given context.
    Descend { m: ModuleId, e: ExprId, c: Ctx },
    /// Anything else: evaluate the node as a boolean guard.
    Eval,
}
