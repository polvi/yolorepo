//! The constant-expression evaluator — the analog of `Tool.eval`/`evalAppl`
//! (`tlc2/tool/impl/Tool.java`) restricted to constant-level expressions.
//! State variables, primes, actions, and temporal operators produce clean
//! diagnostics here; the action evaluator milestone adds states.
//!
//! Semantics ported from Java TLC:
//! - `/\ \/ => ~` demand boolean operands and short-circuit exactly as the
//!   `OPCODE_land`/`lor`/`implies` handlers do.
//! - Bounded quantifiers/CHOOSE enumerate domains in normalized (sorted)
//!   order via a `ContextEnumerator`-style odometer, including
//!   `<<x, y>> \in S` tuple destructuring; CHOOSE returns the first
//!   satisfying element in that order (deterministic by construction).
//! - `EXCEPT` binds `@` to the replaced sub-value; an update along a
//!   non-existent path warns and leaves the value unchanged (Java prints
//!   `TLC_EXCEPT_APPLIED_TO_UNKNOWN_FIELD` and skips).
//! - LET definitions of arity 0 become lazy bindings (Java `LazyValue`),
//!   evaluated on first use in their captured context and cached only when
//!   the definition is constant-level.
//! - Function definitions `f[x \in S] == e` may be recursive: points are
//!   evaluated through a memo table with the function name bound to the
//!   in-progress function.

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use hashbrown::HashMap;

use crate::check::state::State;
use crate::diag::{Category, Diag};
use crate::intern::Sym;
use crate::loc::Span;
use crate::sem::{Analysis, Builtin, ConstId, DefId, DefKind, ModuleId, Ref, VarId};
use crate::syntax::ast::{
    Bound, ExceptPathElem, ExprId, ExprKind, FnDef, JunctionKind, QuantKind, SubscriptKind, Unit,
};
use crate::value::{Value, ValueCtx, DEFAULT_ENUM_LIMIT};

use super::context::{
    Binding, Ctx, CtxKey, LazyDef, LazyExpr, LazyFcn, LazyFcnSrc, LazySetPred, OpBinding,
    RecFnState, SlotBind,
};
use super::natives::{self, Native};

/// The states an evaluation reads variables from — the (s0, s1) pair that
/// `Tool.eval` threads through every call, held ambiently in the evaluator
/// (evaluation is single-threaded and strictly nested, so scoped swaps with
/// RAII restore are equivalent to Java's parameter threading).
///
/// - constant evaluation: both are `State::null()` (zero slots);
/// - init-state enumeration: `s0` is the partial state being built;
/// - next-state enumeration: `s0` is the current state, `s1` the partial
///   successor;
/// - state-predicate checks: `s0` is the state, `s1` null;
/// - transition checks (`[][A]_v`): both are complete states.
pub struct StateEnv {
    pub s0: State,
    pub s1: State,
}

impl StateEnv {
    fn null() -> StateEnv {
        StateEnv { s0: State::null(), s1: State::null() }
    }
}

/// How a config file redefines a definition (`Op = value` / `Op <- Other`).
#[derive(Clone, Debug)]
pub enum Override {
    Val(Value),
    Def(DefId),
    /// Parameterized constant assignment `F(a, b) = v`: argument tuples with
    /// their result values.
    Fn(Rc<Vec<(Vec<Value>, Value)>>),
}

/// Resource limits for one evaluation.
#[derive(Clone, Copy, Debug)]
pub struct EvalLimits {
    /// Maximum evaluation recursion depth (guards runaway recursion by
    /// count, with a clean diagnostic).
    pub max_depth: u32,
    /// Maximum native-stack bytes one evaluation may consume, measured from
    /// the outermost `eval` call — the guard that actually keeps deep
    /// recursion inside small stacks (2 MiB test threads, ~1 MiB wasm)
    /// whatever the per-frame size of the build is.
    pub max_stack_bytes: usize,
    /// Maximum number of elements any single set may be expanded to.
    pub enum_limit: usize,
}

impl Default for EvalLimits {
    fn default() -> Self {
        EvalLimits {
            max_depth: 2000,
            max_stack_bytes: 512 * 1024,
            enum_limit: DEFAULT_ENUM_LIMIT,
        }
    }
}

/// Constant-expression evaluator over an [`Analysis`].
pub struct Evaluator<'a> {
    pub analysis: &'a Analysis,
    pub vctx: ValueCtx<'a>,
    pub limits: EvalLimits,
    /// CONSTANT bindings (from the configuration); referencing an unbound
    /// constant is a user error.
    pub const_values: HashMap<ConstId, Value>,
    /// `CONSTANT C <- Op` substitutions: applications of the constant become
    /// applications of the definition.
    pub const_substs: HashMap<ConstId, DefId>,
    /// Config-file overrides of definitions (`Op = v` / `Op <- Other` /
    /// `F(a) = v` when the name is an operator, not a declared constant).
    pub def_overrides: HashMap<DefId, Override>,
    /// Parameterized constant assignments `F(a) = v` for declared constants.
    pub const_fns: HashMap<ConstId, Rc<Vec<(Vec<Value>, Value)>>>,
    /// The states in scope for variable reads (see [`StateEnv`]).
    pub(crate) senv: RefCell<StateEnv>,
    /// Values of constant-level 0-arity definitions, computed once (the
    /// analog of SpecProcessor.processConstantDefns pre-evaluating constant
    /// definitions at startup — without it, specs like
    /// `Op == CHOOSE e \in SUBSET (1..18) : TRUE` re-expand per state).
    def_cache: RefCell<HashMap<DefId, Value>>,
    /// `TLCSet`/`TLCGet` registers (association list keyed by TLC value).
    pub tlc_registers: RefCell<Vec<(Value, Value)>>,
    /// Output collected from `Print`/`PrintT` (instead of stdout).
    pub printed: RefCell<Vec<String>>,
    /// Non-fatal warnings (e.g. EXCEPT applied to a non-existing field).
    pub warnings: RefCell<Vec<String>>,
    depth: Cell<u32>,
    /// Stack-pointer sample at the outermost `eval` (for the byte budget).
    stack_base: Cell<usize>,
    /// Native override per standard-module definition.
    pub(crate) native_defs: HashMap<DefId, Native>,
    /// Binder-table index by (module, binding-site span).
    binder_at: HashMap<(u32, u32, u32, u32, u32), crate::sem::BinderId>,
    /// Function-definition AST (`f[x \in S] == e`) per DefId.
    fn_defs: HashMap<DefId, &'a FnDef>,
    /// DefId by (module, body expr) — resolves LET-definition units.
    pub(crate) def_by_body: HashMap<(u32, u32), DefId>,
}

/// RAII depth-counter guard.
struct DepthGuard<'a>(&'a Cell<u32>);

impl Drop for DepthGuard<'_> {
    fn drop(&mut self) {
        self.0.set(self.0.get() - 1);
    }
}

/// RAII guard for [`Evaluator::eval_primed`]'s state swap: on drop the
/// current `s0` (which was `s1`) moves back to `s1` and the saved `s0`
/// returns.
struct PrimedGuard<'a> {
    senv: &'a RefCell<StateEnv>,
    saved_s0: Option<State>,
}

impl Drop for PrimedGuard<'_> {
    fn drop(&mut self) {
        let mut env = self.senv.borrow_mut();
        let s1 = std::mem::replace(&mut env.s0, self.saved_s0.take().expect("guard drops once"));
        env.s1 = s1;
    }
}

/// One bound-variable slot with its expanded domain (see module docs).
pub(crate) struct Slot {
    pub(crate) bind: SlotBind,
    pub(crate) elems: Rc<Vec<Value>>,
}

pub(crate) fn eval_err(code: &'static str, msg: String) -> Diag {
    Diag::new(Category::Eval, code, msg)
}

