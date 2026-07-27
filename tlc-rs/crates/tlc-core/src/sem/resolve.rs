//! Name resolution — the scope-stack analog of SANY's `Generator.java`.
//!
//! Every module is walked unit-by-unit with a scope stack whose bottom level
//! is the module's top-level symbol table (seeded from the EXTENDS closure
//! and parameterless INSTANCE imports). Resolution fills a dense side table
//! `Vec<Option<Ref>>` indexed by `ExprId`: `Some` for every `Ident`/`Apply`
//! node and for `Prefix`/`Infix`/`Postfix` nodes whose operator symbol is
//! user-defined in scope (stdlib `+`, a spec's `\oplus`, …); `None` means
//! "builtin operator" (or an unresolved node behind a reported error).
//!
//! TLA+ scoping rules enforced here, following SANY:
//! - defs are visible only after their definition (no forward references
//!   except through RECURSIVE declarations);
//! - defining a name twice is an error, and so is a LET definition or binder
//!   shadowing anything in scope ("multiply-defined symbol");
//! - importing the same name from two modules is fine only when both imports
//!   denote the same definition;
//! - `@` resolves to a per-update EXCEPT binder and is legal only inside
//!   EXCEPT update values.

use crate::diag::{Category, Diag, Diagnostics};
use crate::intern::{Interner, Sym};
use crate::loc::Span;
use crate::syntax::ast::{
    Bound, ExceptPathElem, ExprArena, ExprId, ExprKind, FnDef, OpDecl, OpDef, Param, SourceFile,
    Unit,
};
use crate::syntax::ops;
use hashbrown::HashMap;

// ---- typed indices ---------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct ModuleId(pub u32);

/// A definition (module-level or LET-level), flat across all modules.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct DefId(pub u32);

/// A state variable, flat across all modules.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct VarId(pub u32);

/// A declared constant, flat across all modules.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct ConstId(pub u32);

/// A binder site: quantifier/CHOOSE/set-construct/fn-constructor bound var,
/// LAMBDA param, recursive-function self reference, or an EXCEPT update's
/// `@` placeholder.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct BinderId(pub u32);

/// What a name occurrence denotes.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Ref {
    Def(DefId),
    Var(VarId),
    Const(ConstId),
    /// Formal parameter `index` of definition `def`.
    Param { def: DefId, index: u32 },
    Binder(BinderId),
    Builtin(Builtin),
}

/// Built-in names that are not definitions of any module.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Builtin {
    True,
    False,
    Boolean,
    String,
}

// ---- semantic tables -------------------------------------------------------

#[derive(Clone, Debug)]
pub struct ParamInfo {
    pub name: Sym,
    pub span: Span,
    /// 0 for ordinary params; n for higher-order `p(_, ..., _)`.
    pub arity: u32,
}

#[derive(Debug)]
pub enum DefKind {
    Op,
    /// `f[x \in S] == e`: the bound domains, and the binder that `f` itself
    /// resolves to inside its own body (recursive function).
    Fn { domains: Vec<ExprId>, self_binder: BinderId },
}

#[derive(Debug)]
pub struct DefInfo {
    pub module: ModuleId,
    pub name: Sym,
    pub span: Span,
    pub params: Vec<ParamInfo>,
    pub arity: u32,
    pub kind: DefKind,
    /// `None` while a RECURSIVE declaration awaits its definition (an error
    /// if it stays that way).
    pub body: Option<ExprId>,
    pub local: bool,
}

#[derive(Debug)]
pub struct VarInfo {
    pub module: ModuleId,
    pub name: Sym,
    pub span: Span,
}

