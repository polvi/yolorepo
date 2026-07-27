//! Spec wiring — the analog of `tlc2/tool/impl/SpecProcessor`: binds the
//! configuration's CONSTANT assignments, decomposes `SPECIFICATION Spec`
//! into init predicates + the next-state action, and compiles INVARIANT /
//! PROPERTY / CONSTRAINT names into checkable predicates.

use std::rc::Rc;

use crate::cfg::{CfgValue, Config, ConstantBinding};
use crate::diag::{Category, Diag};
use crate::eval::action::Pred;
use crate::eval::context::Ctx;
use crate::eval::eval::{Evaluator, Override};
use crate::intern::{Interner, Sym};
use crate::sem::{Analysis, ModuleId, Ref};
use crate::syntax::ast::{ExprId, ExprKind, JunctionKind, QuantKind, SubscriptKind, Unit};
use crate::value::{Value, ValueCtx};

/// Everything the checker needs to run, compiled from `Analysis` + `Config`.
pub struct CompiledSpec {
    pub init: Vec<Pred>,
    pub next: Option<Pred>,
    pub invariants: Vec<Pred>,
    /// State-level PROPERTY formulas — checked on initial states only, as
    /// Java's implied-inits.
    pub implied_inits: Vec<Pred>,
    /// `[][A]_v` PROPERTY formulas — the stored expr is the `[A]_v` node,
    /// checked on every transition.
    pub implied_actions: Vec<Pred>,
    pub constraints: Vec<Pred>,
    pub action_constraints: Vec<Pred>,
    pub check_deadlock: bool,
}

fn cfg_err(code: &'static str, msg: String) -> Diag {
    Diag::new(Category::Config, code, msg)
}

// ---- constant binding (phase 1: needs &mut Interner for model values) ------

/// Raw constant-binding targets resolved by name, with values built while
/// the interner is still mutable (sets not yet normalized).
pub struct RawBindings {
    consts: Vec<(u32, Value)>,
    const_substs: Vec<(u32, Sym)>,
    const_fns: Vec<(u32, Vec<(Vec<Value>, Value)>)>,
    def_vals: Vec<(u32, Value)>,
    def_substs: Vec<(u32, Sym)>,
    def_fns: Vec<(u32, Vec<(Vec<Value>, Value)>)>,
}

/// Convert a config value; sets are built unnormalized (normalized in
/// [`apply_bindings`], once a `ValueCtx` exists).
fn cfg_value(v: &CfgValue, interner: &mut Interner) -> Value {
    match v {
        CfgValue::Int(i) => Value::Int(*i),
        CfgValue::Str(s) => Value::Str(*s),
        CfgValue::Bool(b) => Value::Bool(*b),
        CfgValue::Model(s) => {
            let name = interner.str(*s).to_string();
            Value::model(&name, interner)
        }
        CfgValue::Set(items) => {
            let vals: Vec<Value> = items.iter().map(|x| cfg_value(x, interner)).collect();
            Value::SetEnum(Rc::new(vals)) // unnormalized; fixed later
        }
    }
}

/// Re-normalize any sets inside a raw config value.
fn normalize(v: &Value, ctx: &ValueCtx) -> Result<Value, Diag> {
    match v {
        Value::SetEnum(items) => {
            let vals: Result<Vec<Value>, Diag> = items.iter().map(|x| normalize(x, ctx)).collect();
            Value::set_enum(vals?, ctx)
        }
        other => Ok(other.clone()),
    }
}