impl<'a> Evaluator<'a> {
    pub fn new(analysis: &'a Analysis, vctx: ValueCtx<'a>) -> Self {
        // Native overrides: definitions of the overridden standard modules.
        let mut native_defs = HashMap::new();
        for (i, d) in analysis.defs.iter().enumerate() {
            let module = vctx.interner.str(analysis.module(d.module).name);
            let name = vctx.interner.str(d.name);
            if let Some(n) = natives::native_of(module, name) {
                native_defs.insert(DefId(i as u32), n);
            }
        }
        // Binder lookup by binding-site span (binder tables only record the
        // site; the evaluator needs the id when it binds the variable).
        let mut binder_at = HashMap::new();
        for (i, b) in analysis.binders.iter().enumerate() {
            binder_at.insert(span_key(b.module, b.span), crate::sem::BinderId(i as u32));
        }
        let mut def_by_body = HashMap::new();
        for (i, d) in analysis.defs.iter().enumerate() {
            if let Some(body) = d.body {
                def_by_body.insert((d.module.0, body.0), DefId(i as u32));
            }
        }
        // Function-definition ASTs: module-level units and LET units.
        let mut fn_defs = HashMap::new();
        for (mi, m) in analysis.modules.iter().enumerate() {
            let mid = ModuleId(mi as u32);
            let mut add = |def: &'a FnDef| {
                if let Some(&d) = def_by_body.get(&(mid.0, def.body.0)) {
                    fn_defs.insert(d, def);
                }
            };
            for u in &m.source.module.units {
                if let Unit::FnDef { def, .. } = u {
                    add(def);
                }
            }
            for e in &m.source.arena.exprs {
                if let ExprKind::Let { defs, .. } = &e.kind {
                    for u in defs {
                        if let Unit::FnDef { def, .. } = u {
                            add(def);
                        }
                    }
                }
            }
        }
        Evaluator {
            analysis,
            vctx,
            limits: EvalLimits::default(),
            const_values: HashMap::new(),
            const_substs: HashMap::new(),
            def_overrides: HashMap::new(),
            const_fns: HashMap::new(),
            senv: RefCell::new(StateEnv::null()),
            def_cache: RefCell::new(HashMap::new()),
            tlc_registers: RefCell::new(Vec::new()),
            printed: RefCell::new(Vec::new()),
            warnings: RefCell::new(Vec::new()),
            depth: Cell::new(0),
            stack_base: Cell::new(0),
            native_defs,
            binder_at,
            fn_defs,
            def_by_body,
        }
    }

    // ---- state plumbing (see StateEnv) -------------------------------------

    /// Install `(s0, s1)` for the duration of `f`, restoring the previous
    /// states afterwards.
    pub fn with_states<R>(
        &self,
        s0: State,
        s1: State,
        f: impl FnOnce() -> R,
    ) -> (R, State, State) {
        let saved = std::mem::replace(&mut *self.senv.borrow_mut(), StateEnv { s0, s1 });
        let r = f();
        let env = std::mem::replace(&mut *self.senv.borrow_mut(), saved);
        (r, env.s0, env.s1)
    }

    /// Clones of the current (s0, s1) — captured into lazy values so their
    /// deferred bodies evaluate under the states of their construction site.
    pub(crate) fn snapshot_states(&self) -> (State, State) {
        let env = self.senv.borrow();
        (env.s0.clone(), env.s1.clone())
    }

    /// Evaluate `e'`-style: `Tool.eval` OPCODE_prime evaluates the operand
    /// with `s0 := s1, s1 := Null`.
    pub(crate) fn eval_primed(&self, m: ModuleId, e: ExprId, c: &Ctx) -> Result<Value, Diag> {
        let _g = self.enter_primed();
        self.eval(m, e, c)
    }

    fn enter_primed(&self) -> PrimedGuard<'_> {
        let mut env = self.senv.borrow_mut();
        let s1 = std::mem::replace(&mut env.s1, State::null());
        let saved_s0 = std::mem::replace(&mut env.s0, s1);
        drop(env);
        PrimedGuard { senv: &self.senv, saved_s0: Some(saved_s0) }
    }

    /// `v' = v` — the second half of `[A]_v`/`UNCHANGED v` value semantics
    /// (`Tool.evalAppl` OPCODE_sa/OPCODE_unchanged).
    pub(crate) fn eval_unchanged_value(
        &self,
        m: ModuleId,
        e: ExprId,
        c: &Ctx,
    ) -> Result<bool, Diag> {
        let v0 = self.eval(m, e, c)?;
        let v1 = self.eval_primed(m, e, c)?;
        v0.tla_eq(&v1, &self.vctx)
    }

    /// Read variable `v` from the current state (`s1` under prime, since the
    /// states are swapped by [`Evaluator::eval_primed`]).
    fn read_var(&self, v: VarId) -> Result<Value, Diag> {
        let env = self.senv.borrow();
        let name = || self.str(self.analysis.vars[v.0 as usize].name).to_string();
        if env.s0.vals.is_empty() {
            return Err(eval_err(
                "E1216",
                format!(
                    "state variable '{}' cannot be evaluated in a constant expression",
                    name()
                ),
            ));
        }
        match env.s0.get(v) {
            Some(val) => Ok(val.clone()),
            None => Err(eval_err(
                "E1240",
                format!(
                    "In evaluation, the identifier {} is either undefined or not an operator.",
                    name()
                ),
            )),
        }
    }

    /// Evaluate a definition of the root module by name (convenience for
    /// callers and tests).
    pub fn eval_def_named(&self, name: &str) -> Result<Value, Diag> {
        let root = self.analysis.root;
        let d = self
            .analysis
            .find_def(self.vctx.interner, root, name)
            .ok_or_else(|| eval_err("E1201", format!("no definition named '{name}'")))?;
        self.eval_def(d, &Ctx::empty())
    }

    /// Evaluate a definition's value (arity must be 0).
    pub fn eval_def(&self, d: DefId, c: &Ctx) -> Result<Value, Diag> {
        let info = &self.analysis.defs[d.0 as usize];
        if info.arity != 0 {
            return Err(eval_err(
                "E1202",
                format!(
                    "operator '{}' takes {} argument(s) and has no value by itself",
                    self.vctx.interner.str(info.name),
                    info.arity
                ),
            ));
        }
        if let Some(&n) = self.native_defs.get(&d) {
            return self.call_native(n, &[], info.span);
        }
        let cacheable = self.analysis.def_level(d) == 0 && info.params.is_empty();
        if cacheable {
            if let Some(v) = self.def_cache.borrow().get(&d) {
                return Ok(v.clone());
            }
        }
        let v = match &info.kind {
            DefKind::Op => {
                let body = self.def_body(d)?;
                self.eval(info.module, body, c)
            }
            DefKind::Fn { .. } => self.build_fn(d, c),
        }?;
        if cacheable {
            self.def_cache.borrow_mut().insert(d, v.clone());
        }
        Ok(v)
    }

    /// Evaluate expression `e` of module `m` in context `c`.
    pub fn eval(&self, m: ModuleId, e: ExprId, c: &Ctx) -> Result<Value, Diag> {
        let _guard = self.enter(m, e)?;
        let span = self.arena(m).get(e).span;
        self.eval_inner(m, e, c).map_err(|d| if d.span.is_none() { d.with_span(span) } else { d })
    }

    // ---- plumbing ----------------------------------------------------------

    pub(crate) fn arena(&self, m: ModuleId) -> &'a crate::syntax::ast::ExprArena {
        &self.analysis.module(m).source.arena
    }

    pub(crate) fn str(&self, s: Sym) -> &str {
        self.vctx.interner.str(s)
    }

    fn enter(&self, m: ModuleId, e: ExprId) -> Result<DepthGuard<'_>, Diag> {
        let d = self.depth.get();
        // The address of a local approximates the stack pointer; the growth
        // since the outermost eval call bounds actual stack use.
        let here = &d as *const u32 as usize;
        if d == 0 {
            self.stack_base.set(here);
        } else if d >= self.limits.max_depth
            || here.abs_diff(self.stack_base.get()) > self.limits.max_stack_bytes
        {
            let span = self.arena(m).get(e).span;
            return Err(eval_err(
                "E1203",
                format!(
                    "Evaluation exceeded the recursion limit (depth {} of max {}; likely \
                     infinite recursion, or raise the evaluator limits).",
                    d, self.limits.max_depth
                ),
            )
            .with_span(span));
        }
        self.depth.set(d + 1);
        Ok(DepthGuard(&self.depth))
    }

    pub(crate) fn binder_id(&self, m: ModuleId, span: Span) -> Result<crate::sem::BinderId, Diag> {
        self.binder_at.get(&span_key(m, span)).copied().ok_or_else(|| {
            eval_err("E1290", "internal error: no binder recorded at this binding site".into())
                .with_span(span)
        })
    }

    pub(crate) fn def_body(&self, d: DefId) -> Result<ExprId, Diag> {
        self.analysis.defs[d.0 as usize].body.ok_or_else(|| {
            eval_err(
                "E1291",
                format!(
                    "internal error: definition '{}' has no body",
                    self.str(self.analysis.defs[d.0 as usize].name)
                ),
            )
        })
    }

    pub(crate) fn expect_bool(&self, v: &Value, what: &str) -> Result<bool, Diag> {
        match v {
            Value::Bool(b) => Ok(*b),
            _ => Err(eval_err(
                "E1204",
                format!(
                    "Attempted to evaluate an expression of form {what} when the operand \
                     was not a boolean:\n{}",
                    v.display(&self.vctx)
                ),
            )),
        }
    }

    // ---- dispatch ----------------------------------------------------------

    fn eval_inner(&self, m: ModuleId, e: ExprId, c: &Ctx) -> Result<Value, Diag> {
        let expr = self.arena(m).get(e);
        match &expr.kind {
            ExprKind::Num(s) => self.parse_num(self.str(*s)),
            ExprKind::Str(s) => Ok(Value::Str(*s)),
            ExprKind::Ident(s) => self.eval_name(m, e, *s, c),
            ExprKind::Paren(inner) => self.eval(m, *inner, c),
            ExprKind::Label { body, .. } => self.eval(m, *body, c),

            ExprKind::Prefix(op, a) => self.eval_prefix(m, e, op, *a, c),
            ExprKind::Infix(op, l, r) => self.eval_infix(m, e, op, *l, *r, c),
            ExprKind::Postfix(op, a) => {
                // A user definition of the postfix symbol wins (z ^+ == ..).
                if *op != "'" {
                    if let Some(r) = self.analysis.expr_ref(m, e) {
                        return self.apply_resolved_op(m, r, &[*a], c, expr.span);
                    }
                }
                match *op {
                    "'" => self.eval_primed(m, *a, c),
                    _ => Err(eval_err(
                        "E1205",
                        format!(
                            "action operator '{op}' cannot appear in a constant expression"
                        ),
                    )),
                }
            }
            ExprKind::Times(items) => self.eval_times(m, items, c),

            ExprKind::Apply(s, hspan, args) => self.eval_apply(m, e, *s, *hspan, args, c),

            ExprKind::Junction(kind, items) => self.eval_junction(m, *kind, items, c),

            ExprKind::Quant { kind, bounds, body } => {
                self.eval_quant(m, *kind, bounds, *body, c, expr.span)
            }
            ExprKind::UnboundedQuant { .. } => Err(eval_err(
                "E1206",
                "TLC cannot evaluate an unbounded quantifier; use \\E x \\in S / \\A x \\in S"
                    .into(),
            )),
            ExprKind::TemporalQuant { .. } => Err(eval_err(
                "E1207",
                "temporal operator cannot appear in a constant expression".into(),
            )),

            ExprKind::Choose { var, tuple_vars, domain, body } => {
                self.eval_choose(m, *var, tuple_vars, *domain, *body, c)
            }

            ExprKind::SetEnum(items) => {
                Value::set_enum(self.eval_args(m, items, c)?, &self.vctx)
            }
            ExprKind::SetFilter { bound, pred } => self.eval_set_filter(m, e, bound, *pred, c),
            ExprKind::SetMap { expr: body, bounds } => {
                self.eval_set_map(m, bounds, *body, c, expr.span)
            }

            ExprKind::FnConstructor { bounds, body } => {
                self.eval_fn_constructor(m, e, bounds, *body, c, expr.span)
            }
            ExprKind::FnApply { f, args } => self.eval_fn_apply(m, *f, args, c),
            ExprKind::FnSet { domain, range } => self.eval_fn_set(m, *domain, *range, c),

            ExprKind::Record(fields) => self.eval_record(m, fields, c),
            ExprKind::RecordSet(fields) => self.eval_record_set(m, fields, c),
            ExprKind::RecordField(base, name, _) => {
                let v = self.eval(m, *base, c)?;
                self.record_select(&v, *name)
            }
            ExprKind::Except { base, updates } => self.eval_except(m, *base, updates, c),

            ExprKind::Tuple(items) => Ok(Value::tuple(self.eval_args(m, items, c)?)),

            ExprKind::If { cond, then, els } => self.eval_if(m, *cond, *then, *els, c),
            ExprKind::Case(arms) => self.eval_case(m, arms, c),

            ExprKind::Let { defs, body } => self.eval_let(m, defs, *body, c),

            // `[A]_v` == A \/ v' = v; `<<A>>_v` == A /\ v' /= v
            // (Tool.evalAppl OPCODE_sa / OPCODE_aa).
            ExprKind::ActionSubscript { kind, action, subscript } => {
                let a = self.eval(m, *action, c)?;
                match kind {
                    SubscriptKind::Square => {
                        if self.expect_bool(&a, "[A]_e")? {
                            return Ok(Value::Bool(true));
                        }
                        Ok(Value::Bool(self.eval_unchanged_value(m, *subscript, c)?))
                    }
                    SubscriptKind::Angle => {
                        if !self.expect_bool(&a, "<A>_e")? {
                            return Ok(Value::Bool(false));
                        }
                        Ok(Value::Bool(!self.eval_unchanged_value(m, *subscript, c)?))
                    }
                }
            }
            ExprKind::Fairness { .. } => Err(eval_err(
                "E1207",
                "fairness operator WF_v / SF_v cannot appear in a constant expression".into(),
            )),
            ExprKind::Lambda { .. } => Err(eval_err(
                "E1212",
                "a LAMBDA is only legal as an operator argument, not as an expression".into(),
            )),
        }
    }

    // ---- extracted expression-kind handlers (kept out of the recursive
    // dispatch frame so deep recursion stays within small stacks) -----------

    fn eval_times(&self, m: ModuleId, items: &[ExprId], c: &Ctx) -> Result<Value, Diag> {
        Ok(Value::SetOfTuples(Rc::new(self.eval_args(m, items, c)?)))
    }

    fn eval_junction(
        &self,
        m: ModuleId,
        kind: JunctionKind,
        items: &[ExprId],
        c: &Ctx,
    ) -> Result<Value, Diag> {
        let (form, stop) = match kind {
            JunctionKind::Conj => ("P /\\ Q", false),
            JunctionKind::Disj => ("P \\/ Q", true),
        };
        for i in items {
            let v = self.eval(m, *i, c)?;
            if self.expect_bool(&v, form)? == stop {
                return Ok(Value::Bool(stop));
            }
        }
        Ok(Value::Bool(!stop))
    }

    fn eval_quant(
        &self,
        m: ModuleId,
        kind: QuantKind,
        bounds: &[Bound],
        body: ExprId,
        c: &Ctx,
        span: Span,
    ) -> Result<Value, Diag> {
        let slots = self.slots_for_bounds(m, bounds, c)?;
        let (form, stop) = match kind {
            QuantKind::Exists => ("\\E x \\in S: P", true),
            QuantKind::Forall => ("\\A x \\in S: P", false),
        };
        let mut result = !stop;
        self.for_each_combo(&slots, c, span, |c1| {
            let v = self.eval(m, body, c1)?;
            if self.expect_bool(&v, form)? == stop {
                result = stop;
                return Ok(false); // short-circuit
            }
            Ok(true)
        })?;
        Ok(Value::Bool(result))
    }

    fn eval_set_map(
        &self,
        m: ModuleId,
        bounds: &[Bound],
        body: ExprId,
        c: &Ctx,
        span: Span,
    ) -> Result<Value, Diag> {
        let slots = self.slots_for_bounds(m, bounds, c)?;
        let mut vals = Vec::new();
        self.for_each_combo(&slots, c, span, |c1| {
            vals.push(self.eval(m, body, c1)?);
            Ok(true)
        })?;
        Value::set_enum(vals, &self.vctx)
    }

    fn eval_fn_constructor(
        &self,
        m: ModuleId,
        e: ExprId,
        bounds: &[Bound],
        body: ExprId,
        c: &Ctx,
        span: Span,
    ) -> Result<Value, Diag> {
        match self.try_slots(m, bounds, c)? {
            Ok(slots) => self.build_fcn_from_slots(m, &slots, body, c, span, None),
            Err(domains) => {
                let (s0, s1) = self.snapshot_states();
                Ok(Value::FcnLambda(Rc::new(LazyFcn {
                    module: m,
                    src: LazyFcnSrc::Constructor(e),
                    ctx: c.clone(),
                    domains,
                    excepts: Vec::new(),
                    s0,
                    s1,
                })))
            }
        }
    }

    /// Evaluate bound domains and expand them into slots when every domain
    /// is enumerable; otherwise return the evaluated domain values so the
    /// caller can go lazy (Java keeps `FcnLambdaValue`/`SetPredValue`
    /// unexpanded over Nat/Int/... domains).
    #[allow(clippy::type_complexity)]
    fn try_slots(
        &self,
        m: ModuleId,
        bounds: &[Bound],
        c: &Ctx,
    ) -> Result<Result<Vec<Slot>, Vec<Value>>, Diag> {
        let mut doms = Vec::with_capacity(bounds.len());
        for b in bounds {
            doms.push(self.eval(m, b.domain, c)?);
        }
        let mut lazy = false;
        for d in &doms {
            match d.set_card(&self.vctx) {
                Ok(card) if card <= self.limits.enum_limit as i128 => {}
                Ok(_) => lazy = true,
                // E1107: non-enumerable set — go lazy; other errors (e.g.
                // not a set at all) surface eagerly below.
                Err(e) if e.code == "E1107" => lazy = true,
                Err(_) => {}
            }
        }
        if lazy {
            return Ok(Err(doms));
        }
        let mut slots = Vec::new();
        for (b, dom) in bounds.iter().zip(&doms) {
            let elems = Rc::new(dom.expanded_elems(&self.vctx, self.limits.enum_limit)?);
            if b.tuple {
                let mut binders = Vec::with_capacity(b.vars.len());
                for (_, sp) in &b.vars {
                    binders.push(self.binder_id(m, *sp)?);
                }
                slots.push(Slot { bind: SlotBind::Tuple(binders), elems });
            } else {
                for (_, sp) in &b.vars {
                    slots.push(Slot {
                        bind: SlotBind::One(self.binder_id(m, *sp)?),
                        elems: elems.clone(),
                    });
                }
            }
        }
        Ok(Ok(slots))
    }

    /// The bounds/body a lazy function evaluates through.
    fn lazy_fcn_src(&self, lf: &LazyFcn) -> Result<(&'a [Bound], ExprId), Diag> {
        match lf.src {
            LazyFcnSrc::Constructor(e) => match &self.arena(lf.module).get(e).kind {
                ExprKind::FnConstructor { bounds, body } => Ok((bounds, *body)),
                _ => Err(eval_err("E1299", "internal error: not a function constructor".into())),
            },
            LazyFcnSrc::FnDef(d) => {
                let fndef = self.fn_defs.get(&d).copied().ok_or_else(|| {
                    eval_err("E1295", "internal error: missing function-definition AST".into())
                })?;
                Ok((&fndef.bounds, fndef.body))
            }
        }
    }

    /// Apply a lazy function: `None` when the argument is outside the
    /// domain (`FcnLambdaValue.apply`).
    pub(crate) fn lazy_fcn_lookup(
        &self,
        lf: &Rc<LazyFcn>,
        argv: &Value,
    ) -> Result<Option<Value>, Diag> {
        for (a, v) in lf.excepts.iter().rev() {
            if a.tla_eq(argv, &self.vctx)? {
                return Ok(Some(v.clone()));
            }
        }
        let (bounds, body) = self.lazy_fcn_src(lf)?;
        // Slot layout parallel to the eager path: a tuple group is one
        // slot; each plain variable is one slot sharing its group's domain.
        let mut slots: Vec<(SlotBind, &Value)> = Vec::new();
        for (b, dom) in bounds.iter().zip(&lf.domains) {
            if b.tuple {
                let mut binders = Vec::with_capacity(b.vars.len());
                for (_, sp) in &b.vars {
                    binders.push(self.binder_id(lf.module, *sp)?);
                }
                slots.push((SlotBind::Tuple(binders), dom));
            } else {
                for (_, sp) in &b.vars {
                    slots.push((SlotBind::One(self.binder_id(lf.module, *sp)?), dom));
                }
            }
        }
        let parts: Vec<Value> = if slots.len() == 1 {
            vec![argv.clone()]
        } else {
            match argv.as_tuple_elems().filter(|p| p.len() == slots.len()) {
                Some(p) => p,
                None => return Ok(None),
            }
        };
        let mut c1 = lf.ctx.clone();
        // A lazy function definition may be recursive: bind its own name to
        // this value so `E[n-1]` inside the body resolves.
        if let LazyFcnSrc::FnDef(d) = lf.src {
            if let DefKind::Fn { self_binder, .. } = self.analysis.defs[d.0 as usize].kind {
                c1 = c1.bind(
                    CtxKey::Binder(self_binder),
                    Binding::Val(Value::FcnLambda(lf.clone())),
                );
            }
        }
        for ((sb, dom), part) in slots.iter().zip(&parts) {
            if !self.value_member(dom, part)? {
                return Ok(None);
            }
            c1 = self.bind_slot(&c1, sb, part)?;
        }
        let (r, _, _) = self.with_states(lf.s0.clone(), lf.s1.clone(), || {
            self.eval(lf.module, body, &c1)
        });
        Ok(Some(r?))
    }

    /// Membership test that understands the lazy set values (`SetPredValue`
    /// / `SetCupValue` semantics need the evaluator); everything else
    /// delegates to the value layer.
    pub(crate) fn value_member(&self, set: &Value, elem: &Value) -> Result<bool, Diag> {
        match set {
            // SetPred membership is served by the value layer through the
            // installed LazyEval hook (this evaluator), which restores the
            // states captured at the set's construction.
            Value::SetCup(l, r) => {
                Ok(self.value_member(l, elem)? || self.value_member(r, elem)?)
            }
            Value::SetOfFcns { dom, rng } => {
                let pairs = match elem {
                    Value::Tuple(items) => Some((
                        (1..=items.len() as i64).map(Value::Int).collect::<Vec<_>>(),
                        items.as_ref().clone(),
                    )),
                    Value::Record(fields) => Some((
                        fields.iter().map(|(n, _)| Value::Str(*n)).collect(),
                        fields.iter().map(|(_, v)| v.clone()).collect(),
                    )),
                    Value::FcnRcd { dom: d2, rng: r2 } => {
                        Some((d2.as_ref().clone(), r2.as_ref().clone()))
                    }
                    _ => None,
                };
                match pairs {
                    None => set.member(elem, &self.vctx),
                    Some((edom, erng)) => {
                        let edom = Value::SetEnum(Rc::new(edom));
                        if !edom.tla_eq(dom, &self.vctx)? {
                            return Ok(false);
                        }
                        for v in &erng {
                            if !self.value_member(rng, v)? {
                                return Ok(false);
                            }
                        }
                        Ok(true)
                    }
                }
            }
            Value::SetOfTuples(sets) => match elem.as_tuple_elems() {
                Some(items) if items.len() == sets.len() => {
                    for (s2, v) in sets.iter().zip(&items) {
                        if !self.value_member(s2, v)? {
                            return Ok(false);
                        }
                    }
                    Ok(true)
                }
                _ => set.member(elem, &self.vctx),
            },
            Value::Subset(base) => match elem {
                Value::SetEnum(_) | Value::Interval { .. } => {
                    for v in elem.expanded_elems(&self.vctx, self.limits.enum_limit)? {
                        if !self.value_member(base, &v)? {
                            return Ok(false);
                        }
                    }
                    Ok(true)
                }
                _ => set.member(elem, &self.vctx),
            },
            _ => set.member(elem, &self.vctx),
        }
    }

    fn eval_fn_set(
        &self,
        m: ModuleId,
        domain: ExprId,
        range: ExprId,
        c: &Ctx,
    ) -> Result<Value, Diag> {
        let d = self.eval(m, domain, c)?;
        let r = self.eval(m, range, c)?;
        Ok(Value::SetOfFcns { dom: Rc::new(d), rng: Rc::new(r) })
    }

    fn eval_record(
        &self,
        m: ModuleId,
        fields: &[(Sym, Span, ExprId)],
        c: &Ctx,
    ) -> Result<Value, Diag> {
        let mut pairs = Vec::with_capacity(fields.len());
        for (name, _, v) in fields {
            pairs.push((*name, self.eval(m, *v, c)?));
        }
        Value::record(pairs, &self.vctx)
    }

    fn eval_record_set(
        &self,
        m: ModuleId,
        fields: &[(Sym, Span, ExprId)],
        c: &Ctx,
    ) -> Result<Value, Diag> {
        let mut pairs = Vec::with_capacity(fields.len());
        for (name, _, v) in fields {
            pairs.push((*name, self.eval(m, *v, c)?));
        }
        pairs.sort_by(|a, b| self.str(a.0).cmp(self.str(b.0)));
        for w in pairs.windows(2) {
            if w[0].0 == w[1].0 {
                return Err(eval_err(
                    "E1208",
                    format!(
                        "Field name {} occurs multiple times in set of records.",
                        self.str(w[0].0)
                    ),
                ));
            }
        }
        Ok(Value::SetOfRcds(Rc::new(pairs)))
    }

    fn eval_if(
        &self,
        m: ModuleId,
        cond: ExprId,
        then: ExprId,
        els: ExprId,
        c: &Ctx,
    ) -> Result<Value, Diag> {
        match self.eval(m, cond, c)? {
            Value::Bool(true) => self.eval(m, then, c),
            Value::Bool(false) => self.eval(m, els, c),
            other => Err(eval_err(
                "E1209",
                format!(
                    "A non-boolean expression was used as the condition of an IF:\n{}",
                    other.display(&self.vctx)
                ),
            )),
        }
    }

    fn eval_case(
        &self,
        m: ModuleId,
        arms: &[(Option<ExprId>, ExprId)],
        c: &Ctx,
    ) -> Result<Value, Diag> {
        let mut other = None;
        for (guard, body) in arms {
            match guard {
                None => other = Some(*body),
                Some(g) => match self.eval(m, *g, c)? {
                    Value::Bool(true) => return self.eval(m, *body, c),
                    Value::Bool(false) => {}
                    bad => {
                        return Err(eval_err(
                            "E1210",
                            format!(
                                "A non-boolean expression was used as a condition of a \
                                 CASE:\n{}",
                                bad.display(&self.vctx)
                            ),
                        ))
                    }
                },
            }
        }
        match other {
            Some(body) => self.eval(m, body, c),
            None => Err(eval_err(
                "E1211",
                "Attempted to evaluate a CASE with no conditions true.".into(),
            )),
        }
    }

    fn eval_let(&self, m: ModuleId, defs: &[Unit], body: ExprId, c: &Ctx) -> Result<Value, Diag> {
        let c1 = self.let_ctx(m, defs, c);
        self.eval(m, body, &c1)
    }

    /// The context of a LET body: a LazyValue binding for every arity-0
    /// definition (Java Tool's LetInKind handling).
    pub(crate) fn let_ctx(&self, m: ModuleId, defs: &[Unit], c: &Ctx) -> Ctx {
        let mut c1 = c.clone();
        for u in defs {
            let def = match u {
                Unit::OpDef { def, .. } if def.params.is_empty() => {
                    self.def_by_body.get(&(m.0, def.body.0))
                }
                Unit::FnDef { def, .. } => self.def_by_body.get(&(m.0, def.body.0)),
                _ => None,
            };
            if let Some(&d) = def {
                let lz = Rc::new(LazyDef { def: d, ctx: c1.clone(), cell: RefCell::new(None) });
                c1 = c1.bind(CtxKey::Def(d), Binding::Lazy(lz));
            }
        }
        c1
    }

    // ---- literals ----------------------------------------------------------

    fn parse_num(&self, text: &str) -> Result<Value, Diag> {
        let (radix, digits) = if let Some(rest) = text.strip_prefix('\\') {
            match rest.as_bytes().first() {
                Some(b'b') | Some(b'B') => (2, &rest[1..]),
                Some(b'o') | Some(b'O') => (8, &rest[1..]),
                Some(b'h') | Some(b'H') => (16, &rest[1..]),
                _ => {
                    return Err(eval_err("E1213", format!("malformed number literal '{text}'")))
                }
            }
        } else if text.contains('.') {
            return Err(eval_err(
                "E1214",
                format!("TLC does not support real number literals ('{text}')"),
            ));
        } else {
            (10, text)
        };
        i64::from_str_radix(digits, radix).map(Value::Int).map_err(|_| {
            eval_err(
                "E1215",
                format!("number literal '{text}' does not fit in a 64-bit integer"),
            )
        })
    }

    // ---- names and application ---------------------------------------------

    fn eval_name(&self, m: ModuleId, e: ExprId, s: Sym, c: &Ctx) -> Result<Value, Diag> {
        match self.analysis.expr_ref(m, e) {
            Some(Ref::Def(d)) => {
                match self.def_overrides.get(&d) {
                    Some(Override::Val(v)) => return Ok(v.clone()),
                    Some(Override::Def(t)) => return self.eval_def(*t, c),
                    Some(Override::Fn(_)) | None => {}
                }
                if let Some(&n) = self.native_defs.get(&d) {
                    return self.call_native(n, &[], self.arena(m).get(e).span);
                }
                if let Some(Binding::Lazy(lz)) = c.lookup(CtxKey::Def(d)) {
                    let lz = lz.clone();
                    return self.force_lazy(&lz);
                }
                self.eval_def(d, c)
            }
            Some(Ref::Var(v)) => self.read_var(v),
            Some(Ref::Const(k)) => {
                if let Some(v) = self.const_values.get(&k) {
                    return Ok(v.clone());
                }
                if let Some(&d) = self.const_substs.get(&k) {
                    return self.eval_def(d, c);
                }
                Err(eval_err(
                    "E1217",
                    format!(
                        "The constant parameter {} is not assigned a value by the configuration.",
                        self.str(self.analysis.consts[k.0 as usize].name)
                    ),
                ))
            }
            Some(Ref::Param { def, index }) => match c.lookup(CtxKey::Param { def, index }) {
                Some(Binding::Val(v)) => Ok(v.clone()),
                Some(Binding::LazyExpr(lx)) => {
                    let lx = lx.clone();
                    if let Some(v) = lx.cell.borrow().as_ref() {
                        return Ok(v.clone());
                    }
                    let v = self.eval(lx.module, lx.expr, &lx.ctx)?;
                    // Cache only constant-level argument expressions (state-
                    // dependent ones must re-read the states in scope).
                    if self.analysis.level(lx.module, lx.expr) == 0 {
                        *lx.cell.borrow_mut() = Some(v.clone());
                    }
                    Ok(v)
                }
                Some(Binding::Op(_)) => Err(eval_err(
                    "E1218",
                    format!("operator parameter '{}' used as an expression", self.str(s)),
                )),
                _ => Err(eval_err(
                    "E1292",
                    format!("internal error: parameter '{}' is unbound", self.str(s)),
                )),
            },
            Some(Ref::Binder(b)) => match c.lookup(CtxKey::Binder(b)) {
                Some(Binding::Val(v)) => Ok(v.clone()),
                Some(Binding::RecFn(_)) => Err(eval_err(
                    "E1219",
                    format!(
                        "recursive function '{}' may only be applied (f[x]) within its own \
                         definition",
                        self.str(s)
                    ),
                )),
                _ => Err(eval_err(
                    "E1292",
                    format!("internal error: bound variable '{}' is unbound", self.str(s)),
                )),
            },
            Some(Ref::Builtin(b)) => Ok(match b {
                Builtin::True => Value::Bool(true),
                Builtin::False => Value::Bool(false),
                Builtin::Boolean => Value::BoolSet,
                Builtin::String => Value::StringSet,
            }),
            None => Err(eval_err(
                "E1292",
                format!("internal error: unresolved identifier '{}'", self.str(s)),
            )),
        }
    }

    fn eval_apply(
        &self,
        m: ModuleId,
        e: ExprId,
        s: Sym,
        hspan: Span,
        args: &[ExprId],
        c: &Ctx,
    ) -> Result<Value, Diag> {
        match self.analysis.expr_ref(m, e) {
            Some(Ref::Def(d)) => {
                match self.def_overrides.get(&d) {
                    Some(Override::Def(t)) => {
                        return self.apply_def_or_native(*t, m, args, c, hspan)
                    }
                    Some(Override::Fn(table)) => {
                        let table = table.clone();
                        let vals = self.eval_args(m, args, c)?;
                        return self.apply_cfg_fn(&table, &vals, self.str(s), hspan);
                    }
                    Some(Override::Val(_)) | None => {}
                }
                self.apply_def_or_native(d, m, args, c, hspan)
            }
            Some(Ref::Param { def, index }) => match c.lookup(CtxKey::Param { def, index }) {
                Some(Binding::Op(op)) => {
                    let op = op.clone();
                    let vals = self.eval_args(m, args, c)?;
                    self.apply_op(&op, &vals, hspan)
                }
                Some(Binding::Val(_)) | Some(Binding::LazyExpr(_)) => Err(eval_err(
                    "E1218",
                    format!("'{}' is not an operator and cannot be applied", self.str(s)),
                )),
                _ => Err(eval_err(
                    "E1292",
                    format!("internal error: operator parameter '{}' is unbound", self.str(s)),
                )),
            },
            Some(Ref::Const(k)) => {
                if let Some(&d) = self.const_substs.get(&k) {
                    return self.apply_def_or_native(d, m, args, c, hspan);
                }
                if let Some(table) = self.const_fns.get(&k) {
                    let table = table.clone();
                    let vals = self.eval_args(m, args, c)?;
                    return self.apply_cfg_fn(&table, &vals, self.str(s), hspan);
                }
                Err(eval_err(
                    "E1220",
                    format!(
                        "The constant parameter {} is not assigned a value by the configuration.",
                        self.str(self.analysis.consts[k.0 as usize].name)
                    ),
                ))
            }
            Some(_) | None => {
                // Nonfix builtin application, e.g. `\o(a, b)`.
                let spelling = self.str(s).to_string();
                let vals = self.eval_args(m, args, c)?;
                match vals.len() {
                    2 => self.builtin_infix_values(&spelling, &vals[0], &vals[1]),
                    1 => self.builtin_prefix_values(&spelling, &vals[0]),
                    _ => Err(eval_err(
                        "E1221",
                        format!("operator '{spelling}' cannot be applied here"),
                    )),
                }
            }
        }
    }

    pub(crate) fn eval_args(&self, m: ModuleId, args: &[ExprId], c: &Ctx) -> Result<Vec<Value>, Diag> {
        args.iter().map(|a| self.eval(m, *a, c)).collect()
    }

    /// Apply a definition that may carry a native override (a stdlib
    /// operator, or an override/substitution target that is one).
    fn apply_def_or_native(
        &self,
        d: DefId,
        m: ModuleId,
        args: &[ExprId],
        c: &Ctx,
        span: Span,
    ) -> Result<Value, Diag> {
        if let Some(&n) = self.native_defs.get(&d) {
            // Higher-order natives take an operator argument, which must
            // not be evaluated as an expression.
            if matches!(n, Native::SortSeq | Native::SelectSeq) && args.len() == 2 {
                let sv = self.eval(m, args[0], c)?;
                let op = self.op_arg(m, args[1], c)?;
                return self.call_seq_native(n, &sv, &op, span);
            }
            let vals = self.eval_args(m, args, c)?;
            return self.call_native(n, &vals, span);
        }
        self.apply_def(d, m, args, c)
    }

    /// Apply a user definition to argument expressions (`Tool.getOpContext` +
    /// body evaluation). Higher-order arguments become operator bindings.
    pub(crate) fn apply_def(&self, d: DefId, m: ModuleId, args: &[ExprId], c: &Ctx) -> Result<Value, Diag> {
        let info = &self.analysis.defs[d.0 as usize];
        match &info.kind {
            DefKind::Fn { .. } => self.build_fn(d, c),
            DefKind::Op => {
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
                // Java's evalAppl calls getOpContext with lazy=true: every
                // argument becomes a LazyValue evaluated at its use sites.
                // Eager evaluation is observably different when the body
                // primes a parameter (`Bar(z) == z' = 2` applied to a
                // variable) or never uses it.
                let mut c1 = c.clone();
                for (i, a) in args.iter().enumerate() {
                    let key = CtxKey::Param { def: d, index: i as u32 };
                    if info.params[i].arity == 0 {
                        let lx = Rc::new(LazyExpr {
                            module: m,
                            expr: *a,
                            ctx: c.clone(),
                            cell: RefCell::new(None),
                        });
                        c1 = c1.bind(key, Binding::LazyExpr(lx));
                    } else {
                        let op = self.op_arg(m, *a, c)?;
                        c1 = c1.bind(key, Binding::Op(op));
                    }
                }
                let body = self.def_body(d)?;
                self.eval(info.module, body, &c1)
            }
        }
    }

    /// Interpret an argument expression in a higher-order position as an
    /// operator (name of a definition/parameter, builtin symbol, or LAMBDA).
    pub(crate) fn op_arg(&self, m: ModuleId, a: ExprId, c: &Ctx) -> Result<OpBinding, Diag> {
        let expr = self.arena(m).get(a);
        match &expr.kind {
            ExprKind::Ident(s) => match self.analysis.expr_ref(m, a) {
                Some(Ref::Def(d)) => Ok(OpBinding::Def { def: d, ctx: c.clone() }),
                Some(Ref::Param { def, index }) => {
                    match c.lookup(CtxKey::Param { def, index }) {
                        Some(Binding::Op(op)) => Ok(op.clone()),
                        _ => Err(eval_err(
                            "E1292",
                            format!(
                                "internal error: operator parameter '{}' is unbound",
                                self.str(*s)
                            ),
                        )),
                    }
                }
                Some(Ref::Const(k)) => match self.const_substs.get(&k) {
                    Some(&d) => Ok(OpBinding::Def { def: d, ctx: c.clone() }),
                    None => Err(eval_err(
                        "E1220",
                        format!(
                            "operator-valued constant '{}' is not assigned by the configuration",
                            self.str(*s)
                        ),
                    )),
                },
                None => Ok(OpBinding::Builtin(*s)),
                Some(_) => Err(eval_err(
                    "E1222",
                    format!("'{}' is not an operator", self.str(*s)),
                )),
            },
            ExprKind::Lambda { .. } => {
                Ok(OpBinding::Lambda { module: m, expr: a, ctx: c.clone() })
            }
            _ => Err(eval_err(
                "E1222",
                "this argument position requires an operator".into(),
            )),
        }
    }

    /// Apply an operator binding to already-evaluated argument values.
    pub(crate) fn apply_op(&self, op: &OpBinding, vals: &[Value], span: Span) -> Result<Value, Diag> {
        match op {
            OpBinding::Def { def, ctx } => {
                if let Some(&n) = self.native_defs.get(def) {
                    return self.call_native(n, vals, span);
                }
                let info = &self.analysis.defs[def.0 as usize];
                match &info.kind {
                    DefKind::Fn { .. } => self.build_fn(*def, ctx),
                    DefKind::Op => {
                        let mut c1 = ctx.clone();
                        for (i, v) in vals.iter().enumerate() {
                            c1 = c1.bind(
                                CtxKey::Param { def: *def, index: i as u32 },
                                Binding::Val(v.clone()),
                            );
                        }
                        let body = self.def_body(*def)?;
                        self.eval(info.module, body, &c1)
                    }
                }
            }
            OpBinding::Lambda { module, expr, ctx } => {
                let ExprKind::Lambda { params, body } = &self.arena(*module).get(*expr).kind
                else {
                    return Err(eval_err("E1294", "internal error: not a LAMBDA".into()));
                };
                let mut c1 = ctx.clone();
                for ((_, psp), v) in params.iter().zip(vals) {
                    let b = self.binder_id(*module, *psp)?;
                    c1 = c1.bind(CtxKey::Binder(b), Binding::Val(v.clone()));
                }
                self.eval(*module, *body, &c1)
            }
            OpBinding::Builtin(s) => {
                let spelling = self.str(*s).to_string();
                match vals.len() {
                    2 => self.builtin_infix_values(&spelling, &vals[0], &vals[1]),
                    1 => self.builtin_prefix_values(&spelling, &vals[0]),
                    _ => Err(eval_err(
                        "E1221",
                        format!("operator '{spelling}' cannot be applied here"),
                    )),
                }
            }
        }
    }

    /// Apply a parameterized constant assignment table (`F(a, b) = v` lines
    /// from the config) to argument values.
    fn apply_cfg_fn(
        &self,
        table: &[(Vec<Value>, Value)],
        vals: &[Value],
        name: &str,
        span: Span,
    ) -> Result<Value, Diag> {
        // TLC 2.19 never applies these tables (its OpRcdValue flows into
        // the state as a raw value and fails at fingerprint time with the
        // error below); reproduce that user-visible failure at application.
        let _ = (vals, name);
        Err(eval_err(
            "E1241",
            format!(
                "TLC has found a state in which the value of a variable contains {}",
                Value::SetEnum(Rc::new(
                    table
                        .iter()
                        .map(|(args, out)| {
                            let mut t = args.clone();
                            t.push(out.clone());
                            Value::tuple(t)
                        })
                        .collect()
                ))
                .display(&self.vctx)
            ),
        )
        .with_span(span))
    }

    /// Force a lazy LET binding (Java `LazyValue`): evaluate in the captured
    /// context; cache only constant-level definitions.
    fn force_lazy(&self, lz: &Rc<LazyDef>) -> Result<Value, Diag> {
        if let Some(v) = lz.cell.borrow().as_ref() {
            return Ok(v.clone());
        }
        let v = match &self.analysis.defs[lz.def.0 as usize].kind {
            DefKind::Op => {
                let body = self.def_body(lz.def)?;
                let module = self.analysis.defs[lz.def.0 as usize].module;
                self.eval(module, body, &lz.ctx)?
            }
            DefKind::Fn { .. } => self.build_fn(lz.def, &lz.ctx)?,
        };
        if self.analysis.def_level(lz.def) == 0 {
            *lz.cell.borrow_mut() = Some(v.clone());
        }
        Ok(v)
    }

    // ---- bound variables (ContextEnumerator odometer) ----------------------

    /// Evaluate the bound domains (in the OUTER context, as `Tool.contexts`
    /// does) and expand them into slots.
    pub(crate) fn slots_for_bounds(&self, m: ModuleId, bounds: &[Bound], c: &Ctx) -> Result<Vec<Slot>, Diag> {
        let mut slots = Vec::new();
        for b in bounds {
            let dom = self.eval(m, b.domain, c)?;
            let elems = Rc::new(dom.expanded_elems(&self.vctx, self.limits.enum_limit)?);
            if b.tuple {
                let mut binders = Vec::with_capacity(b.vars.len());
                for (_, sp) in &b.vars {
                    binders.push(self.binder_id(m, *sp)?);
                }
                slots.push(Slot { bind: SlotBind::Tuple(binders), elems });
            } else {
                for (_, sp) in &b.vars {
                    slots.push(Slot {
                        bind: SlotBind::One(self.binder_id(m, *sp)?),
                        elems: elems.clone(),
                    });
                }
            }
        }
        Ok(slots)
    }

    /// Bind one slot's variable(s) to a domain element.
    pub(crate) fn bind_slot(&self, c: &Ctx, bind: &SlotBind, val: &Value) -> Result<Ctx, Diag> {
        match bind {
            SlotBind::One(b) => Ok(c.bind(CtxKey::Binder(*b), Binding::Val(val.clone()))),
            SlotBind::Tuple(bs) => {
                let elems = val.as_tuple_elems().filter(|e| e.len() == bs.len()).ok_or_else(
                    || {
                        eval_err(
                            "E1223",
                            format!(
                                "Attempted to bind <<x1, ... , x{}>> to a domain element that \
                                 is not an {}-tuple:\n{}",
                                bs.len(),
                                bs.len(),
                                val.display(&self.vctx)
                            ),
                        )
                    },
                )?;
                let mut c1 = c.clone();
                for (b, v) in bs.iter().zip(elems) {
                    c1 = c1.bind(CtxKey::Binder(*b), Binding::Val(v));
                }
                Ok(c1)
            }
        }
    }

    /// Odometer over all slot combinations; `f` returns `false` to stop
    /// early (quantifier short-circuit).
    pub(crate) fn for_each_combo(
        &self,
        slots: &[Slot],
        c: &Ctx,
        _span: Span,
        mut f: impl FnMut(&Ctx) -> Result<bool, Diag>,
    ) -> Result<(), Diag> {
        if slots.iter().any(|s| s.elems.is_empty()) {
            return Ok(());
        }
        let mut idx = vec![0usize; slots.len()];
        loop {
            let mut c1 = c.clone();
            for (k, s) in slots.iter().enumerate() {
                c1 = self.bind_slot(&c1, &s.bind, &s.elems[idx[k]])?;
            }
            if !f(&c1)? {
                return Ok(());
            }
            let mut k = slots.len();
            loop {
                if k == 0 {
                    return Ok(());
                }
                k -= 1;
                idx[k] += 1;
                if idx[k] < slots[k].elems.len() {
                    break;
                }
                idx[k] = 0;
            }
        }
    }

    /// The function-domain element for one slot combination: the element
    /// itself for a single slot, an n-tuple otherwise.
    fn combo_domain_value(slots: &[Slot], idx: &[usize]) -> Value {
        if slots.len() == 1 {
            slots[0].elems[idx[0]].clone()
        } else {
            Value::tuple(
                slots.iter().zip(idx).map(|(s, &i)| s.elems[i].clone()).collect(),
            )
        }
    }

    // ---- CHOOSE ------------------------------------------------------------

    fn eval_choose(
        &self,
        m: ModuleId,
        var: (Sym, Span),
        tuple_vars: &[(Sym, Span)],
        domain: Option<ExprId>,
        body: ExprId,
        c: &Ctx,
    ) -> Result<Value, Diag> {
        let Some(domain) = domain else {
            return Err(eval_err(
                "E1224",
                "TLC attempted to evaluate an unbounded CHOOSE.\nMake sure that the \
                 expression is of form CHOOSE x \\in S: P(x)."
                    .into(),
            ));
        };
        let dval = self.eval(m, domain, c)?;
        // Normalized order makes CHOOSE deterministic (first satisfying
        // element in sorted order), as Java's Ordering.NORMALIZED.
        let elems = dval.expanded_elems(&self.vctx, self.limits.enum_limit)?;
        if tuple_vars.is_empty() {
            let b = self.binder_id(m, var.1)?;
            for elem in elems {
                let c1 = c.bind(CtxKey::Binder(b), Binding::Val(elem.clone()));
                let v = self.eval(m, body, &c1)?;
                if self.expect_bool(&v, "CHOOSE x \\in S: P")? {
                    return Ok(elem);
                }
            }
        } else {
            let mut binders = Vec::with_capacity(tuple_vars.len());
            for (_, sp) in tuple_vars {
                binders.push(self.binder_id(m, *sp)?);
            }
            for elem in elems {
                let parts = elem
                    .as_tuple_elems()
                    .filter(|p| p.len() == binders.len())
                    .ok_or_else(|| {
                        eval_err(
                            "E1225",
                            "Attempted to compute the value of an expression of form\n\
                             CHOOSE <<x1, ... , xN>> \\in S: P, but S was not a set of \
                             N-tuples."
                                .into(),
                        )
                    })?;
                let mut c1 = c.clone();
                for (b, v) in binders.iter().zip(parts) {
                    c1 = c1.bind(CtxKey::Binder(*b), Binding::Val(v));
                }
                let v = self.eval(m, body, &c1)?;
                if self.expect_bool(&v, "CHOOSE <<...>> \\in S: P")? {
                    return Ok(elem);
                }
            }
        }
        Err(eval_err(
            "E1226",
            "Attempted to compute the value of an expression of form\nCHOOSE x \\in S: P, \
             but no element of S satisfied P."
                .into(),
        ))
    }

    // ---- set comprehensions ------------------------------------------------

    fn eval_set_filter(
        &self,
        m: ModuleId,
        e: ExprId,
        bound: &Bound,
        pred: ExprId,
        c: &Ctx,
    ) -> Result<Value, Diag> {
        // Always defer, as Java's SetPredValue does: the predicate runs
        // only on elements whose membership is actually queried (or on all
        // of them if the set is ever normalized/enumerated). Eager
        // filtering would evaluate the predicate on elements Java never
        // touches — observably different when those evaluations error.
        let _ = pred;
        if bound.vars.len() != 1 && !bound.tuple {
            return Err(eval_err(
                "E1227",
                "{x, y \\in S : P} with multiple bound variables is not supported".into(),
            ));
        }
        let domain = self.eval(m, bound.domain, c)?;
        let (s0, s1) = self.snapshot_states();
        Ok(Value::SetPred(Rc::new(LazySetPred {
            module: m,
            expr: e,
            ctx: c.clone(),
            domain,
            s0,
            s1,
        })))
    }

    // ---- functions ---------------------------------------------------------

    /// `[x \in S |-> e]` (and the body of a function definition when
    /// `rec` carries the self-recursion state).
    fn build_fcn_from_slots(
        &self,
        m: ModuleId,
        slots: &[Slot],
        body: ExprId,
        c: &Ctx,
        span: Span,
        rec: Option<&Rc<RecFnState>>,
    ) -> Result<Value, Diag> {
        let mut dom = Vec::new();
        let mut rng = Vec::new();
        let mut idx = vec![0usize; slots.len()];
        if slots.iter().any(|s| s.elems.is_empty()) {
            return Value::fcn_rcd(dom, rng, &self.vctx);
        }
        loop {
            let mut c1 = c.clone();
            if let Some(st) = rec {
                c1 = c1.bind(CtxKey::Binder(st.self_binder), Binding::RecFn(st.clone()));
            }
            for (k, s) in slots.iter().enumerate() {
                c1 = self.bind_slot(&c1, &s.bind, &s.elems[idx[k]])?;
            }
            dom.push(Self::combo_domain_value(slots, &idx));
            rng.push(self.eval(m, body, &c1)?);
            let mut k = slots.len();
            loop {
                if k == 0 {
                    return Value::fcn_rcd(dom, rng, &self.vctx)
                        .map_err(|d| d.with_span(span));
                }
                k -= 1;
                idx[k] += 1;
                if idx[k] < slots[k].elems.len() {
                    break;
                }
                idx[k] = 0;
            }
        }
    }

    /// Evaluate a (possibly recursive) function definition `f[x \in S] == e`
    /// eagerly into a `FcnRcd`, memoizing per-point evaluations so recursive
    /// references (`f[n-1]`) are computed once.
    fn build_fn(&self, d: DefId, c: &Ctx) -> Result<Value, Diag> {
        let info = &self.analysis.defs[d.0 as usize];
        let DefKind::Fn { self_binder, .. } = info.kind else {
            return Err(eval_err("E1295", "internal error: not a function definition".into()));
        };
        let fndef = self.fn_defs.get(&d).copied().ok_or_else(|| {
            eval_err("E1295", "internal error: missing function-definition AST".into())
        })?;
        let slots = match self.try_slots(info.module, &fndef.bounds, c)? {
            Ok(slots) => slots,
            Err(domains) => {
                let (s0, s1) = self.snapshot_states();
                return Ok(Value::FcnLambda(Rc::new(LazyFcn {
                    module: info.module,
                    src: LazyFcnSrc::FnDef(d),
                    ctx: c.clone(),
                    domains,
                    excepts: Vec::new(),
                    s0,
                    s1,
                })));
            }
        };
        let mut dom = Vec::new();
        if !slots.iter().any(|s| s.elems.is_empty()) {
            let mut idx = vec![0usize; slots.len()];
            loop {
                dom.push(Self::combo_domain_value(&slots, &idx));
                let mut k = slots.len();
                let mut done = false;
                loop {
                    if k == 0 {
                        done = true;
                        break;
                    }
                    k -= 1;
                    idx[k] += 1;
                    if idx[k] < slots[k].elems.len() {
                        break;
                    }
                    idx[k] = 0;
                }
                if done {
                    break;
                }
            }
        }
        let n = dom.len();
        let state = Rc::new(RecFnState {
            def: d,
            module: info.module,
            body: fndef.body,
            self_binder,
            slots: slots.iter().map(|s| s.bind.clone()).collect(),
            dom,
            memo: RefCell::new(vec![None; n]),
            base_ctx: c.clone(),
        });
        for i in 0..n {
            self.eval_rec_point(&state, i)?;
        }
        let rng: Vec<Value> =
            state.memo.borrow().iter().map(|v| v.clone().expect("point evaluated")).collect();
        Value::fcn_rcd(state.dom.clone(), rng, &self.vctx)
            .map_err(|d2| d2.with_span(fndef.span))
    }

    /// Evaluate one point of a recursive function, through the memo table.
    fn eval_rec_point(&self, st: &Rc<RecFnState>, i: usize) -> Result<Value, Diag> {
        if let Some(v) = st.memo.borrow()[i].as_ref() {
            return Ok(v.clone());
        }
        let mut c = st
            .base_ctx
            .bind(CtxKey::Binder(st.self_binder), Binding::RecFn(st.clone()));
        c = self.bind_domain_elem(&st.slots, &st.dom[i], &c)?;
        let v = self.eval(st.module, st.body, &c)?;
        st.memo.borrow_mut()[i] = Some(v.clone());
        Ok(v)
    }

    /// One recursion step of a recursive function whose memoized value is
    /// not yet available: evaluate the body in the point's context, keeping
    /// a top-level `[x \in S |-> e]` lazy (see `eval_fn_apply`).
    fn eval_rec_point_lazy(&self, st: &Rc<RecFnState>, i: usize) -> Result<Value, Diag> {
        let mut c = st
            .base_ctx
            .bind(CtxKey::Binder(st.self_binder), Binding::RecFn(st.clone()));
        c = self.bind_domain_elem(&st.slots, &st.dom[i], &c)?;
        if let ExprKind::FnConstructor { bounds, .. } = &self.arena(st.module).get(st.body).kind
        {
            let mut domains = Vec::with_capacity(bounds.len());
            for b in bounds.iter() {
                domains.push(self.eval(st.module, b.domain, &c)?);
            }
            let (s0, s1) = self.snapshot_states();
            return Ok(Value::FcnLambda(Rc::new(LazyFcn {
                module: st.module,
                src: LazyFcnSrc::Constructor(st.body),
                ctx: c,
                domains,
                excepts: Vec::new(),
                s0,
                s1,
            })));
        }
        self.eval(st.module, st.body, &c)
    }

    /// Rebind a function-domain element back onto the slot variables (the
    /// inverse of `combo_domain_value`).
    fn bind_domain_elem(&self, slots: &[SlotBind], val: &Value, c: &Ctx) -> Result<Ctx, Diag> {
        if slots.len() == 1 {
            return self.bind_slot(c, &slots[0], val);
        }
        let parts = val.as_tuple_elems().filter(|p| p.len() == slots.len()).ok_or_else(|| {
            eval_err("E1296", "internal error: malformed function-domain element".into())
        })?;
        let mut c1 = c.clone();
        for (s, v) in slots.iter().zip(&parts) {
            c1 = self.bind_slot(&c1, s, v)?;
        }
        Ok(c1)
    }

    fn eval_fn_apply(
        &self,
        m: ModuleId,
        f: ExprId,
        args: &[ExprId],
        c: &Ctx,
    ) -> Result<Value, Diag> {
        // f[e1, ..., en] means f[<<e1, ..., en>>].
        let argv = if args.len() == 1 {
            self.eval(m, args[0], c)?
        } else {
            Value::tuple(self.eval_args(m, args, c)?)
        };
        // Recursive self-application inside a function definition.
        if let Some(Ref::Binder(b)) = self.analysis.expr_ref(m, f) {
            if let Some(Binding::RecFn(st)) = c.lookup(CtxKey::Binder(b)) {
                let st = st.clone();
                for (i, d) in st.dom.iter().enumerate() {
                    if argv.tla_cmp(d, &self.vctx)? == std::cmp::Ordering::Equal {
                        if let Some(v) = st.memo.borrow()[i].as_ref() {
                            return Ok(v.clone());
                        }
                        // The point is still being computed (or not started):
                        // evaluate its body WITHOUT memoizing, and keep a
                        // top-level function constructor lazy. Java's
                        // recursive-function evaluation stays a
                        // FcnLambdaValue, so `f[i][1]` inside f's own body
                        // evaluates only the applied entry — eager expansion
                        // here would recurse through the whole table forever.
                        return self.eval_rec_point_lazy(&st, i);
                    }
                }
                let name = self.analysis.defs[st.def.0 as usize].name;
                return Err(eval_err(
                    "E1228",
                    format!(
                        "Attempted to apply function:\n{}\nto argument {}, which is not in \
                         the domain of the function.",
                        self.str(name),
                        argv.display(&self.vctx)
                    ),
                ));
            }
        }
        let fv = self.eval(m, f, c)?;
        self.apply_fcn_value(&fv, &argv)
    }

    /// Apply a function-class value (`FcnRcdValue.apply` and the Tuple/
    /// Record specializations); out-of-domain is a user error.
    fn apply_fcn_value(&self, fv: &Value, argv: &Value) -> Result<Value, Diag> {
        let out_of_domain = || {
            eval_err(
                "E1228",
                format!(
                    "Attempted to apply function:\n{}\nto argument {}, which is not in the \
                     domain of the function.",
                    fv.display(&self.vctx),
                    argv.display(&self.vctx)
                ),
            )
        };
        match fv {
            Value::FcnRcd { dom, rng } => {
                for (d, v) in dom.iter().zip(rng.iter()) {
                    if argv.tla_cmp(d, &self.vctx)? == std::cmp::Ordering::Equal {
                        return Ok(v.clone());
                    }
                }
                Err(out_of_domain())
            }
            Value::Tuple(elems) => match argv {
                Value::Int(i) if *i >= 1 && (*i as usize) <= elems.len() => {
                    Ok(elems[(*i - 1) as usize].clone())
                }
                _ => Err(out_of_domain()),
            },
            Value::Record(fields) => match argv {
                Value::Str(s) => fields
                    .iter()
                    .find(|(n, _)| self.str(*n) == self.str(*s))
                    .map(|(_, v)| v.clone())
                    .ok_or_else(out_of_domain),
                _ => Err(out_of_domain()),
            },
            Value::FcnLambda(lf) => match self.lazy_fcn_lookup(lf, argv)? {
                Some(v) => Ok(v),
                None => Err(out_of_domain()),
            },
            _ => Err(eval_err(
                "E1229",
                format!(
                    "A non-function value was applied as a function:\n{}",
                    fv.display(&self.vctx)
                ),
            )),
        }
    }

    fn record_select(&self, v: &Value, name: Sym) -> Result<Value, Diag> {
        let pairs = v.as_record_pairs(&self.vctx).ok_or_else(|| {
            eval_err(
                "E1230",
                format!(
                    "Attempted to select field {} from a non-record value:\n{}",
                    self.str(name),
                    v.display(&self.vctx)
                ),
            )
        })?;
        pairs
            .iter()
            .find(|(n, _)| self.str(*n) == self.str(name))
            .map(|(_, val)| val.clone())
            .ok_or_else(|| {
                eval_err(
                    "E1231",
                    format!(
                        "Attempted to select non-existing field {} from the value:\n{}",
                        self.str(name),
                        v.display(&self.vctx)
                    ),
                )
            })
    }

    // ---- EXCEPT ------------------------------------------------------------

    fn eval_except(
        &self,
        m: ModuleId,
        base: ExprId,
        updates: &[crate::syntax::ast::ExceptUpdate],
        c: &Ctx,
    ) -> Result<Value, Diag> {
        let mut result = self.eval(m, base, c)?;
        for u in updates {
            // Path arcs evaluate in the OUTER context (Tool OPCODE_exc).
            let mut path = Vec::with_capacity(u.path.len());
            for elem in &u.path {
                match elem {
                    ExceptPathElem::Index(idxs) => {
                        if idxs.len() == 1 {
                            path.push(self.eval(m, idxs[0], c)?);
                        } else {
                            path.push(Value::tuple(self.eval_args(m, idxs, c)?));
                        }
                    }
                    ExceptPathElem::Field(name) => path.push(Value::Str(*name)),
                }
            }
            match self.select_path(&result, &path)? {
                None => {
                    // Java warns (TLC_EXCEPT_APPLIED_TO_UNKNOWN_FIELD) and
                    // leaves the value unchanged.
                    self.warnings.borrow_mut().push(format!(
                        "The EXCEPT was applied to non-existing fields of the value:\n{}",
                        result.display(&self.vctx)
                    ));
                }
                Some(old) => {
                    let at = self.binder_id(m, self.arena(m).get(u.value).span)?;
                    let c1 = c.bind(CtxKey::Binder(at), Binding::Val(old));
                    let rhs = self.eval(m, u.value, &c1)?;
                    result = self.replace_path(&result, &path, rhs)?;
                }
            }
        }
        Ok(result)
    }

    /// The current sub-value along `path`, or `None` if the path does not
    /// exist (Java `Value.select`).
    fn select_path(&self, v: &Value, path: &[Value]) -> Result<Option<Value>, Diag> {
        let Some((arc, rest)) = path.split_first() else {
            return Ok(Some(v.clone()));
        };
        let next = match v {
            Value::FcnRcd { dom, rng } => {
                let mut found = None;
                for (d, r) in dom.iter().zip(rng.iter()) {
                    if arc.tla_cmp(d, &self.vctx)? == std::cmp::Ordering::Equal {
                        found = Some(r.clone());
                        break;
                    }
                }
                found
            }
            Value::Tuple(elems) => match arc {
                Value::Int(i) if *i >= 1 && (*i as usize) <= elems.len() => {
                    Some(elems[(*i - 1) as usize].clone())
                }
                _ => None,
            },
            Value::Record(fields) => match arc {
                Value::Str(s) => fields
                    .iter()
                    .find(|(n, _)| self.str(*n) == self.str(*s))
                    .map(|(_, val)| val.clone()),
                _ => None,
            },
            Value::FcnLambda(lf) => self.lazy_fcn_lookup(lf, arc)?,
            _ => None,
        };
        match next {
            Some(nv) => self.select_path(&nv, rest),
            None => Ok(None),
        }
    }

    /// Functionally replace the sub-value along `path` (which is known to
    /// exist) with `rhs` (Java `takeExcept`).
    fn replace_path(&self, v: &Value, path: &[Value], rhs: Value) -> Result<Value, Diag> {
        let Some((arc, rest)) = path.split_first() else {
            return Ok(rhs);
        };
        match v {
            Value::FcnRcd { dom, rng } => {
                let mut new_rng = rng.as_ref().clone();
                for (i, d) in dom.iter().enumerate() {
                    if arc.tla_cmp(d, &self.vctx)? == std::cmp::Ordering::Equal {
                        new_rng[i] = self.replace_path(&rng[i], rest, rhs)?;
                        break;
                    }
                }
                Ok(Value::FcnRcd { dom: dom.clone(), rng: Rc::new(new_rng) })
            }
            Value::Tuple(elems) => {
                let mut new_elems = elems.as_ref().clone();
                if let Value::Int(i) = arc {
                    let idx = (*i - 1) as usize;
                    new_elems[idx] = self.replace_path(&elems[idx], rest, rhs)?;
                }
                Ok(Value::Tuple(Rc::new(new_elems)))
            }
            Value::Record(fields) => {
                let mut new_fields = fields.as_ref().clone();
                if let Value::Str(s) = arc {
                    for (n, val) in new_fields.iter_mut() {
                        if self.str(*n) == self.str(*s) {
                            *val = self.replace_path(val, rest, rhs)?;
                            break;
                        }
                    }
                }
                Ok(Value::Record(Rc::new(new_fields)))
            }
            // A lazy function records the update in its pending-excepts
            // list (FcnLambdaValue.takeExcept).
            Value::FcnLambda(lf) => {
                let cur = self.lazy_fcn_lookup(lf, arc)?.ok_or_else(|| {
                    eval_err(
                        "E1297",
                        "internal error: EXCEPT path selected into a non-existing point".into(),
                    )
                })?;
                let newv = self.replace_path(&cur, rest, rhs)?;
                let mut excepts = lf.excepts.clone();
                excepts.push((arc.clone(), newv));
                Ok(Value::FcnLambda(Rc::new(LazyFcn {
                    module: lf.module,
                    src: lf.src,
                    ctx: lf.ctx.clone(),
                    domains: lf.domains.clone(),
                    excepts,
                    s0: lf.s0.clone(),
                    s1: lf.s1.clone(),
                })))
            }
            _ => Err(eval_err(
                "E1297",
                "internal error: EXCEPT path selected into a non-function".into(),
            )),
        }
    }

    // ---- prefix / infix builtins -------------------------------------------

    fn eval_prefix(
        &self,
        m: ModuleId,
        e: ExprId,
        op: &str,
        a: ExprId,
        c: &Ctx,
    ) -> Result<Value, Diag> {
        // A user/stdlib definition of the operator symbol wins (e.g. `-.`
        // from Integers).
        if let Some(r) = self.analysis.expr_ref(m, e) {
            return self.apply_resolved_op(m, r, &[a], c, self.arena(m).get(e).span);
        }
        match op {
            "\\lnot" => {
                let v = self.eval(m, a, c)?;
                match v {
                    Value::Bool(b) => Ok(Value::Bool(!b)),
                    other => Err(eval_err(
                        "E1232",
                        format!(
                            "Attempted to apply the operator ~ to a non-boolean:\n{}",
                            other.display(&self.vctx)
                        ),
                    )),
                }
            }
            "SUBSET" => {
                let v = self.eval(m, a, c)?;
                Ok(Value::Subset(Rc::new(v)))
            }
            "UNION" => {
                let v = self.eval(m, a, c)?;
                self.union_value(&v)
            }
            "DOMAIN" => {
                let v = self.eval(m, a, c)?;
                self.domain_value(&v)
            }
            "-." => {
                let v = self.eval(m, a, c)?;
                natives::neg(&v, &self.vctx)
            }
            "[]" | "<>" => Err(eval_err(
                "E1207",
                format!("temporal operator '{op}' cannot appear in a constant expression"),
            )),
            "UNCHANGED" => Ok(Value::Bool(self.eval_unchanged_value(m, a, c)?)),
            "ENABLED" => Err(Diag::new(
                Category::Unsupported,
                "U0401",
                "the ENABLED operator is not supported by this engine",
            )),
            _ => Err(eval_err("E1233", format!("operator '{op}' has no definition"))),
        }
    }

    /// A Prefix/Infix/Postfix node whose symbol resolved to a definition,
    /// parameter, etc.: treat the operands as an application.
    fn apply_resolved_op(
        &self,
        m: ModuleId,
        r: Ref,
        args: &[ExprId],
        c: &Ctx,
        span: Span,
    ) -> Result<Value, Diag> {
        match r {
            Ref::Def(d) => {
                match self.def_overrides.get(&d) {
                    Some(Override::Def(t)) => {
                        return self.apply_def_or_native(*t, m, args, c, span)
                    }
                    Some(Override::Fn(table)) => {
                        let table = table.clone();
                        let name =
                            self.str(self.analysis.defs[d.0 as usize].name).to_string();
                        let vals = self.eval_args(m, args, c)?;
                        return self.apply_cfg_fn(&table, &vals, &name, span);
                    }
                    Some(Override::Val(_)) | None => {}
                }
                self.apply_def_or_native(d, m, args, c, span)
            }
            Ref::Param { def, index } => match c.lookup(CtxKey::Param { def, index }) {
                Some(Binding::Op(op)) => {
                    let op = op.clone();
                    let vals = self.eval_args(m, args, c)?;
                    self.apply_op(&op, &vals, span)
                }
                _ => Err(eval_err(
                    "E1292",
                    "internal error: operator parameter is unbound".into(),
                )),
            },
            // A declared infix/prefix/postfix CONSTANT (`CONSTANT _++_`),
            // assigned an operator by the configuration.
            Ref::Const(k) => {
                if let Some(&d) = self.const_substs.get(&k) {
                    return self.apply_def_or_native(d, m, args, c, span);
                }
                if let Some(table) = self.const_fns.get(&k) {
                    let table = table.clone();
                    let name = self.str(self.analysis.consts[k.0 as usize].name).to_string();
                    let vals = self.eval_args(m, args, c)?;
                    return self.apply_cfg_fn(&table, &vals, &name, span);
                }
                Err(eval_err(
                    "E1220",
                    format!(
                        "The constant parameter {} is not assigned a value by the configuration.",
                        self.str(self.analysis.consts[k.0 as usize].name)
                    ),
                ))
            }
            _ => Err(eval_err("E1222", "this operator symbol is not applicable".into())),
        }
    }

    fn eval_infix(
        &self,
        m: ModuleId,
        e: ExprId,
        op: &str,
        l: ExprId,
        r: ExprId,
        c: &Ctx,
    ) -> Result<Value, Diag> {
        // User/stdlib definitions of the operator symbol win (stdlib `+`,
        // a spec's `\oplus`, a formal parameter `_ \prec _`).
        if let Some(rf) = self.analysis.expr_ref(m, e) {
            return self.apply_resolved_op(m, rf, &[l, r], c, self.arena(m).get(e).span);
        }
        match op {
            // Short-circuiting boolean operators (Tool OPCODE_land etc.).
            "\\land" => {
                let lv = self.eval(m, l, c)?;
                if !self.expect_bool(&lv, "P /\\ Q")? {
                    return Ok(Value::Bool(false));
                }
                let rv = self.eval(m, r, c)?;
                self.expect_bool(&rv, "P /\\ Q")?;
                Ok(rv)
            }
            "\\lor" => {
                let lv = self.eval(m, l, c)?;
                if self.expect_bool(&lv, "P \\/ Q")? {
                    return Ok(Value::Bool(true));
                }
                let rv = self.eval(m, r, c)?;
                self.expect_bool(&rv, "P \\/ Q")?;
                Ok(rv)
            }
            "=>" => {
                let lv = self.eval(m, l, c)?;
                if !self.expect_bool(&lv, "P => Q")? {
                    return Ok(Value::Bool(true));
                }
                let rv = self.eval(m, r, c)?;
                self.expect_bool(&rv, "P => Q")?;
                Ok(rv)
            }
            // `s \in Seq(S)` without materializing Seq(S).
            "\\in" | "\\notin" => {
                if let Some(range) = self.seq_set_arg(m, r, c)? {
                    let lv = self.eval(m, l, c)?;
                    let mut member = natives::seq_member(&lv, &range, &self.vctx)?;
                    if op == "\\notin" {
                        member = !member;
                    }
                    return Ok(Value::Bool(member));
                }
                let lv = self.eval(m, l, c)?;
                let rv = self.eval(m, r, c)?;
                self.builtin_infix_values(op, &lv, &rv)
            }
            _ => {
                let lv = self.eval(m, l, c)?;
                let rv = self.eval(m, r, c)?;
                self.builtin_infix_values(op, &lv, &rv)
            }
        }
    }

    /// If `e` is (parenthesized) `Seq(S)`, evaluate and return `S`.
    fn seq_set_arg(&self, m: ModuleId, e: ExprId, c: &Ctx) -> Result<Option<Value>, Diag> {
        let mut cur = e;
        loop {
            match &self.arena(m).get(cur).kind {
                ExprKind::Paren(inner) => cur = *inner,
                ExprKind::Apply(_, _, args) if args.len() == 1 => {
                    if let Some(Ref::Def(d)) = self.analysis.expr_ref(m, cur) {
                        if self.native_defs.get(&d) == Some(&Native::SeqSet) {
                            return Ok(Some(self.eval(m, args[0], c)?));
                        }
                    }
                    return Ok(None);
                }
                _ => return Ok(None),
            }
        }
    }

    /// Should a set operation with this operand stay symbolic? (The
    /// operand cannot be enumerated within the evaluator's limit.)
    fn lazy_set_operand(&self, v: &Value) -> bool {
        match v.set_card(&self.vctx) {
            Ok(card) => card > self.limits.enum_limit as i128,
            Err(e) => e.code == "E1107" || e.code == "E1198",
        }
    }

    /// Value-level builtin binary operators (also used for higher-order
    /// builtin arguments and nonfix application).
    fn builtin_infix_values(&self, op: &str, l: &Value, r: &Value) -> Result<Value, Diag> {
        let ctx = &self.vctx;
        match op {
            "=" => Ok(Value::Bool(l.tla_eq(r, ctx)?)),
            "/=" => Ok(Value::Bool(!l.tla_eq(r, ctx)?)),
            "\\in" => Ok(Value::Bool(self.value_member(r, l)?)),
            "\\notin" => Ok(Value::Bool(!self.value_member(r, l)?)),
            "\\subseteq" => Ok(Value::Bool(self.subseteq(l, r)?)),
            "\\subset" => {
                Ok(Value::Bool(self.subseteq(l, r)? && !l.tla_eq(r, ctx)?))
            }
            "\\supseteq" => Ok(Value::Bool(self.subseteq(r, l)?)),
            "\\supset" => {
                Ok(Value::Bool(self.subseteq(r, l)? && !l.tla_eq(r, ctx)?))
            }
            "\\union" => {
                if self.lazy_set_operand(l) || self.lazy_set_operand(r) {
                    // Java's SetCupValue: keep the union symbolic when a side
                    // cannot be enumerated (Int \cup Nat).
                    return Ok(Value::SetCup(Rc::new(l.clone()), Rc::new(r.clone())));
                }
                let mut elems = l.expanded_elems(ctx, self.limits.enum_limit)?;
                elems.extend(r.expanded_elems(ctx, self.limits.enum_limit)?);
                Value::set_enum(elems, ctx)
            }
            "\\intersect" => {
                if self.lazy_set_operand(l) {
                    // Java SetCapValue: symbolic when a side cannot be
                    // enumerated.
                    return Ok(Value::SetCap(Rc::new(l.clone()), Rc::new(r.clone())));
                }
                let mut kept = Vec::new();
                for e in l.expanded_elems(ctx, self.limits.enum_limit)? {
                    if self.value_member(r, &e)? {
                        kept.push(e);
                    }
                }
                Ok(Value::SetEnum(Rc::new(kept)))
            }
            "\\" => {
                if self.lazy_set_operand(l) {
                    // Java SetDiffValue.
                    return Ok(Value::SetDiff(Rc::new(l.clone()), Rc::new(r.clone())));
                }
                let mut kept = Vec::new();
                for e in l.expanded_elems(ctx, self.limits.enum_limit)? {
                    if !self.value_member(r, &e)? {
                        kept.push(e);
                    }
                }
                Ok(Value::SetEnum(Rc::new(kept)))
            }
            "\\land" | "\\lor" | "=>" | "\\equiv" => {
                let (form, lb, rb) = match op {
                    "\\land" => ("P /\\ Q", l, r),
                    "\\lor" => ("P \\/ Q", l, r),
                    "=>" => ("P => Q", l, r),
                    _ => ("P <=> Q", l, r),
                };
                let lv = self.expect_bool(lb, form)?;
                let rv = self.expect_bool(rb, form)?;
                Ok(Value::Bool(match op {
                    "\\land" => lv && rv,
                    "\\lor" => lv || rv,
                    "=>" => !lv || rv,
                    _ => lv == rv,
                }))
            }
            "~>" | "-+->" => Err(eval_err(
                "E1207",
                format!("temporal operator '{op}' cannot appear in a constant expression"),
            )),
            "\\cdot" => Err(eval_err(
                "E1205",
                "action composition (\\cdot) cannot appear in a constant expression".into(),
            )),
            _ => match natives::native_of_spelling(op) {
                Some(n) => self.call_native2(n, l, r),
                None => {
                    Err(eval_err("E1233", format!("operator '{op}' has no definition")))
                }
            },
        }
    }

    fn builtin_prefix_values(&self, op: &str, v: &Value) -> Result<Value, Diag> {
        match op {
            "\\lnot" => match v {
                Value::Bool(b) => Ok(Value::Bool(!b)),
                other => Err(eval_err(
                    "E1232",
                    format!(
                        "Attempted to apply the operator ~ to a non-boolean:\n{}",
                        other.display(&self.vctx)
                    ),
                )),
            },
            "-." | "-" => natives::neg(v, &self.vctx),
            "SUBSET" => Ok(Value::Subset(Rc::new(v.clone()))),
            "UNION" => self.union_value(v),
            "DOMAIN" => self.domain_value(v),
            _ => Err(eval_err("E1233", format!("operator '{op}' has no definition"))),
        }
    }

    /// `UNION S` — expand the set of sets and merge (Java `UnionValue.union`).
    fn union_value(&self, v: &Value) -> Result<Value, Diag> {
        let mut all = Vec::new();
        for s in v.expanded_elems(&self.vctx, self.limits.enum_limit)? {
            all.extend(s.expanded_elems(&self.vctx, self.limits.enum_limit).map_err(|_| {
                eval_err(
                    "E1234",
                    format!(
                        "Attempted to compute the value of UNION S when some element of S \
                         is not an enumerable set:\n{}",
                        s.display(&self.vctx)
                    ),
                )
            })?);
        }
        Value::set_enum(all, &self.vctx)
    }

    /// `DOMAIN f` for the three function representations.
    fn domain_value(&self, v: &Value) -> Result<Value, Diag> {
        match v {
            Value::FcnRcd { dom, .. } => Ok(Value::SetEnum(dom.clone())),
            Value::FcnLambda(lf) => {
                let (bounds, _) = self.lazy_fcn_src(lf)?;
                let mut per_slot: Vec<Value> = Vec::new();
                for (b, dom) in bounds.iter().zip(&lf.domains) {
                    if b.tuple {
                        per_slot.push(dom.clone());
                    } else {
                        for _ in &b.vars {
                            per_slot.push(dom.clone());
                        }
                    }
                }
                if per_slot.len() == 1 {
                    Ok(per_slot.pop().expect("one slot"))
                } else {
                    Ok(Value::SetOfTuples(Rc::new(per_slot)))
                }
            }
            Value::Tuple(elems) => Ok(Value::interval(1, elems.len() as i64)),
            Value::Record(fields) => Ok(Value::SetEnum(Rc::new(
                fields.iter().map(|(n, _)| Value::Str(*n)).collect(),
            ))),
            _ => Err(eval_err(
                "E1235",
                format!(
                    "Attempted to apply the operator DOMAIN to a non-function:\n{}",
                    v.display(&self.vctx)
                ),
            )),
        }
    }

    /// `S \subseteq T` — S must be enumerable (Tool OPCODE_subseteq).
    fn subseteq(&self, l: &Value, r: &Value) -> Result<bool, Diag> {
        // `SUBSET A \subseteq SUBSET B` reduces to `A \subseteq B`
        // (SubsetValue.isSubsetEq), avoiding the power-set blowup.
        if let (Value::Subset(a), Value::Subset(b)) = (l, r) {
            return self.subseteq(a, b);
        }
        // Interval-vs-interval by bounds (IntervalValue.isSubsetEq).
        if let (&Value::Interval { lo, hi }, &Value::Interval { lo: lo2, hi: hi2 }) = (l, r) {
            if lo2 <= lo && hi2 >= hi {
                return Ok(true);
            }
        }
        for e in l.expanded_elems(&self.vctx, self.limits.enum_limit)? {
            if !self.value_member(r, &e)? {
                return Ok(false);
            }
        }
        Ok(true)
    }

    /// Expand lazy predicate sets before printing, as Java's `Print`/`PrintT`
    /// do via `toStringUnchecked` (SetPredValue.toString converts to a
    /// SetEnumValue with `swallow=false`, so predicate-evaluation errors
    /// propagate instead of being discarded).
    fn expand_for_print(&self, v: &Value) -> Result<Value, Diag> {
        use crate::value::LazyEval;
        Ok(match v {
            Value::SetPred(sp) => {
                let elems = self.set_pred_elems(sp, &self.vctx, self.limits.enum_limit)?;
                let elems = elems
                    .iter()
                    .map(|e| self.expand_for_print(e))
                    .collect::<Result<Vec<_>, _>>()?;
                Value::set_enum(elems, &self.vctx)?
            }
            Value::SetEnum(items) => Value::SetEnum(Rc::new(
                items.iter().map(|e| self.expand_for_print(e)).collect::<Result<_, _>>()?,
            )),
            Value::Tuple(items) => Value::Tuple(Rc::new(
                items.iter().map(|e| self.expand_for_print(e)).collect::<Result<_, _>>()?,
            )),
            Value::Record(fields) => Value::Record(Rc::new(
                fields
                    .iter()
                    .map(|(n, e)| Ok((*n, self.expand_for_print(e)?)))
                    .collect::<Result<Vec<_>, Diag>>()?,
            )),
            Value::FcnRcd { dom, rng } => Value::FcnRcd {
                dom: Rc::new(
                    dom.iter().map(|e| self.expand_for_print(e)).collect::<Result<_, _>>()?,
                ),
                rng: Rc::new(
                    rng.iter().map(|e| self.expand_for_print(e)).collect::<Result<_, _>>()?,
                ),
            },
            _ => v.clone(),
        })
    }

    // ---- natives -----------------------------------------------------------

    fn call_native2(&self, n: Native, a: &Value, b: &Value) -> Result<Value, Diag> {
        let ctx = &self.vctx;
        match n {
            Native::Plus => natives::plus(a, b, ctx),
            Native::Minus => natives::minus(a, b, ctx),
            Native::Times => natives::times(a, b, ctx),
            Native::Expt => natives::expt(a, b, ctx),
            Native::Lt => natives::lt(a, b, ctx),
            Native::Leq => natives::leq(a, b, ctx),
            Native::Gt => natives::gt(a, b, ctx),
            Native::Geq => natives::geq(a, b, ctx),
            Native::DotDot => natives::dotdot(a, b, ctx),
            Native::Divide => natives::divide(a, b, ctx),
            Native::Mod => natives::modulo(a, b, ctx),
            Native::Concat => natives::concat(a, b, ctx),
            Native::Append => natives::append(a, b, ctx),
            Native::MakeFcn => natives::make_fcn(a, b, ctx),
            Native::CombineFcn => natives::combine_fcn(a, b, ctx),
            Native::Assert => natives::assert_native(a, b, ctx),
            Native::Print => {
                let (pa, pb) = (self.expand_for_print(a)?, self.expand_for_print(b)?);
                self.printed
                    .borrow_mut()
                    .push(format!("{}  {}", pa.display(ctx), pb.display(ctx)));
                Ok(b.clone())
            }
            _ => Err(eval_err("E1298", "internal error: native arity mismatch".into())),
        }
    }

    /// `SortSeq(s, Op)` / `SelectSeq(s, Test)` — higher-order sequence
    /// natives (`tlc2/module/TLC.SortSeq`: a stable insertion sort driven by
    /// the comparator, and `Sequences.SelectSeq`).
    fn call_seq_native(
        &self,
        n: Native,
        sv: &Value,
        op: &OpBinding,
        span: Span,
    ) -> Result<Value, Diag> {
        let name = if n == Native::SortSeq { "SortSeq" } else { "SelectSeq" };
        let elems = sv.as_tuple_elems().ok_or_else(|| {
            eval_err(
                "E1301",
                format!(
                    "The first argument of {} should be a sequence, but instead it is:\n{}",
                    name,
                    sv.display(&self.vctx)
                ),
            )
            .with_span(span)
        })?;
        match n {
            Native::SortSeq => {
                let mut sorted: Vec<Value> = Vec::with_capacity(elems.len());
                for e in elems {
                    // Insertion sort exactly as Java: move left while
                    // Op(new, existing) holds.
                    let mut j = sorted.len();
                    while j > 0 {
                        let r = self.apply_op(op, &[e.clone(), sorted[j - 1].clone()], span)?;
                        if self.expect_bool(&r, "SortSeq comparator")? {
                            j -= 1;
                        } else {
                            break;
                        }
                    }
                    sorted.insert(j, e);
                }
                Ok(Value::tuple(sorted))
            }
            _ => {
                let mut kept = Vec::new();
                for e in elems {
                    let r = self.apply_op(op, &[e.clone()], span)?;
                    if self.expect_bool(&r, "SelectSeq test")? {
                        kept.push(e);
                    }
                }
                Ok(Value::tuple(kept))
            }
        }
    }

    /// `Permutations(S)` — the set of bijections S -> S
    /// (`tlc2/module/TLC.Permutations`).
    fn permutations(&self, s: &Value, span: Span) -> Result<Value, Diag> {
        let dom = s.expanded_elems(&self.vctx, self.limits.enum_limit).map_err(|d| {
            d.note("while evaluating Permutations", Some(span))
        })?;
        let n = dom.len();
        if n == 0 {
            let empty = Value::FcnRcd { dom: Rc::new(vec![]), rng: Rc::new(vec![]) };
            return Value::set_enum(vec![empty], &self.vctx);
        }
        if n > 8 {
            return Err(eval_err(
                "E1108",
                format!("Attempted to enumerate Permutations of a set with {n} elements."),
            )
            .with_span(span));
        }
        let dom = Rc::new(dom);
        let mut fcns = Vec::new();
        let mut idx: Vec<usize> = (0..n).collect();
        loop {
            let vals: Vec<Value> = idx.iter().map(|&i| dom[i].clone()).collect();
            fcns.push(Value::FcnRcd { dom: dom.clone(), rng: Rc::new(vals) });
            // Next lexicographic permutation.
            let Some(i) = (0..n - 1).rev().find(|&i| idx[i] < idx[i + 1]) else {
                break;
            };
            let j = (i + 1..n).rev().find(|&j| idx[j] > idx[i]).expect("successor exists");
            idx.swap(i, j);
            idx[i + 1..].reverse();
        }
        Value::set_enum(fcns, &self.vctx)
    }

    fn call_native(&self, n: Native, args: &[Value], span: Span) -> Result<Value, Diag> {
        let ctx = &self.vctx;
        let unsupported = |what: &str| {
            Err(eval_err(
                "E1236",
                format!("{what} is not supported in constant expressions"),
            )
            .with_span(span))
        };
        match (n, args) {
            (Native::NatSet, []) => Ok(Value::NatSet),
            (Native::IntSet, []) => Ok(Value::IntSet),
            (Native::JavaTime, []) => unsupported("JavaTime"),
            (Native::Any, []) => unsupported("Any"),
            (Native::Neg, [a]) => natives::neg(a, ctx),
            (Native::Len, [a]) => natives::len(a, ctx),
            (Native::Head, [a]) => natives::head(a, ctx),
            (Native::Tail, [a]) => natives::tail(a, ctx),
            (Native::Cardinality, [a]) => natives::cardinality(a, ctx),
            (Native::IsFiniteSet, [a]) => natives::is_finite_set(a, ctx),
            (Native::PrintT, [a]) => {
                let pa = self.expand_for_print(a)?;
                self.printed.borrow_mut().push(pa.display(ctx));
                Ok(Value::Bool(true))
            }
            (Native::ToString, [_]) => unsupported("ToString"),
            (Native::RandomElement, [_]) => Err(Diag::new(
                Category::Unsupported,
                "U0402",
                "RandomElement is not supported by this engine (nondeterministic)",
            )
            .with_span(span)),
            (Native::TLCGet, [k]) => match k {
                Value::Int(_) => {
                    for (key, val) in self.tlc_registers.borrow().iter() {
                        if key.tla_eq(k, ctx)? {
                            return Ok(val.clone());
                        }
                    }
                    Err(eval_err(
                        "E1243",
                        format!("TLCGet({}): the register has no value.", k.display(ctx)),
                    )
                    .with_span(span))
                }
                _ => Err(Diag::new(
                    Category::Unsupported,
                    "U0403",
                    format!(
                        "TLCGet({}) is not supported (only integer registers)",
                        k.display(ctx)
                    ),
                )
                .with_span(span)),
            },
            (Native::TLCSet, [k, v]) => match k {
                Value::Int(_) => {
                    let mut regs = self.tlc_registers.borrow_mut();
                    let mut found = false;
                    for (key, val) in regs.iter_mut() {
                        if matches!((&*key, k), (Value::Int(a), Value::Int(b)) if a == b) {
                            *val = v.clone();
                            found = true;
                            break;
                        }
                    }
                    if !found {
                        regs.push((k.clone(), v.clone()));
                    }
                    Ok(Value::Bool(true))
                }
                _ => Err(Diag::new(
                    Category::Unsupported,
                    "U0403",
                    format!(
                        "TLCSet({}, _) is not supported (only integer registers)",
                        k.display(ctx)
                    ),
                )
                .with_span(span)),
            },
            (Native::Permutations, [s]) => self.permutations(s, span),
            (Native::IsABag, [a]) => natives::is_a_bag(a, ctx),
            (Native::SeqSet, [a]) => Ok(Value::SeqSet(Rc::new(a.clone()))),
            (Native::SubSeq, [s, m1, n1]) => natives::subseq(s, m1, n1, ctx),
            (n2, [a, b]) => self.call_native2(n2, a, b),
            _ => Err(eval_err("E1298", "internal error: native arity mismatch".into())
                .with_span(span)),
        }
    }
}