#[derive(Debug)]
pub struct ConstInfo {
    pub module: ModuleId,
    pub name: Sym,
    pub span: Span,
    pub arity: u32,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum BinderKind {
    /// Quantifier / CHOOSE / set-construct / function-constructor bound var.
    Bound,
    LambdaParam,
    /// The function's own name inside a recursive `f[x \in S] == e` body.
    FnSelf,
    /// The `@` of one EXCEPT update.
    ExceptAt,
}

#[derive(Debug)]
pub struct BinderInfo {
    pub module: ModuleId,
    /// `None` for `ExceptAt` binders (they have no source name).
    pub name: Option<Sym>,
    pub span: Span,
    pub kind: BinderKind,
}

/// The flat cross-module tables `analyze` accumulates.
#[derive(Default, Debug)]
pub struct Tables {
    pub defs: Vec<DefInfo>,
    pub vars: Vec<VarInfo>,
    pub consts: Vec<ConstInfo>,
    pub binders: Vec<BinderInfo>,
}

impl Tables {
    pub fn arity_of(&self, r: Ref) -> u32 {
        match r {
            Ref::Def(d) => self.defs[d.0 as usize].arity,
            Ref::Const(c) => self.consts[c.0 as usize].arity,
            Ref::Param { def, index } => self.defs[def.0 as usize].params[index as usize].arity,
            Ref::Var(_) | Ref::Binder(_) | Ref::Builtin(_) => 0,
        }
    }

    /// Declaration site of a reference, for "previously defined here" notes.
    fn ref_span(&self, r: Ref) -> Option<Span> {
        match r {
            Ref::Def(d) => Some(self.defs[d.0 as usize].span),
            Ref::Var(v) => Some(self.vars[v.0 as usize].span),
            Ref::Const(c) => Some(self.consts[c.0 as usize].span),
            Ref::Param { def, index } => {
                Some(self.defs[def.0 as usize].params[index as usize].span)
            }
            Ref::Binder(b) => Some(self.binders[b.0 as usize].span),
            Ref::Builtin(_) => None,
        }
    }
}

/// Interned symbols for the built-in names, created once per analysis.
pub struct BuiltinSyms {
    pub true_: Sym,
    pub false_: Sym,
    pub boolean: Sym,
    pub string: Sym,
    pub at: Sym,
}

impl BuiltinSyms {
    pub fn new(interner: &mut Interner) -> Self {
        BuiltinSyms {
            true_: interner.intern("TRUE"),
            false_: interner.intern("FALSE"),
            boolean: interner.intern("BOOLEAN"),
            string: interner.intern("STRING"),
            at: interner.intern("@"),
        }
    }
}

// ---- resolver --------------------------------------------------------------

pub(crate) struct ModuleResolution {
    pub refs: Vec<Option<Ref>>,
    /// Names this module makes visible to modules that EXTENDS/INSTANCE it.
    pub exports: HashMap<Sym, Ref>,
}

/// Resolve one module. All modules it depends on must already be resolved
/// (their exports available in `exports_by`, indexed by ModuleId).
pub(crate) fn resolve_module(
    m: ModuleId,
    sf: &SourceFile,
    tables: &mut Tables,
    exports_by: &[HashMap<Sym, Ref>],
    module_ids: &HashMap<Sym, ModuleId>,
    interner: &Interner,
    builtins: &BuiltinSyms,
    diags: &mut Diagnostics,
) -> ModuleResolution {
    let mut r = Resolver {
        m,
        arena: &sf.arena,
        t: tables,
        exports_by,
        module_ids,
        interner,
        b: builtins,
        diags,
        refs: vec![None; sf.arena.exprs.len()],
        scopes: vec![HashMap::new()],
        top_exported: HashMap::new(),
        at_stack: Vec::new(),
    };

    for (name, span) in &sf.module.extends {
        r.import_module(*name, *span, true);
    }

    let mut pending: HashMap<Sym, DefId> = HashMap::new();
    for unit in &sf.module.units {
        match unit {
            Unit::Variables(vs) => {
                for (name, span) in vs {
                    r.check_fresh(*name, *span);
                    let id = VarId(r.t.vars.len() as u32);
                    r.t.vars.push(VarInfo { module: m, name: *name, span: *span });
                    r.register(*name, Ref::Var(id), false);
                }
            }
            Unit::Constants(decls) => {
                for d in decls {
                    r.check_fresh(d.name, d.span);
                    let id = ConstId(r.t.consts.len() as u32);
                    r.t.consts.push(ConstInfo {
                        module: m,
                        name: d.name,
                        span: d.span,
                        arity: d.arity,
                    });
                    r.register(d.name, Ref::Const(id), false);
                }
            }
            Unit::Recursive(decls) => r.declare_recursive(decls, &mut pending),
            Unit::OpDef { local, def } => r.do_opdef(def, *local, &mut pending),
            Unit::FnDef { local, def } => r.do_fndef(def, *local, &mut pending),
            Unit::Instance { local, decl } => {
                if decl.def_name.is_some() || !decl.with.is_empty() {
                    r.diags.push(Diag::unsupported(
                        "U0201",
                        "INSTANCE with substitutions (WITH) or a definition name \
                         (I == INSTANCE M) is not supported; only parameterless \
                         [LOCAL] INSTANCE M",
                        decl.module_span,
                    ));
                } else {
                    r.import_module(decl.module, decl.module_span, !*local);
                }
            }
            Unit::Assume { expr, .. } => r.resolve_expr(*expr),
            Unit::Theorem { expr, .. } => r.resolve_expr(*expr),
            Unit::Separator => {}
            Unit::Submodule(sub) => {
                r.diags.push(Diag::unsupported(
                    "U0202",
                    "inner (sub)modules are not supported",
                    sub.span,
                ));
            }
        }
    }
    r.report_unfilled_recursive(&pending);

    let exports: HashMap<Sym, Ref> = r.scopes[0]
        .iter()
        .filter(|(name, _)| r.top_exported.get(*name).copied().unwrap_or(false))
        .map(|(name, rf)| (*name, *rf))
        .collect();
    ModuleResolution { refs: r.refs, exports }
}

struct Resolver<'a> {
    m: ModuleId,
    arena: &'a ExprArena,
    t: &'a mut Tables,
    exports_by: &'a [HashMap<Sym, Ref>],
    module_ids: &'a HashMap<Sym, ModuleId>,
    interner: &'a Interner,
    b: &'a BuiltinSyms,
    diags: &'a mut Diagnostics,
    refs: Vec<Option<Ref>>,
    /// scopes[0] is the module top level; inner scopes are binders/params/LETs.
    scopes: Vec<HashMap<Sym, Ref>>,
    /// Export flag per top-level name (false for LOCAL defs and names
    /// imported through LOCAL INSTANCE).
    top_exported: HashMap<Sym, bool>,
    /// EXCEPT `@` binders, innermost last.
    at_stack: Vec<BinderId>,
}