/// Resolve the config's CONSTANT section against the analysis by name.
/// Unknown names are silently ignored (Java TLC accepts config constants the
/// spec never declares).
pub fn bind_constants(
    analysis: &Analysis,
    cfg: &Config,
    interner: &mut Interner,
) -> Result<RawBindings, Diag> {
    let root_exports = &analysis.module(analysis.root).exports;
    let find_const = |name: Sym| -> Option<u32> {
        analysis.consts.iter().position(|k| k.name == name).map(|i| i as u32)
    };
    let find_def = |name: Sym| -> Option<u32> {
        match root_exports.get(&name) {
            Some(Ref::Def(d)) => Some(d.0),
            _ => analysis
                .defs
                .iter()
                .position(|d| d.name == name && !d.local)
                .map(|i| i as u32),
        }
    };
    let mut raw = RawBindings {
        consts: Vec::new(),
        const_substs: Vec::new(),
        const_fns: Vec::new(),
        def_vals: Vec::new(),
        def_substs: Vec::new(),
        def_fns: Vec::new(),
    };
    for b in &cfg.constants {
        match b {
            ConstantBinding::Assign { name, value, .. } => {
                let v = cfg_value(value, interner);
                if let Some(k) = find_const(*name) {
                    raw.consts.push((k, v));
                } else if let Some(d) = find_def(*name) {
                    raw.def_vals.push((d, v));
                }
            }
            ConstantBinding::Subst { name, op, .. } => {
                if let Some(k) = find_const(*name) {
                    raw.const_substs.push((k, *op));
                } else if let Some(d) = find_def(*name) {
                    raw.def_substs.push((d, *op));
                }
            }
            ConstantBinding::AssignFn { name, args, value, .. } => {
                let argv: Vec<Value> = args.iter().map(|a| cfg_value(a, interner)).collect();
                let val = cfg_value(value, interner);
                if let Some(k) = find_const(*name) {
                    match raw.const_fns.iter_mut().find(|(k2, _)| *k2 == k) {
                        Some((_, table)) => table.push((argv, val)),
                        None => raw.const_fns.push((k, vec![(argv, val)])),
                    }
                } else if let Some(d) = find_def(*name) {
                    match raw.def_fns.iter_mut().find(|(d2, _)| *d2 == d) {
                        Some((_, table)) => table.push((argv, val)),
                        None => raw.def_fns.push((d, vec![(argv, val)])),
                    }
                }
            }
        }
    }
    Ok(raw)
}

/// Install the resolved bindings into the evaluator (phase 2), normalizing
/// set values, and verify every declared constant is assigned.
pub fn apply_bindings(ev: &mut Evaluator, raw: &RawBindings) -> Result<(), Diag> {
    let lookup_op = |ev: &Evaluator, op: Sym| -> Result<crate::sem::DefId, Diag> {
        let root_exports = &ev.analysis.module(ev.analysis.root).exports;
        match root_exports.get(&op) {
            Some(Ref::Def(d)) => Ok(*d),
            _ => Err(cfg_err(
                "C0012",
                format!(
                    "the operator {} substituted with <- is not defined in the specification",
                    ev.vctx.interner.str(op)
                ),
            )),
        }
    };
    for (k, v) in &raw.consts {
        let v = normalize(v, &ev.vctx)?;
        ev.const_values.insert(crate::sem::ConstId(*k), v);
    }
    for (k, op) in &raw.const_substs {
        let d = lookup_op(ev, *op)?;
        ev.const_substs.insert(crate::sem::ConstId(*k), d);
    }
    for (k, table) in &raw.const_fns {
        let mut t = Vec::with_capacity(table.len());
        for (args, val) in table {
            let args: Result<Vec<Value>, Diag> =
                args.iter().map(|a| normalize(a, &ev.vctx)).collect();
            t.push((args?, normalize(val, &ev.vctx)?));
        }
        ev.const_fns.insert(crate::sem::ConstId(*k), Rc::new(t));
    }
    for (d, v) in &raw.def_vals {
        let v = normalize(v, &ev.vctx)?;
        ev.def_overrides.insert(crate::sem::DefId(*d), Override::Val(v));
    }
    for (d, op) in &raw.def_substs {
        let target = lookup_op(ev, *op)?;
        ev.def_overrides.insert(crate::sem::DefId(*d), Override::Def(target));
    }
    for (d, table) in &raw.def_fns {
        let mut t = Vec::with_capacity(table.len());
        for (args, val) in table {
            let args: Result<Vec<Value>, Diag> =
                args.iter().map(|a| normalize(a, &ev.vctx)).collect();
            t.push((args?, normalize(val, &ev.vctx)?));
        }
        ev.def_overrides.insert(crate::sem::DefId(*d), Override::Fn(Rc::new(t)));
    }
    // Every declared constant must now have a binding.
    for (i, k) in ev.analysis.consts.iter().enumerate() {
        let id = crate::sem::ConstId(i as u32);
        if !ev.const_values.contains_key(&id)
            && !ev.const_substs.contains_key(&id)
            && !ev.const_fns.contains_key(&id)
        {
            return Err(cfg_err(
                "C0013",
                format!(
                    "The constant parameter {} is not assigned a value by the configuration \
                     file.",
                    ev.vctx.interner.str(k.name)
                ),
            )
            .with_span(k.span));
        }
    }
    Ok(())
}