impl crate::value::LazyEval for Evaluator<'_> {
    fn set_pred_member(
        &self,
        sp: &LazySetPred,
        elem: &Value,
        _ctx: &ValueCtx,
    ) -> Result<bool, Diag> {
        if !self.value_member(&sp.domain, elem)? {
            return Ok(false);
        }
        let (r, _, _) = self.with_states(sp.s0.clone(), sp.s1.clone(), || {
            let ExprKind::SetFilter { bound, pred } = &self.arena(sp.module).get(sp.expr).kind
            else {
                return Err(eval_err(
                    "E1299",
                    "internal error: SetPred without a set-filter node".into(),
                ));
            };
            let sb = if bound.tuple {
                let mut binders = Vec::with_capacity(bound.vars.len());
                for (_, spn) in &bound.vars {
                    binders.push(self.binder_id(sp.module, *spn)?);
                }
                SlotBind::Tuple(binders)
            } else {
                SlotBind::One(self.binder_id(sp.module, bound.vars[0].1)?)
            };
            let c1 = self.bind_slot(&sp.ctx, &sb, elem)?;
            let v = self.eval(sp.module, *pred, &c1)?;
            self.expect_bool(&v, "{x \\in S : P}")
        });
        r
    }

    fn set_pred_elems(
        &self,
        sp: &LazySetPred,
        ctx: &ValueCtx,
        limit: usize,
    ) -> Result<Vec<Value>, Diag> {
        let elems = sp.domain.expanded_elems(&self.vctx, limit).map_err(|d| {
            if d.code == "E1107" {
                eval_err(
                    "E1107",
                    format!(
                        "Attempted to enumerate {{ x \\in S : p(x) }} when S:\n{}\nis not                          enumerable.",
                        sp.domain.display(ctx)
                    ),
                )
            } else {
                d
            }
        })?;
        let mut kept = Vec::new();
        for e in elems {
            if self.set_pred_member(sp, &e, ctx)? {
                kept.push(e);
            }
        }
        Ok(kept)
    }
}

fn span_key(m: ModuleId, s: Span) -> (u32, u32, u32, u32, u32) {
    (m.0, s.start.line, s.start.col, s.end.line, s.end.col)
}