impl<'a> Resolver<'a> {
    fn sem(&self, code: &'static str, msg: impl Into<String>, span: Span) -> Diag {
        Diag::new(Category::Semantic, code, msg).with_span(span)
    }

    fn name(&self, s: Sym) -> &str {
        self.interner.str(s)
    }

    fn set(&mut self, e: ExprId, r: Ref) {
        self.refs[e.0 as usize] = Some(r);
    }

    /// Innermost-out scope lookup, falling back to the built-in names.
    fn lookup(&self, s: Sym) -> Option<Ref> {
        for scope in self.scopes.iter().rev() {
            if let Some(r) = scope.get(&s) {
                return Some(*r);
            }
        }
        if s == self.b.true_ {
            Some(Ref::Builtin(Builtin::True))
        } else if s == self.b.false_ {
            Some(Ref::Builtin(Builtin::False))
        } else if s == self.b.boolean {
            Some(Ref::Builtin(Builtin::Boolean))
        } else if s == self.b.string {
            Some(Ref::Builtin(Builtin::String))
        } else {
            None
        }
    }

    /// Error if `name` already means something (definition, declaration,
    /// bound variable, or builtin). SANY calls all of these
    /// "multiply-defined symbol" — shadowing is not allowed in TLA+.
    fn check_fresh(&mut self, name: Sym, span: Span) {
        if let Some(prev) = self.lookup(name) {
            let mut d = self.sem(
                "S0102",
                format!("multiply-defined symbol '{}'", self.name(name)),
                span,
            );
            d = match self.t.ref_span(prev) {
                Some(psp) => d.note("previously defined here", Some(psp)),
                None => d.note("shadows a built-in name", None),
            };
            self.diags.push(d);
        }
    }

    /// Insert into the innermost scope; track exportedness at module level.
    fn register(&mut self, name: Sym, r: Ref, local: bool) {
        if self.scopes.len() == 1 {
            self.top_exported.insert(name, !local);
        }
        self.scopes.last_mut().expect("scope stack").insert(name, r);
    }

