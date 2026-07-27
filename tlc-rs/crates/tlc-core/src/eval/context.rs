//! Evaluation contexts — the analog of `tlc2/util/Context.java`: a
//! persistent cons-list from binding sites to bindings, cheaply cloned
//! (`Rc`-shared tails) so quantifier odometers and operator applications can
//! extend a context without copying it.
//!
//! Keys are semantic identities from the `sem` tables rather than SANY node
//! pointers: quantifier/CHOOSE/LET binders (`BinderId`), operator formal
//! parameters (`DefId` + index), and LET-bound definitions (`DefId`, for the
//! lazy/memoized bindings that mirror Java's `LazyValue`).

use std::cell::RefCell;
use std::rc::Rc;

use crate::intern::Sym;
use crate::sem::{BinderId, DefId, ModuleId};
use crate::syntax::ast::ExprId;
use crate::value::Value;

/// What a context entry is keyed by.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum CtxKey {
    /// A bound variable, LAMBDA parameter, EXCEPT `@`, or recursive-function
    /// self reference.
    Binder(BinderId),
    /// Formal parameter `index` of definition `def`.
    Param { def: DefId, index: u32 },
    /// A LET-bound definition carrying its lazily-evaluated value.
    Def(DefId),
}

/// What a name is bound to.
#[derive(Clone)]
pub enum Binding {
    /// An ordinary value.
    Val(Value),
    /// An operator passed as an argument (higher-order): a closure over the
    /// context where the argument was written.
    Op(OpBinding),
    /// A LET definition awaiting evaluation (Java `LazyValue`): the body is
    /// evaluated on first lookup in the captured context and cached iff the
    /// definition is constant-level.
    Lazy(Rc<LazyDef>),
    /// An operator argument bound lazily (Java `LazyValue` wrapping an
    /// argument expression at a call site): evaluated in the captured context
    /// each time it is used, so state-/action-level arguments read the states
    /// in scope at the *use* site. The init/next enumerators also descend
    /// into these structurally (the OPCODE_eq/in prime-binding cases).
    LazyExpr(Rc<LazyExpr>),
    /// The in-progress function of a recursive function definition
    /// `f[x \in S] == e`, applied point-by-point through a memo table.
    RecFn(Rc<RecFnState>),
}

/// An operator argument: user definition, LAMBDA, or builtin operator symbol
/// (`SortSeq(s, <)`-style references).
#[derive(Clone)]
pub enum OpBinding {
    Def { def: DefId, ctx: Ctx },
    Lambda { module: ModuleId, expr: ExprId, ctx: Ctx },
    Builtin(Sym),
}

pub struct LazyDef {
    pub def: DefId,
    /// Context at the LET site (excluding this binding itself).
    pub ctx: Ctx,
    pub cell: RefCell<Option<Value>>,
}

/// An argument expression captured with its call-site context. `cell`
/// caches the value after first evaluation, but only when the expression is
/// constant-level (mirroring Java's LazyValue cache rules).
pub struct LazyExpr {
    pub module: ModuleId,
    pub expr: ExprId,
    pub ctx: Ctx,
    pub cell: RefCell<Option<Value>>,
}

/// `{x \in S : P}` held unexpanded because `S` is not enumerable — the
/// analog of Java's `SetPredValue`. Membership tests evaluate `P` through
/// the evaluator; enumeration is an error (as for `Nat`).
impl std::fmt::Debug for LazySetPred {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "LazySetPred({:?})", self.expr)
    }
}

impl std::fmt::Debug for LazyFcn {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "LazyFcn")
    }
}

pub struct LazySetPred {
    pub module: ModuleId,
    /// The `SetFilter` expression node (carries the binder and predicate).
    pub expr: ExprId,
    pub ctx: Ctx,
    /// The evaluated domain (a possibly-symbolic set value).
    pub domain: Value,
    /// State snapshots at construction (Java `SetPredValue` copies s0/s1);
    /// the predicate later evaluates under these, not the ambient states.
    pub s0: crate::check::state::State,
    pub s1: crate::check::state::State,
}

/// A function constructor (or function definition) whose domain is not
/// enumerable — the analog of Java's `FcnLambdaValue`. Application binds the
/// argument after a domain-membership test; comparison/fingerprinting (which
/// would require materialization) are errors.
pub struct LazyFcn {
    pub module: ModuleId,
    pub src: LazyFcnSrc,
    pub ctx: Ctx,
    /// Evaluated domain value per `Bound` group, in source order.
    pub domains: Vec<Value>,
    /// `EXCEPT` updates applied lazily: `(argument, new value)`, later
    /// entries winning (Java keeps a pending-excepts list too).
    pub excepts: Vec<(Value, Value)>,
    /// State snapshots at construction (as `FcnLambdaValue` keeps the states
    /// its body must evaluate under).
    pub s0: crate::check::state::State,
    pub s1: crate::check::state::State,
}

/// Where a lazy function's bounds/body live.
#[derive(Clone, Copy)]
pub enum LazyFcnSrc {
    /// A `[x \in S |-> e]` expression node.
    Constructor(ExprId),
    /// A function definition `f[x \in S] == e`.
    FnDef(DefId),
}

/// Shared state of one evaluation of a recursive function definition.
pub struct RecFnState {
    pub def: DefId,
    pub module: ModuleId,
    pub body: ExprId,
    pub self_binder: BinderId,
    /// How a domain element decomposes into variable bindings (one entry per
    /// slot; see `eval::Slot`).
    pub slots: Vec<SlotBind>,
    /// The function's domain in construction order (unsorted).
    pub dom: Vec<Value>,
    pub memo: RefCell<Vec<Option<Value>>>,
    /// Context at the definition's evaluation site, WITHOUT the self
    /// binding (re-added per point to avoid an Rc cycle).
    pub base_ctx: Ctx,
}

/// One variable slot of a bound-variable list: either a single variable or
/// a tuple-destructuring group `<<x, y>> \in S`.
#[derive(Clone, Debug)]
pub enum SlotBind {
    One(BinderId),
    Tuple(Vec<BinderId>),
}

/// The persistent context. `Default`/`empty` is the empty context.
#[derive(Clone, Default)]
pub struct Ctx(Option<Rc<Frame>>);

struct Frame {
    key: CtxKey,
    binding: Binding,
    next: Ctx,
}

impl Ctx {
    pub fn empty() -> Ctx {
        Ctx(None)
    }

    /// Extend with one binding (the original context is unchanged).
    pub fn bind(&self, key: CtxKey, binding: Binding) -> Ctx {
        Ctx(Some(Rc::new(Frame { key, binding, next: self.clone() })))
    }

    /// Innermost binding for `key`.
    pub fn lookup(&self, key: CtxKey) -> Option<&Binding> {
        let mut cur = self;
        while let Some(f) = &cur.0 {
            if f.key == key {
                return Some(&f.binding);
            }
            cur = &f.next;
        }
        None
    }
}
