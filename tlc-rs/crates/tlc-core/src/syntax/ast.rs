//! Parse-stage AST.
//!
//! Expressions live in a per-module arena (`ExprArena`) addressed by
//! `ExprId`. The tree is close to the concrete syntax (parens and junction
//! lists are preserved) so it can be shape-compared against the tree-sitter
//! corpus, while staying semantic-ready.

use crate::intern::Sym;
use crate::loc::Span;

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct ExprId(pub u32);

#[derive(Debug, Default)]
pub struct ExprArena {
    pub exprs: Vec<Expr>,
}

impl ExprArena {
    pub fn alloc(&mut self, kind: ExprKind, span: Span) -> ExprId {
        let id = ExprId(self.exprs.len() as u32);
        self.exprs.push(Expr { kind, span });
        id
    }

    pub fn get(&self, id: ExprId) -> &Expr {
        &self.exprs[id.0 as usize]
    }
}

#[derive(Debug)]
pub struct Expr {
    pub kind: ExprKind,
    pub span: Span,
}

/// One `x \in S` / `<<x, y>> \in S` binder group in a quantifier, set
/// construct, or function constructor. `vars` holds all names bound to the
/// same domain (`x, y \in S`); `tuple` marks the destructuring form.
#[derive(Debug)]
pub struct Bound {
    pub vars: Vec<(Sym, Span)>,
    pub tuple: bool,
    pub domain: ExprId,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum JunctionKind {
    Conj,
    Disj,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum QuantKind {
    Forall,
    Exists,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum FairnessKind {
    Weak,
    Strong,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum SubscriptKind {
    /// `[A]_v` — box-action (stuttering allowed)
    Square,
    /// `<<A>>_v` — angle-action (stuttering excluded)
    Angle,
}

/// One update in `[f EXCEPT ![a][b].c = e, ...]`.
#[derive(Debug)]
pub struct ExceptUpdate {
    /// Path components: `![a]` → Index(a); `.c` → Field(c).
    pub path: Vec<ExceptPathElem>,
    pub value: ExprId,
}

#[derive(Debug)]
pub enum ExceptPathElem {
    /// `[e1, e2]` — one bracket group (multi-arg function index).
    Index(Vec<ExprId>),
    Field(Sym),
}

#[derive(Debug)]
pub enum ExprKind {
    Num(Sym),
    Str(Sym),
    /// Identifier reference, including `@` (inside EXCEPT) and `ℕ`-style
    /// glyph identifiers.
    Ident(Sym),
    /// Explicit parentheses (kept for CST fidelity).
    Paren(ExprId),

    /// Built-in operator application by canonical spelling.
    Prefix(&'static str, ExprId),
    Infix(&'static str, ExprId, ExprId),
    Postfix(&'static str, ExprId),
    /// `a \X b \X c` — flattened Cartesian product (n-fix).
    Times(Vec<ExprId>),

    /// Named operator application `Op(e1, ..., en)`. Zero-arg references
    /// parse as `Ident`.
    Apply(Sym, Span, Vec<ExprId>),

    /// Aligned `/\`-list or `\/`-list.
    Junction(JunctionKind, Vec<ExprId>),

    Quant { kind: QuantKind, bounds: Vec<Bound>, body: ExprId },
    /// `\E x, y : body` (unbounded — always a level/semantic error in TLC,
    /// but parses).
    UnboundedQuant { kind: QuantKind, vars: Vec<(Sym, Span)>, body: ExprId },
    /// Temporal `\EE` / `\AA` (parsed; rejected in semantics).
    TemporalQuant { exists: bool, vars: Vec<(Sym, Span)>, body: ExprId },

    Choose { var: (Sym, Span), tuple_vars: Vec<(Sym, Span)>, domain: Option<ExprId>, body: ExprId },

    /// `{e1, ..., en}` (possibly empty).
    SetEnum(Vec<ExprId>),
    /// `{x \in S : p}`
    SetFilter { bound: Bound, pred: ExprId },
    /// `{e : x \in S, y \in T}`
    SetMap { expr: ExprId, bounds: Vec<Bound> },

    /// `[x \in S, y \in T |-> e]`
    FnConstructor { bounds: Vec<Bound>, body: ExprId },
    /// `f[e]` / `f[e1, e2]`
    FnApply { f: ExprId, args: Vec<ExprId> },
    /// `[S -> T]`
    FnSet { domain: ExprId, range: ExprId },
    /// `[a |-> e, ...]`
    Record(Vec<(Sym, Span, ExprId)>),
    /// `[a : S, ...]`
    RecordSet(Vec<(Sym, Span, ExprId)>),
    /// `r.field`
    RecordField(ExprId, Sym, Span),
    /// `[base EXCEPT !path = e, ...]`
    Except { base: ExprId, updates: Vec<ExceptUpdate> },

    /// `<<e1, ..., en>>`
    Tuple(Vec<ExprId>),

    If { cond: ExprId, then: ExprId, els: ExprId },
    /// `CASE g1 -> e1 [] ... [] OTHER -> e`; `None` guard = OTHER arm.
    Case(Vec<(Option<ExprId>, ExprId)>),

    Let { defs: Vec<Unit>, body: ExprId },

    /// `[A]_v` / `<<A>>_v`
    ActionSubscript { kind: SubscriptKind, action: ExprId, subscript: ExprId },
    /// `WF_v(A)` / `SF_v(A)`
    Fairness { kind: FairnessKind, subscript: ExprId, action: ExprId },

    /// `LAMBDA x, y : e`
    Lambda { params: Vec<(Sym, Span)>, body: ExprId },

    /// `lbl :: e` / `lbl(x, y) :: e` — label retained, semantics of `e`.
    Label { name: Sym, args: Vec<(Sym, Span)>, body: ExprId },
}

/// Declared operator shape in CONSTANT/RECURSIVE declarations and formal
/// parameters: plain `c`, or with arity like `f(_, _)` / `_ \prec _`.
#[derive(Debug)]
pub struct OpDecl {
    pub name: Sym,
    pub span: Span,
    pub arity: u32,
}

/// Formal parameter of an operator definition: `p` or higher-order
/// `p(_, ..., _)`.
#[derive(Debug)]
pub struct Param {
    pub name: Sym,
    pub span: Span,
    pub arity: u32,
}

#[derive(Debug)]
pub struct OpDef {
    pub name: Sym,
    pub span: Span,
    pub params: Vec<Param>,
    pub body: ExprId,
}

/// `f[x \in S, y \in T] == e` — recursive-capable function definition.
#[derive(Debug)]
pub struct FnDef {
    pub name: Sym,
    pub span: Span,
    pub bounds: Vec<Bound>,
    pub body: ExprId,
}

#[derive(Debug)]
pub struct InstanceDecl {
    /// `I == INSTANCE M WITH ...` name; `None` for plain `INSTANCE M`.
    pub def_name: Option<(Sym, Span, Vec<Param>)>,
    pub module: Sym,
    pub module_span: Span,
    pub with: Vec<(Sym, Span, ExprId)>,
}

#[derive(Debug)]
pub enum Unit {
    Variables(Vec<(Sym, Span)>),
    Constants(Vec<OpDecl>),
    Recursive(Vec<OpDecl>),
    OpDef { local: bool, def: OpDef },
    FnDef { local: bool, def: FnDef },
    Instance { local: bool, decl: InstanceDecl },
    Assume { name: Option<(Sym, Span)>, expr: ExprId },
    /// THEOREM/PROPOSITION — expression retained; attached proof was parsed
    /// and skipped (`had_proof`).
    Theorem { name: Option<(Sym, Span)>, expr: ExprId, had_proof: bool },
    Separator,
    Submodule(Module),
}

#[derive(Debug)]
pub struct Module {
    pub name: Sym,
    pub span: Span,
    pub extends: Vec<(Sym, Span)>,
    pub units: Vec<Unit>,
}

/// A parsed source file: root module plus its expression arena.
#[derive(Debug)]
pub struct SourceFile {
    pub module: Module,
    pub arena: ExprArena,
}