    /// Import the exports of `name` (EXTENDS or parameterless INSTANCE).
    /// The same name arriving twice is fine iff it is the same definition.
    fn import_module(&mut self, name: Sym, site: Span, export: bool) {
        let Some(&mid) = self.module_ids.get(&name) else {
            // Load failed earlier; that error was already reported.
            return;
        };
        let exports = &self.exports_by[mid.0 as usize];
        let mut imported: Vec<(Sym, Ref)> = exports.iter().map(|(n, r)| (*n, *r)).collect();
        // Deterministic error order regardless of hash iteration.
        imported.sort_by_key(|(n, _)| *n);
        for (n, rf) in imported {
            match self.scopes[0].get(&n).copied() {
                None => {
                    self.scopes[0].insert(n, rf);
                    self.top_exported.insert(n, export);
                }
                Some(existing) if existing == rf => {
                    // Same definition through two paths (diamond import): OK.
                    if export {
                        self.top_exported.insert(n, true);
                    }
                }
                Some(existing) => {
                    let mut d = self.sem(
                        "S0107",
                        format!(
                            "name '{}' imported from module '{}' conflicts with an \
                             existing definition of the same name",
                            self.name(n),
                            self.name(name)
                        ),
                        site,
                    );
                    if let Some(psp) = self.t.ref_span(existing) {
                        d = d.note("conflicting definition", Some(psp));
                    }
                    self.diags.push(d);
                }
            }
        }
    }

    // ---- definitions -------------------------------------------------------

    fn declare_recursive(&mut self, decls: &[OpDecl], pending: &mut HashMap<Sym, DefId>) {
        for d in decls {
            self.check_fresh(d.name, d.span);
            let id = DefId(self.t.defs.len() as u32);
            self.t.defs.push(DefInfo {
                module: self.m,
                name: d.name,
                span: d.span,
                params: Vec::new(),
                arity: d.arity,
                kind: DefKind::Op,
                body: None,
                local: false,
            });
            self.register(d.name, Ref::Def(id), false);
            pending.insert(d.name, id);
        }
    }

    fn report_unfilled_recursive(&mut self, pending: &HashMap<Sym, DefId>) {
        let mut leftover: Vec<DefId> = pending.values().copied().collect();
        leftover.sort_by_key(|d| d.0);
        for d in leftover {
            let info = &self.t.defs[d.0 as usize];
            let (name, span) = (info.name, info.span);
            let msg =
                format!("RECURSIVE declaration '{}' has no matching definition", self.name(name));
            let diag = self.sem("S0109", msg, span);
            self.diags.push(diag);
        }
    }

    fn conv_params(&self, def: DefId, params: &[Param]) -> Vec<ParamInfo> {
        let _ = def;
        params
            .iter()
            .map(|p| ParamInfo { name: p.name, span: p.span, arity: p.arity })
            .collect()
    }

    fn do_opdef(&mut self, def: &OpDef, local: bool, pending: &mut HashMap<Sym, DefId>) {
        let recursive = pending.remove(&def.name);
        let did = match recursive {
            Some(d) => {
                let declared = self.t.defs[d.0 as usize].arity;
                if declared != def.params.len() as u32 {
                    let decl_span = self.t.defs[d.0 as usize].span;
                    let msg = format!(
                        "definition of '{}' has {} parameter(s) but its RECURSIVE \
                         declaration says {}",
                        self.name(def.name),
                        def.params.len(),
                        declared
                    );
                    let diag = self.sem("S0108", msg, def.span).note(
                        "RECURSIVE declaration here",
                        Some(decl_span),
                    );
                    self.diags.push(diag);
                }
                // Fill in the placeholder: uses before and after this point
                // all resolve to the same DefId.
                let info = &mut self.t.defs[d.0 as usize];
                info.span = def.span;
                info.arity = def.params.len() as u32;
                d
            }
            None => {
                self.check_fresh(def.name, def.span);
                let id = DefId(self.t.defs.len() as u32);
                self.t.defs.push(DefInfo {
                    module: self.m,
                    name: def.name,
                    span: def.span,
                    params: Vec::new(),
                    arity: def.params.len() as u32,
                    kind: DefKind::Op,
                    body: None,
                    local,
                });
                id
            }
        };
        // Params must be recorded before the body walk so `Ref::Param` arity
        // lookups (higher-order params) see them.
        self.t.defs[did.0 as usize].params = self.conv_params(did, &def.params);

        self.scopes.push(HashMap::new());
        for (i, p) in def.params.iter().enumerate() {
            self.check_fresh(p.name, p.span);
            self.scopes
                .last_mut()
                .expect("scope stack")
                .insert(p.name, Ref::Param { def: did, index: i as u32 });
        }
        self.resolve_expr(def.body);
        self.scopes.pop();

        self.t.defs[did.0 as usize].body = Some(def.body);
        if recursive.is_none() {
            // Non-recursive defs enter scope only after their own body
            // (a def cannot reference itself without RECURSIVE).
            self.register(def.name, Ref::Def(did), local);
        }
    }