/// Evaluate every ASSUME of the module closure; a false assumption or an
/// evaluation error aborts checking (Java evaluates assumptions once after
/// constant processing).
pub fn check_assumptions(ev: &Evaluator) -> Result<(), Diag> {
    for (mi, module) in ev.analysis.modules.iter().enumerate() {
        let m = ModuleId(mi as u32);
        for u in &module.source.module.units {
            if let Unit::Assume { expr, .. } = u {
                let v = ev.eval(m, *expr, &Ctx::empty())?;
                match v {
                    Value::Bool(true) => {}
                    Value::Bool(false) => {
                        return Err(Diag::new(
                            Category::Eval,
                            "E1250",
                            "Assumption is false.",
                        )
                        .with_span(module.source.arena.get(*expr).span));
                    }
                    other => {
                        return Err(Diag::new(
                            Category::Eval,
                            "E1250",
                            format!(
                                "Assumption evaluated to a non-boolean:\n{}",
                                other.display(&ev.vctx)
                            ),
                        )
                        .with_span(module.source.arena.get(*expr).span));
                    }
                }
            }
        }
    }
    Ok(())
}

// ---- spec compilation ------------------------------------------------------

pub fn compile(ev: &Evaluator, cfg: &Config) -> Result<CompiledSpec, Diag> {
    let mut spec = CompiledSpec {
        init: Vec::new(),
        next: None,
        invariants: Vec::new(),
        implied_inits: Vec::new(),
        implied_actions: Vec::new(),
        constraints: Vec::new(),
        action_constraints: Vec::new(),
        check_deadlock: cfg.check_deadlock.unwrap_or(true),
    };

    let lookup = |name: Sym, what: &str| -> Result<crate::sem::DefId, Diag> {
        match ev.analysis.module(ev.analysis.root).exports.get(&name) {
            Some(Ref::Def(d)) => {
                let info = &ev.analysis.defs[d.0 as usize];
                if info.arity != 0 {
                    return Err(cfg_err(
                        "C0014",
                        format!(
                            "The {} {} requires arguments and cannot be used in the \
                             configuration.",
                            what,
                            ev.vctx.interner.str(name)
                        ),
                    ));
                }
                Ok(*d)
            }
            _ => Err(cfg_err(
                "C0015",
                format!(
                    "The {} {} specified in the configuration file is not defined in the \
                     specification.",
                    what,
                    ev.vctx.interner.str(name)
                ),
            )),
        }
    };
    let pred_of = |d: crate::sem::DefId| -> Result<Pred, Diag> {
        let info = &ev.analysis.defs[d.0 as usize];
        let body = info.body.ok_or_else(|| {
            cfg_err(
                "C0016",
                format!("definition {} has no body", ev.vctx.interner.str(info.name)),
            )
        })?;
        Ok(Pred {
            name: ev.vctx.interner.str(info.name).to_string(),
            module: info.module,
            expr: body,
            ctx: Ctx::empty(),
        })
    };

    // INIT / NEXT or SPECIFICATION decomposition.
    if let Some((name, _)) = cfg.init {
        let d = lookup(name, "init predicate")?;
        spec.init.push(pred_of(d)?);
    }
    if let Some((name, _)) = cfg.next {
        let d = lookup(name, "next-state relation")?;
        spec.next = Some(pred_of(d)?);
    }
    if let Some((name, _)) = cfg.spec {
        let d = lookup(name, "specification")?;
        let info = &ev.analysis.defs[d.0 as usize];
        let body = info.body.ok_or_else(|| {
            cfg_err("C0016", format!("definition {} has no body", ev.vctx.interner.str(name)))
        })?;
        process_spec(ev, &mut spec, info.module, body, &Ctx::empty())?;
    }

    // Invariants: state predicates only.
    for (name, span) in &cfg.invariants {
        let d = lookup(*name, "invariant")?;
        if ev.analysis.def_level(d) > 1 {
            return Err(cfg_err(
                "C0017",
                format!(
                    "The invariant {} is not a state predicate.",
                    ev.vctx.interner.str(*name)
                ),
            )
            .with_span(*span));
        }
        spec.invariants.push(pred_of(d)?);
    }

    // Properties.
    for (name, _) in &cfg.properties {
        let d = lookup(*name, "property")?;
        let info = &ev.analysis.defs[d.0 as usize];
        let body = info.body.ok_or_else(|| {
            cfg_err("C0016", format!("definition {} has no body", ev.vctx.interner.str(*name)))
        })?;
        let pname = ev.vctx.interner.str(*name).to_string();
        process_prop(ev, &mut spec, pname, info.module, body, &Ctx::empty())?;
    }

    // Constraints.
    for (name, span) in &cfg.constraints {
        let d = lookup(*name, "constraint")?;
        if ev.analysis.def_level(d) > 1 {
            return Err(cfg_err(
                "C0018",
                format!(
                    "The constraint {} is not a state predicate.",
                    ev.vctx.interner.str(*name)
                ),
            )
            .with_span(*span));
        }
        spec.constraints.push(pred_of(d)?);
    }
    for (name, span) in &cfg.action_constraints {
        let d = lookup(*name, "action constraint")?;
        if ev.analysis.def_level(d) > 2 {
            return Err(cfg_err(
                "C0019",
                format!(
                    "The action constraint {} is not an action predicate.",
                    ev.vctx.interner.str(*name)
                ),
            )
            .with_span(*span));
        }
        spec.action_constraints.push(pred_of(d)?);
    }

    Ok(spec)
}