    fn do_fndef(&mut self, def: &FnDef, local: bool, pending: &mut HashMap<Sym, DefId>) {
        // `RECURSIVE fact` followed by `fact[n \in S] == e` fills the
        // declared placeholder (uses before this point resolve to it).
        let recursive = pending.remove(&def.name);
        if recursive.is_none() {
            self.check_fresh(def.name, def.span);
        }
        // Domains are evaluated in the outer context — neither the function
        // name nor its bound variables are visible there.
        for b in &def.bounds {
            self.resolve_expr(b.domain);
        }
        let self_binder = BinderId(self.t.binders.len() as u32);
        self.t.binders.push(BinderInfo {
            module: self.m,
            name: Some(def.name),
            span: def.span,
            kind: BinderKind::FnSelf,
        });
        let kind = DefKind::Fn {
            domains: def.bounds.iter().map(|b| b.domain).collect(),
            self_binder,
        };
        let did = match recursive {
            Some(d) => {
                let declared = self.t.defs[d.0 as usize].arity;
                if declared != 0 {
                    let decl_span = self.t.defs[d.0 as usize].span;
                    let msg = format!(
                        "function definition of '{}' takes no operator parameter(s) but \
                         its RECURSIVE declaration says {}",
                        self.name(def.name),
                        declared
                    );
                    let diag = self
                        .sem("S0108", msg, def.span)
                        .note("RECURSIVE declaration here", Some(decl_span));
                    self.diags.push(diag);
                }
                let info = &mut self.t.defs[d.0 as usize];
                info.span = def.span;
                info.arity = 0;
                info.kind = kind;
                d
            }
            None => {
                let id = DefId(self.t.defs.len() as u32);
                self.t.defs.push(DefInfo {
                    module: self.m,
                    name: def.name,
                    span: def.span,
                    params: Vec::new(),
                    arity: 0,
                    kind,
                    body: None,
                    local,
                });
                id
            }
        };

        self.scopes.push(HashMap::new());
        self.scopes.last_mut().expect("scope stack").insert(def.name, Ref::Binder(self_binder));
        self.bind_bound_vars(&def.bounds);
        self.resolve_expr(def.body);
        self.scopes.pop();

        self.t.defs[did.0 as usize].body = Some(def.body);
        if recursive.is_none() {
            // A RECURSIVE-declared name was registered at its declaration.
            self.register(def.name, Ref::Def(did), local);
        }
    }

    /// Handle a LET's definition list (OpDef/FnDef/RECURSIVE; the parser
    /// forbids anything else except `I == INSTANCE`, rejected here).
    fn do_let(&mut self, defs: &[Unit], body: ExprId) {
        self.scopes.push(HashMap::new());
        let mut pending: HashMap<Sym, DefId> = HashMap::new();
        for u in defs {
            match u {
                Unit::OpDef { local, def } => self.do_opdef(def, *local, &mut pending),
                Unit::FnDef { local, def } => self.do_fndef(def, *local, &mut pending),
                Unit::Recursive(decls) => self.declare_recursive(decls, &mut pending),
                Unit::Instance { decl, .. } => {
                    self.diags.push(Diag::unsupported(
                        "U0201",
                        "INSTANCE inside LET is not supported",
                        decl.module_span,
                    ));
                }
                _ => {}
            }
        }
        self.report_unfilled_recursive(&pending);
        self.resolve_expr(body);
        self.scopes.pop();
    }

    // ---- binders -----------------------------------------------------------

    fn bind(&mut self, name: Sym, span: Span, kind: BinderKind) {
        self.check_fresh(name, span);
        let id = BinderId(self.t.binders.len() as u32);
        self.t.binders.push(BinderInfo { module: self.m, name: Some(name), span, kind });
        self.scopes.last_mut().expect("scope stack").insert(name, Ref::Binder(id));
    }

    /// Push a scope binding every variable of `bounds`. Domains must already
    /// be resolved (they belong to the outer context).
    fn bind_bound_vars(&mut self, bounds: &[Bound]) {
        for b in bounds {
            for (v, sp) in &b.vars {
                self.bind(*v, *sp, BinderKind::Bound);
            }
        }
    }

    fn with_bounds(&mut self, bounds: &[Bound], inner: impl FnOnce(&mut Self)) {
        for b in bounds {
            self.resolve_expr(b.domain);
        }
        self.scopes.push(HashMap::new());
        self.bind_bound_vars(bounds);
        inner(self);
        self.scopes.pop();
    }

    fn with_plain_vars(&mut self, vars: &[(Sym, Span)], kind: BinderKind, inner: impl FnOnce(&mut Self)) {
        self.scopes.push(HashMap::new());
        for (v, sp) in vars {
            self.bind(*v, *sp, kind);
        }
        inner(self);
        self.scopes.pop();
    }

    // ---- expressions -------------------------------------------------------

    fn resolve_expr(&mut self, e: ExprId) {
        let expr = self.arena.get(e);
        let span = expr.span;
        match &expr.kind {
            ExprKind::Num(_) | ExprKind::Str(_) => {}

            ExprKind::Ident(s) => self.resolve_name(e, *s, span),

            ExprKind::Paren(inner) => self.resolve_expr(*inner),

            ExprKind::Prefix(op, a) => {
                self.resolve_op_use(e, op, 1, span);
                self.resolve_expr(*a);
            }
            ExprKind::Infix(op, l, r) => {
                self.resolve_op_use(e, op, 2, span);
                self.resolve_expr(*l);
                self.resolve_expr(*r);
            }
            ExprKind::Postfix(op, a) => {
                self.resolve_op_use(e, op, 1, span);
                self.resolve_expr(*a);
            }
            // `a \X b \X c` is n-ary; a user redefinition of `\X` (binary)
            // cannot apply to the flattened chain, so it stays builtin.
            ExprKind::Times(items) => {
                for i in items {
                    self.resolve_expr(*i);
                }
            }

            ExprKind::Apply(s, hspan, args) => self.resolve_apply(e, *s, *hspan, args),

            ExprKind::Junction(_, items) => {
                for i in items {
                    self.resolve_expr(*i);
                }
            }

            ExprKind::Quant { bounds, body, .. } => {
                let body = *body;
                self.with_bounds(bounds, |r| r.resolve_expr(body));
            }
            ExprKind::UnboundedQuant { vars, body, .. }
            | ExprKind::TemporalQuant { vars, body, .. } => {
                let body = *body;
                self.with_plain_vars(vars, BinderKind::Bound, |r| r.resolve_expr(body));
            }

            ExprKind::Choose { var, tuple_vars, domain, body } => {
                if let Some(d) = domain {
                    self.resolve_expr(*d);
                }
                let body = *body;
                let vars: Vec<(Sym, Span)> =
                    if tuple_vars.is_empty() { vec![*var] } else { tuple_vars.clone() };
                self.with_plain_vars(&vars, BinderKind::Bound, |r| r.resolve_expr(body));
            }

            ExprKind::SetEnum(items) => {
                for i in items {
                    self.resolve_expr(*i);
                }
            }
            ExprKind::SetFilter { bound, pred } => {
                let pred = *pred;
                self.with_bounds(std::slice::from_ref(bound), |r| r.resolve_expr(pred));
            }
            ExprKind::SetMap { expr, bounds } => {
                let expr = *expr;
                self.with_bounds(bounds, |r| r.resolve_expr(expr));
            }
            ExprKind::FnConstructor { bounds, body } => {
                let body = *body;
                self.with_bounds(bounds, |r| r.resolve_expr(body));
            }

            ExprKind::FnApply { f, args } => {
                self.resolve_expr(*f);
                for a in args {
                    self.resolve_expr(*a);
                }
            }
            ExprKind::FnSet { domain, range } => {
                self.resolve_expr(*domain);
                self.resolve_expr(*range);
            }
            ExprKind::Record(fields) | ExprKind::RecordSet(fields) => {
                for (_, _, v) in fields {
                    self.resolve_expr(*v);
                }
            }
            ExprKind::RecordField(base, _, _) => self.resolve_expr(*base),

            ExprKind::Except { base, updates } => {
                self.resolve_expr(*base);
                for u in updates {
                    for elem in &u.path {
                        if let ExceptPathElem::Index(idx) = elem {
                            for i in idx {
                                self.resolve_expr(*i);
                            }
                        }
                    }
                    // `@` is legal only inside the update's value and denotes
                    // the replaced sub-value: give each update its own binder.
                    let at = BinderId(self.t.binders.len() as u32);
                    self.t.binders.push(BinderInfo {
                        module: self.m,
                        name: None,
                        span: self.arena.get(u.value).span,
                        kind: BinderKind::ExceptAt,
                    });
                    self.at_stack.push(at);
                    self.resolve_expr(u.value);
                    self.at_stack.pop();
                }
            }

            ExprKind::Tuple(items) => {
                for i in items {
                    self.resolve_expr(*i);
                }
            }

            ExprKind::If { cond, then, els } => {
                self.resolve_expr(*cond);
                self.resolve_expr(*then);
                self.resolve_expr(*els);
            }
            ExprKind::Case(arms) => {
                for (guard, body) in arms {
                    if let Some(g) = guard {
                        self.resolve_expr(*g);
                    }
                    self.resolve_expr(*body);
                }
            }

            ExprKind::Let { defs, body } => self.do_let(defs, *body),

            ExprKind::ActionSubscript { action, subscript, .. } => {
                self.resolve_expr(*action);
                self.resolve_expr(*subscript);
            }
            ExprKind::Fairness { subscript, action, .. } => {
                self.resolve_expr(*subscript);
                self.resolve_expr(*action);
            }

            ExprKind::Lambda { params, body } => {
                let body = *body;
                self.with_plain_vars(params, BinderKind::LambdaParam, |r| r.resolve_expr(body));
            }
            // Label args name enclosing bound vars; only the body carries
            // semantics.
            ExprKind::Label { body, .. } => self.resolve_expr(*body),
        }
    }