/// Strip parentheses/labels off an expression.
fn unwrap_expr(ev: &Evaluator, m: ModuleId, mut e: ExprId) -> ExprId {
    loop {
        match &ev.arena(m).get(e).kind {
            ExprKind::Paren(inner) => e = *inner,
            ExprKind::Label { body, .. } => e = *body,
            _ => return e,
        }
    }
}

/// The name to report for a formula: the operator name when it is a plain
/// 0-arity reference, otherwise a placeholder.
fn formula_name(ev: &Evaluator, m: ModuleId, e: ExprId, fallback: &str) -> String {
    let e = unwrap_expr(ev, m, e);
    if let ExprKind::Ident(s) = &ev.arena(m).get(e).kind {
        return ev.vctx.interner.str(*s).to_string();
    }
    fallback.to_string()
}

/// `SpecProcessor.processConfigSpec`: structural decomposition of the
/// SPECIFICATION formula into init conjuncts and the `[][Next]_vars` box
/// action. Fairness/temporal conjuncts are collected nowhere (ignored, as
/// Java stores them for liveness checking which is out of scope here).
fn process_spec(
    ev: &Evaluator,
    spec: &mut CompiledSpec,
    m: ModuleId,
    e: ExprId,
    c: &Ctx,
) -> Result<(), Diag> {
    let e = unwrap_expr(ev, m, e);
    let expr = ev.arena(m).get(e);
    match &expr.kind {
        ExprKind::Let { defs, body } => {
            let c1 = ev.let_ctx(m, defs, c);
            process_spec(ev, spec, m, *body, &c1)
        }
        ExprKind::Junction(JunctionKind::Conj, items) => {
            for i in items {
                process_spec(ev, spec, m, *i, c)?;
            }
            Ok(())
        }
        ExprKind::Infix("\\land", l, r) => {
            process_spec(ev, spec, m, *l, c)?;
            process_spec(ev, spec, m, *r, c)
        }
        ExprKind::Ident(s) => match ev.analysis.expr_ref(m, e) {
            Some(Ref::Def(d)) => {
                let info = &ev.analysis.defs[d.0 as usize];
                let body = info.body.ok_or_else(|| {
                    cfg_err(
                        "C0016",
                        format!("definition {} has no body", ev.vctx.interner.str(*s)),
                    )
                })?;
                if info.arity != 0 {
                    return Err(cfg_err(
                        "C0014",
                        format!(
                            "The operator {} requires arguments.",
                            ev.vctx.interner.str(*s)
                        ),
                    ));
                }
                if ev.analysis.level(info.module, body) == 1 {
                    spec.init.push(Pred {
                        name: ev.vctx.interner.str(*s).to_string(),
                        module: info.module,
                        expr: body,
                        ctx: c.clone(),
                    });
                    Ok(())
                } else {
                    process_spec(ev, spec, info.module, body, c)
                }
            }
            _ => spec_conjunct_by_level(ev, spec, m, e, c),
        },
        ExprKind::Apply(_, _, args) => match ev.analysis.expr_ref(m, e) {
            Some(Ref::Def(d)) => {
                let info = &ev.analysis.defs[d.0 as usize];
                let body = info.body.ok_or_else(|| {
                    cfg_err("C0016", "definition has no body".to_string())
                })?;
                let c1 = ev.lazy_op_ctx(d, m, args, c, c)?;
                process_spec(ev, spec, info.module, body, &c1)
            }
            _ => spec_conjunct_by_level(ev, spec, m, e, c),
        },
        ExprKind::Prefix("[]", arg) => {
            let arg = unwrap_expr(ev, m, *arg);
            if let ExprKind::ActionSubscript { kind: SubscriptKind::Square, action, .. } =
                &ev.arena(m).get(arg).kind
            {
                if spec.next.is_some() {
                    return Err(cfg_err(
                        "C0020",
                        "TLC cannot handle more than one conjunct of the form [][Next]_v in \
                         the specification."
                            .to_string(),
                    ));
                }
                spec.next = Some(Pred {
                    name: formula_name(ev, m, *action, "Next"),
                    module: m,
                    expr: *action,
                    ctx: c.clone(),
                });
                Ok(())
            } else if ev.analysis.level(m, arg) <= 1 {
                Err(cfg_err(
                    "C0021",
                    "TLC cannot handle the temporal formula []P for a state-level P in the \
                     specification (use an INVARIANT)."
                        .to_string(),
                )
                .with_span(expr.span))
            } else {
                // []A for an action-level A that is not [A]_v: Java files it
                // as a temporal assumption, which safety checking ignores.
                Ok(())
            }
        }
        ExprKind::TemporalQuant { .. } => Err(cfg_err(
            "C0022",
            "TLC does not support temporal existential/universal quantification (\\EE/\\AA) \
             in the specification."
                .to_string(),
        )
        .with_span(expr.span)),
        _ => spec_conjunct_by_level(ev, spec, m, e, c),
    }
}