    /// A plain identifier occurrence (not the head of an `Apply`, not an
    /// operator-argument — those go through their own paths).
    fn resolve_name(&mut self, e: ExprId, s: Sym, span: Span) {
        if s == self.b.at {
            match self.at_stack.last() {
                Some(&b) => self.set(e, Ref::Binder(b)),
                None => {
                    let d = self.sem(
                        "S0106",
                        "`@` is only legal inside an EXCEPT update value",
                        span,
                    );
                    self.diags.push(d);
                }
            }
            return;
        }
        match self.lookup(s) {
            Some(r) => {
                self.set(e, r);
                let arity = self.t.arity_of(r);
                if arity > 0 {
                    let d = self.sem(
                        "S0104",
                        format!(
                            "operator '{}' requires {} argument(s) and cannot be \
                             used as an expression here",
                            self.name(s),
                            arity
                        ),
                        span,
                    );
                    self.diags.push(d);
                }
            }
            None => {
                let d =
                    self.sem("S0101", format!("unknown identifier '{}'", self.name(s)), span);
                self.diags.push(d);
            }
        }
    }

    fn resolve_apply(&mut self, e: ExprId, s: Sym, hspan: Span, args: &[ExprId]) {
        match self.lookup(s) {
            Some(r) => {
                self.set(e, r);
                let arity = self.t.arity_of(r);
                if arity as usize != args.len() {
                    let d = self.sem(
                        "S0103",
                        format!(
                            "operator '{}' expects {} argument(s) but is applied to {}",
                            self.name(s),
                            arity,
                            args.len()
                        ),
                        hspan,
                    );
                    self.diags.push(d);
                }
                // Per-argument expected arities (higher-order params exist
                // only on Def heads; Const/Param heads take ordinary args).
                for (i, a) in args.iter().enumerate() {
                    let want = match r {
                        Ref::Def(d) => self.t.defs[d.0 as usize]
                            .params
                            .get(i)
                            .map(|p| p.arity)
                            .unwrap_or(0),
                        _ => 0,
                    };
                    if want == 0 {
                        self.resolve_expr(*a);
                    } else {
                        self.resolve_op_arg(*a, want);
                    }
                }
            }
            None => {
                // Nonfix application of a builtin operator symbol: `\o(a, b)`.
                let text = self.interner.str(s);
                if let Some(_info) = ops::lookup(text) {
                    let want = if ops::infix(text).is_some() { 2 } else { 1 };
                    if args.len() != want {
                        let d = self.sem(
                            "S0103",
                            format!(
                                "operator '{text}' expects {want} argument(s) but is \
                                 applied to {}",
                                args.len()
                            ),
                            hspan,
                        );
                        self.diags.push(d);
                    }
                } else {
                    let d = self.sem(
                        "S0101",
                        format!("unknown operator '{}'", self.name(s)),
                        hspan,
                    );
                    self.diags.push(d);
                }
                for a in args {
                    self.resolve_expr(*a);
                }
            }
        }
    }

    /// Argument in a higher-order position: must be an operator of arity
    /// `want` — a defined/declared operator name, a builtin operator symbol,
    /// or a LAMBDA of matching parameter count.
    fn resolve_op_arg(&mut self, a: ExprId, want: u32) {
        let expr = self.arena.get(a);
        let span = expr.span;
        match &expr.kind {
            ExprKind::Ident(s) => {
                let s = *s;
                match self.lookup(s) {
                    Some(r) => {
                        self.set(a, r);
                        let arity = self.t.arity_of(r);
                        if arity != want {
                            let d = self.sem(
                                "S0105",
                                format!(
                                    "expected an operator with {} parameter(s), but \
                                     '{}' takes {}",
                                    want,
                                    self.name(s),
                                    arity
                                ),
                                span,
                            );
                            self.diags.push(d);
                        }
                    }
                    None => {
                        // Builtin operator reference (`SortSeq(s, <)`); the
                        // ref stays None = builtin.
                        let text = self.interner.str(s);
                        let ok = (want == 2 && ops::infix(text).is_some())
                            || (want == 1
                                && (ops::prefix(text).is_some() || ops::postfix(text).is_some()));
                        if !ok {
                            let d = self.sem(
                                "S0105",
                                format!(
                                    "expected an operator with {} parameter(s), \
                                     found '{}'",
                                    want,
                                    self.name(s)
                                ),
                                span,
                            );
                            self.diags.push(d);
                        }
                    }
                }
            }
            ExprKind::Lambda { params, .. } => {
                if params.len() != want as usize {
                    let d = self.sem(
                        "S0105",
                        format!(
                            "expected an operator with {} parameter(s), but the \
                             LAMBDA takes {}",
                            want,
                            params.len()
                        ),
                        span,
                    );
                    self.diags.push(d);
                }
                self.resolve_expr(a);
            }
            _ => {
                let d = self.sem(
                    "S0105",
                    format!("this argument must be an operator with {want} parameter(s)"),
                    span,
                );
                self.diags.push(d);
                self.resolve_expr(a);
            }
        }
    }

    /// A `Prefix`/`Infix`/`Postfix` node: builtin unless a user definition of
    /// the operator symbol is in scope (stdlib `+`, a spec's `\oplus`, a
    /// formal parameter `_ \prec _`), in which case the node resolves to it.
    fn resolve_op_use(&mut self, e: ExprId, spelling: &str, argc: u32, span: Span) {
        let Some(sym) = self.interner.get(spelling) else { return };
        let Some(r) = self.lookup(sym) else { return };
        self.set(e, r);
        let arity = self.t.arity_of(r);
        if arity != argc {
            let d = self.sem(
                "S0103",
                format!(
                    "operator '{spelling}' expects {arity} argument(s) but is used \
                     with {argc}"
                ),
                span,
            );
            self.diags.push(d);
        }
    }
}