/// A SPECIFICATION conjunct that is not structurally recognized: classify by
/// level — state level becomes an init predicate, temporal level (fairness)
/// is ignored, bare action level is an error.
fn spec_conjunct_by_level(
    ev: &Evaluator,
    spec: &mut CompiledSpec,
    m: ModuleId,
    e: ExprId,
    c: &Ctx,
) -> Result<(), Diag> {
    match ev.analysis.level(m, e) {
        0 | 1 => {
            spec.init.push(Pred {
                name: formula_name(ev, m, e, "Init"),
                module: m,
                expr: e,
                ctx: c.clone(),
            });
            Ok(())
        }
        3 => Ok(()), // fairness/liveness conjunct: ignored for safety checking
        _ => Err(cfg_err(
            "C0023",
            "TLC cannot handle this conjunct of the specification (an action-level formula \
             must appear as [][A]_v)."
                .to_string(),
        )
        .with_span(ev.arena(m).get(e).span)),
    }
}

/// `SpecProcessor.processConfigProps`: compile one PROPERTY formula.
fn process_prop(
    ev: &Evaluator,
    spec: &mut CompiledSpec,
    name: String,
    m: ModuleId,
    e: ExprId,
    c: &Ctx,
) -> Result<(), Diag> {
    let e = unwrap_expr(ev, m, e);
    let expr = ev.arena(m).get(e);
    match &expr.kind {
        ExprKind::Let { defs, body } => {
            let c1 = ev.let_ctx(m, defs, c);
            process_prop(ev, spec, name, m, *body, &c1)
        }
        ExprKind::Junction(JunctionKind::Conj, items) => {
            for i in items {
                process_prop(ev, spec, name.clone(), m, *i, c)?;
            }
            Ok(())
        }
        ExprKind::Infix("\\land", l, r) => {
            process_prop(ev, spec, name.clone(), m, *l, c)?;
            process_prop(ev, spec, name, m, *r, c)
        }
        ExprKind::Ident(s) => match ev.analysis.expr_ref(m, e) {
            Some(Ref::Def(d)) => {
                let info = &ev.analysis.defs[d.0 as usize];
                let body = info.body.ok_or_else(|| {
                    cfg_err(
                        "C0016",
                        format!("definition {} has no body", ev.vctx.interner.str(*s)),
                    )
                })?;
                if info.arity != 0 {
                    return Err(cfg_err(
                        "C0014",
                        format!(
                            "The property {} requires arguments.",
                            ev.vctx.interner.str(*s)
                        ),
                    ));
                }
                let pname = ev.vctx.interner.str(*s).to_string();
                process_prop(ev, spec, pname, info.module, body, c)
            }
            _ => prop_by_level(ev, spec, name, m, e, c),
        },
        ExprKind::Apply(_, _, args) => match ev.analysis.expr_ref(m, e) {
            Some(Ref::Def(d)) => {
                let info = &ev.analysis.defs[d.0 as usize];
                let body = info.body.ok_or_else(|| {
                    cfg_err("C0016", "definition has no body".to_string())
                })?;
                let c1 = ev.lazy_op_ctx(d, m, args, c, c)?;
                process_prop(ev, spec, name, info.module, body, &c1)
            }
            _ => prop_by_level(ev, spec, name, m, e, c),
        },
        // \A x \in S : P at constant level: unroll into conjuncts.
        ExprKind::Quant { kind: QuantKind::Forall, bounds, body }
            if bounds.iter().all(|b| ev.analysis.level(m, b.domain) == 0) =>
        {
            let slots = ev.slots_for_bounds(m, bounds, c)?;
            let mut ctxs = Vec::new();
            ev.for_each_combo(&slots, c, expr.span, |c1| {
                ctxs.push(c1.clone());
                Ok(true)
            })?;
            for c1 in &ctxs {
                process_prop(ev, spec, name.clone(), m, *body, c1)?;
            }
            Ok(())
        }
        ExprKind::Prefix("[]", arg) => {
            let arg_id = unwrap_expr(ev, m, *arg);
            match &ev.arena(m).get(arg_id).kind {
                ExprKind::ActionSubscript { kind: SubscriptKind::Square, action, .. } => {
                    let aname = formula_name(ev, m, *action, &name);
                    spec.implied_actions.push(Pred {
                        name: aname,
                        module: m,
                        expr: arg_id,
                        ctx: c.clone(),
                    });
                    Ok(())
                }
                _ if ev.analysis.level(m, arg_id) < 2 => {
                    spec.invariants.push(Pred {
                        name: formula_name(ev, m, arg_id, &name),
                        module: m,
                        expr: arg_id,
                        ctx: c.clone(),
                    });
                    Ok(())
                }
                _ => Err(Diag::new(
                    Category::Unsupported,
                    "U0404",
                    format!("liveness property {name} is not supported (safety-only engine)"),
                )
                .with_span(expr.span)),
            }
        }
        _ => prop_by_level(ev, spec, name, m, e, c),
    }
}

fn prop_by_level(
    ev: &Evaluator,
    spec: &mut CompiledSpec,
    name: String,
    m: ModuleId,
    e: ExprId,
    c: &Ctx,
) -> Result<(), Diag> {
    let span = ev.arena(m).get(e).span;
    match ev.analysis.level(m, e) {
        0 | 1 => {
            spec.implied_inits.push(Pred { name, module: m, expr: e, ctx: c.clone() });
            Ok(())
        }
        2 => Err(cfg_err(
            "C0024",
            format!(
                "The property {name} is an action-level formula; only [][A]_v action \
                 properties can be checked."
            ),
        )
        .with_span(span)),
        _ => Err(Diag::new(
            Category::Unsupported,
            "U0404",
            format!("liveness property {name} is not supported (safety-only engine)"),
        )
        .with_span(span)),
    }
}
