//! TLC values: representation, total-order comparison, fingerprints, and
//! printing — ported from `tlc2/value/impl` (SetEnumValue, FcnRcdValue,
//! TupleValue, RecordValue, IntervalValue, IntValue, StringValue, BoolValue,
//! ModelValue) and `tlc2/value/ValueConstants.java`.
//!
//! Key semantics preserved from Java TLC:
//! - **Composite values are always normalized at construction** (sets sorted
//!   and deduped, records sorted by field-name string, function records
//!   sorted by domain element), instead of Java's destructive `normalize()`.
//! - **Function/record/tuple/sequence unification**: `<<1, 2>>` equals
//!   `[i \in 1..2 |-> i]` equals the record-free function over `{1, 2}` —
//!   all three compare equal and fingerprint under the `FCNRCDVALUE` scheme,
//!   exactly as `TupleValue.fingerPrint`/`RecordValue.fingerPrint` do.
//!   Likewise `IntervalValue` is just a set: `1..2 = {1, 2}` and both
//!   fingerprint under `SETENUMVALUE`.
//! - **Comparison is partial**: comparing an integer with a non-integer (or
//!   any cross-kind pair outside the unifications above) is a user error
//!   (`Diag`, category `Eval`), not an ordering.
//! - **Model values**: untyped model values compare with anything (ordered
//!   below all non-model values, by name among themselves); typed model
//!   values (`τ_` name prefix) compare only with same-typed or untyped model
//!   values.
//!
//! Known deviations from Java (all deterministic-by-content where Java
//! depends on `UniqueString` interning order):
//! - Strings and record field names order by their string contents (Rust
//!   byte order), not by `UniqueString.tok` creation order.
//! - `Int` is `i64` (TLC's is 32-bit); integer fingerprint payloads are 8
//!   bytes instead of 4.
//! - Model-value fingerprints hash the name string, not the interning token.

pub mod enumerate;
pub mod fp;

use std::cmp::Ordering;
use std::rc::Rc;

use crate::diag::{Category, Diag};
use crate::eval::context::{LazyFcn, LazySetPred};
use crate::intern::{Interner, Sym};

use self::fp::Fp64Table;

/// Value-kind tags from `tlc2/value/ValueConstants.java`; only the tags that
/// appear in fingerprints are needed.
const BOOLVALUE: u8 = 0;
const INTVALUE: u8 = 1;
const STRINGVALUE: u8 = 3;
const SETENUMVALUE: u8 = 5;
const FCNRCDVALUE: u8 = 9;
const MODELVALUE: u8 = 21;

/// Everything comparison, fingerprinting, and printing need: the interner
/// (strings and record fields order by string contents) and the FP64 table.
pub struct ValueCtx<'a> {
    pub interner: &'a Interner,
    pub fp: &'a Fp64Table,
}

/// Evaluation hook for lazy predicate sets: `{x \in S : P}` needs the
/// expression evaluator to decide membership or expand, but comparison and
/// fingerprinting live in this layer. The evaluator installs itself for the
/// duration of a checking run via [`install_lazy_eval`]; without a hook,
/// operations that would need one produce a clean diagnostic.
pub trait LazyEval {
    fn set_pred_member(
        &self,
        sp: &LazySetPred,
        elem: &Value,
        ctx: &ValueCtx,
    ) -> Result<bool, Diag>;
    fn set_pred_elems(
        &self,
        sp: &LazySetPred,
        ctx: &ValueCtx,
        limit: usize,
    ) -> Result<Vec<Value>, Diag>;
}

thread_local! {
    static LAZY_HOOK: std::cell::Cell<Option<*const dyn LazyEval>> =
        const { std::cell::Cell::new(None) };
}

/// Install `hook` as the current lazy-set evaluator; restored (to the
/// previous hook) when the guard drops. The caller must keep `hook` alive
/// for the guard's lifetime — guaranteed by the borrow held in the guard's
/// lifetime parameter.
pub fn install_lazy_eval<'h>(hook: &'h dyn LazyEval) -> LazyEvalGuard<'h> {
    let ptr: *const (dyn LazyEval + 'h) = hook;
    // SAFETY: lifetime erasure only — the guard removes the pointer before
    // 'h ends (it holds 'h), and reads go through `with_lazy_hook` while
    // the guard is alive.
    let ptr: *const (dyn LazyEval + 'static) = unsafe { std::mem::transmute(ptr) };
    let prev = LAZY_HOOK.with(|c| c.replace(Some(ptr)));
    LazyEvalGuard { prev, _marker: std::marker::PhantomData }
}

pub struct LazyEvalGuard<'h> {
    prev: Option<*const dyn LazyEval>,
    _marker: std::marker::PhantomData<&'h ()>,
}

impl Drop for LazyEvalGuard<'_> {
    fn drop(&mut self) {
        LAZY_HOOK.with(|c| c.set(self.prev));
    }
}

fn with_lazy_hook<R>(f: impl FnOnce(Option<&dyn LazyEval>) -> R) -> R {
    LAZY_HOOK.with(|c| {
        let p = c.get();
        // SAFETY: the pointer was installed from a live borrow whose guard
        // is still on the stack (it removes the pointer on drop), and
        // evaluation is single-threaded.
        f(p.map(|p| unsafe { &*p }))
    })
}

fn no_hook_err(what: &str) -> Diag {
    eval_err(
        "E1198",
        format!("cannot {what} a lazy predicate set in this context"),
    )
}

/// Cardinality guard applied when a symbolic set (`SUBSET S`, `[S -> T]`,
/// ...) must be expanded *inside* the value layer (comparison and
/// fingerprinting, where no evaluator limits are in scope). The evaluator's
/// own `EvalLimits::enum_limit` defaults to the same number.
pub const DEFAULT_ENUM_LIMIT: usize = 1_000_000;

/// A TLC value. Composite variants are always in normal form (see module
/// docs); construct them through [`Value::set_enum`], [`Value::record`], and
/// [`Value::fcn_rcd`] to maintain that invariant.
#[derive(Clone, Debug)]
pub enum Value {
    Bool(bool),
    Int(i64),
    Str(Sym),
    /// A model value; `ty` is the `τ` prefix of a `τ_...` name, if any.
    Model { name: Sym, ty: Option<Sym> },
    /// Always sorted and deduplicated.
    SetEnum(Rc<Vec<Value>>),
    /// The integer interval `lo..hi`; empty when `lo > hi`.
    Interval { lo: i64, hi: i64 },
    Tuple(Rc<Vec<Value>>),
    /// Always sorted by field-name string contents.
    Record(Rc<Vec<(Sym, Value)>>),
    /// Parallel domain/range arrays, always sorted by domain element.
    FcnRcd { dom: Rc<Vec<Value>>, rng: Rc<Vec<Value>> },

    // ---- symbolic (unexpanded) sets, the analog of SetOfFcnsValue,
    // SubsetValue, SetOfRcdsValue, SetOfTuplesValue and the Nat/Int/BOOLEAN/
    // STRING module sets. Membership tests avoid expansion; comparison and
    // fingerprinting expand under [`DEFAULT_ENUM_LIMIT`] as Java converts to
    // SetEnumValue. ----
    /// `[S -> T]`, unexpanded.
    SetOfFcns { dom: Rc<Value>, rng: Rc<Value> },
    /// `SUBSET S`, unexpanded.
    Subset(Rc<Value>),
    /// `[h1: S1, ..., hn: Sn]`, unexpanded; fields sorted by name string.
    SetOfRcds(Rc<Vec<(Sym, Value)>>),
    /// `S1 \X S2 \X ... \X Sn`, unexpanded.
    SetOfTuples(Rc<Vec<Value>>),
    /// `BOOLEAN` (expands to `{FALSE, TRUE}`).
    BoolSet,
    /// `STRING` — membership-only, not enumerable.
    StringSet,
    /// `Nat` — membership-only, not enumerable.
    NatSet,
    /// `Int` — membership-only, not enumerable.
    IntSet,
    /// `{x \in S : P}` over a non-enumerable `S` (Java `SetPredValue`);
    /// membership evaluates the predicate (evaluator-level), enumeration is
    /// an error.
    SetPred(Rc<LazySetPred>),
    /// `S \cup T` where a side is not enumerable (Java `SetCupValue`);
    /// membership tests both sides without expansion.
    SetCup(Rc<Value>, Rc<Value>),
    /// A function over a non-enumerable domain (Java `FcnLambdaValue`);
    /// application is evaluator-level, comparison/fingerprinting error.
    FcnLambda(Rc<LazyFcn>),
    /// `Seq(S)` — the infinite set of finite sequences over S
    /// (membership-only, like `Nat`).
    SeqSet(Rc<Value>),
    /// `S \ T` with a non-enumerable side (Java `SetDiffValue`).
    SetDiff(Rc<Value>, Rc<Value>),
    /// `S \cap T` with a non-enumerable side (Java `SetCapValue`).
    SetCap(Rc<Value>, Rc<Value>),
}

/// Coarse kinds for comparison dispatch. `Set` covers SetEnum/Interval,
/// `Fcn` covers Tuple/Record/FcnRcd (the unification classes).
#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Bool,
    Int,
    Str,
    Model,
    Set,
    Fcn,
}

fn eval_err(code: &'static str, message: String) -> Diag {
    Diag::new(Category::Eval, code, message)
}

/// Merge sort with a fallible comparator (comparison errors abort the sort).
fn sort_fallible<T>(
    items: Vec<T>,
    cmp: &mut dyn FnMut(&T, &T) -> Result<Ordering, Diag>,
) -> Result<Vec<T>, Diag> {
    if items.len() <= 1 {
        return Ok(items);
    }
    let mut left = items;
    let right = left.split_off(left.len() / 2);
    let left = sort_fallible(left, cmp)?;
    let right = sort_fallible(right, cmp)?;
    let mut out = Vec::with_capacity(left.len() + right.len());
    let mut li = left.into_iter().peekable();
    let mut ri = right.into_iter().peekable();
    loop {
        match (li.peek(), ri.peek()) {
            (Some(l), Some(r)) => {
                if cmp(l, r)? == Ordering::Greater {
                    out.push(ri.next().expect("peeked"));
                } else {
                    out.push(li.next().expect("peeked"));
                }
            }
            (Some(_), None) => out.push(li.next().expect("peeked")),
            (None, Some(_)) => out.push(ri.next().expect("peeked")),
            (None, None) => break,
        }
    }
    Ok(out)
}

impl Value {
    // ----- constructors (normalize eagerly) -----

    /// Build a set from `items`: sort and deduplicate, as
    /// `SetEnumValue.normalize` (`ValueVec.sort(true)`) does. Comparison
    /// errors (e.g. `{1, "a"}`) propagate.
    pub fn set_enum(items: Vec<Value>, ctx: &ValueCtx) -> Result<Value, Diag> {
        let sorted = sort_fallible(items, &mut |a, b| a.tla_cmp(b, ctx))?;
        let mut elems: Vec<Value> = Vec::with_capacity(sorted.len());
        for v in sorted {
            match elems.last() {
                Some(prev) if prev.tla_cmp(&v, ctx)? == Ordering::Equal => {}
                _ => elems.push(v),
            }
        }
        Ok(Value::SetEnum(Rc::new(elems)))
    }

    /// The integer interval `lo..hi` (empty when `lo > hi`).
    pub fn interval(lo: i64, hi: i64) -> Value {
        Value::Interval { lo, hi }
    }

    /// Tuples need no normalization (their domain is implicitly `1..n`).
    pub fn tuple(items: Vec<Value>) -> Value {
        Value::Tuple(Rc::new(items))
    }

    /// Build a record: sort fields by name string, erroring on a duplicate
    /// field, as `RecordValue.normalize` does.
    pub fn record(mut fields: Vec<(Sym, Value)>, ctx: &ValueCtx) -> Result<Value, Diag> {
        fields.sort_by(|a, b| ctx.interner.str(a.0).cmp(ctx.interner.str(b.0)));
        for w in fields.windows(2) {
            if w[0].0 == w[1].0 {
                return Err(eval_err(
                    "E1104",
                    format!(
                        "Field name {} occurs multiple times in record.",
                        ctx.interner.str(w[0].0)
                    ),
                ));
            }
        }
        Ok(Value::Record(Rc::new(fields)))
    }

    /// Build a function record from parallel arrays: sort pairs by domain
    /// element, erroring on duplicates, as `FcnRcdValue.normalize` does.
    pub fn fcn_rcd(dom: Vec<Value>, rng: Vec<Value>, ctx: &ValueCtx) -> Result<Value, Diag> {
        assert_eq!(dom.len(), rng.len(), "fcn_rcd: dom/rng length mismatch");
        let pairs: Vec<(Value, Value)> = dom.into_iter().zip(rng).collect();
        let pairs = sort_fallible(pairs, &mut |a, b| a.0.tla_cmp(&b.0, ctx))?;
        for w in pairs.windows(2) {
            if w[0].0.tla_cmp(&w[1].0, ctx)? == Ordering::Equal {
                return Err(eval_err(
                    "E1103",
                    format!(
                        "The value\n{}\noccurs multiple times in the function domain.",
                        w[0].0.display(ctx)
                    ),
                ));
            }
        }
        let (dom, rng): (Vec<Value>, Vec<Value>) = pairs.into_iter().unzip();
        Ok(Value::FcnRcd { dom: Rc::new(dom), rng: Rc::new(rng) })
    }

    /// A model value; a name of the shape `τ_...` (at least three chars,
    /// second one `_`) is typed with type `τ`, as in `ModelValue`'s
    /// constructor.
    pub fn model(name: &str, interner: &mut Interner) -> Value {
        let mut chars = name.chars();
        let ty = match (chars.next(), chars.next(), chars.next()) {
            (Some(t), Some('_'), Some(_)) => Some(interner.intern(&t.to_string())),
            _ => None,
        };
        Value::Model { name: interner.intern(name), ty }
    }

    // ----- comparison -----

    fn kind(&self) -> Kind {
        match self {
            Value::Bool(_) => Kind::Bool,
            Value::Int(_) => Kind::Int,
            Value::Str(_) => Kind::Str,
            Value::Model { .. } => Kind::Model,
            Value::SetEnum(_) | Value::Interval { .. } => Kind::Set,
            Value::Tuple(_) | Value::Record(_) | Value::FcnRcd { .. } => Kind::Fcn,
            Value::SetOfFcns { .. }
            | Value::Subset(_)
            | Value::SetOfRcds(_)
            | Value::SetOfTuples(_)
            | Value::BoolSet
            | Value::StringSet
            | Value::NatSet
            | Value::IntSet
            | Value::SetPred(_)
            | Value::SetCup(_, _)
            | Value::SeqSet(_)
            | Value::SetDiff(_, _)
            | Value::SetCap(_, _) => Kind::Set,
            Value::FcnLambda(_) => Kind::Fcn,
        }
    }

    /// A set that is held unexpanded (must be expanded for cmp/fp).
    fn is_symbolic_set(&self) -> bool {
        matches!(
            self,
            Value::SetOfFcns { .. }
                | Value::Subset(_)
                | Value::SetOfRcds(_)
                | Value::SetOfTuples(_)
                | Value::BoolSet
                | Value::StringSet
                | Value::NatSet
                | Value::IntSet
                | Value::SetPred(_)
                | Value::SetCup(_, _)
                | Value::SeqSet(_)
                | Value::SetDiff(_, _)
                | Value::SetCap(_, _)
        )
    }

    /// TLC's total order on comparable values; comparing incomparable values
    /// is a user error, exactly as the Java `compareTo` methods `Assert.fail`.
    pub fn tla_cmp(&self, other: &Value, ctx: &ValueCtx) -> Result<Ordering, Diag> {
        use Value::*;
        match (self, other) {
            // Model values first: they interact with every kind.
            (Model { name: a, ty: ta }, Model { name: b, ty: tb }) => match (ta, tb) {
                (None, _) | (_, None) => Ok(ctx.interner.str(*a).cmp(ctx.interner.str(*b))),
                (Some(x), Some(y)) if x == y => {
                    Ok(ctx.interner.str(*a).cmp(ctx.interner.str(*b)))
                }
                _ => Err(eval_err(
                    "E1102",
                    format!(
                        "Attempted to compare the differently-typed model values {} and {}",
                        self.display(ctx),
                        other.display(ctx)
                    ),
                )),
            },
            // An untyped model value is below every non-model value
            // (ModelValue.compareTo returns -1; modelValueCompareTo returns 1).
            (Model { ty: None, .. }, _) => Ok(Ordering::Less),
            (_, Model { ty: None, .. }) => Ok(Ordering::Greater),
            (Model { ty: Some(_), .. }, _) | (_, Model { ty: Some(_), .. }) => {
                let (mv, nv) =
                    if matches!(self, Model { .. }) { (self, other) } else { (other, self) };
                Err(eval_err(
                    "E1102",
                    format!(
                        "Attempted to compare the typed model value {} and non-model value\n{}",
                        mv.display(ctx),
                        nv.display(ctx)
                    ),
                ))
            }
            (Bool(a), Bool(b)) => Ok(a.cmp(b)),
            (Int(a), Int(b)) => Ok(a.cmp(b)),
            (Str(a), Str(b)) => {
                if a == b {
                    Ok(Ordering::Equal)
                } else {
                    Ok(ctx.interner.str(*a).cmp(ctx.interner.str(*b)))
                }
            }
            _ => match (self.kind(), other.kind()) {
                (Kind::Set, Kind::Set) => {
                    if self.is_symbolic_set() || other.is_symbolic_set() {
                        // Same non-enumerable marker set: trivially equal
                        // (`Nat = Nat`), no expansion needed.
                        match (self, other) {
                            (Value::NatSet, Value::NatSet)
                            | (Value::IntSet, Value::IntSet)
                            | (Value::StringSet, Value::StringSet)
                            | (Value::BoolSet, Value::BoolSet) => {
                                return Ok(Ordering::Equal)
                            }
                            // Java's UserObj ordering: Nat < Int.
                            (Value::NatSet, Value::IntSet) => return Ok(Ordering::Less),
                            (Value::IntSet, Value::NatSet) => return Ok(Ordering::Greater),
                            _ => {}
                        }
                        // As Java: convert to SetEnumValue and compare.
                        let a = self.expand_to_set_enum(ctx, DEFAULT_ENUM_LIMIT)?;
                        let b = other.expand_to_set_enum(ctx, DEFAULT_ENUM_LIMIT)?;
                        a.set_cmp(&b, ctx)
                    } else {
                        self.set_cmp(other, ctx)
                    }
                }
                (Kind::Fcn, Kind::Fcn) => self.fcn_cmp(other, ctx),
                _ => Err(self.cmp_kind_err(other, ctx)),
            },
        }
    }

    /// Equality is agreement under [`Value::tla_cmp`]; the same pairs that
    /// error in Java's `equals` error here.
    pub fn tla_eq(&self, other: &Value, ctx: &ValueCtx) -> Result<bool, Diag> {
        Ok(self.tla_cmp(other, ctx)? == Ordering::Equal)
    }

    /// The cross-kind comparison error, phrased per the Java receiver's
    /// message (IntValue/BoolValue/StringValue/SetEnumValue/FcnRcdValue).
    fn cmp_kind_err(&self, other: &Value, ctx: &ValueCtx) -> Diag {
        let msg = match self.kind() {
            Kind::Int => format!(
                "Attempted to compare integer {} with non-integer:\n{}",
                self.display(ctx),
                other.display(ctx)
            ),
            Kind::Bool => format!(
                "Attempted to compare boolean {} with non-boolean:\n{}",
                self.display(ctx),
                other.display(ctx)
            ),
            Kind::Str => format!(
                "Attempted to compare string {} with non-string:\n{}",
                self.display(ctx),
                other.display(ctx)
            ),
            Kind::Set => format!(
                "Attempted to compare the set {} with the value:\n{}",
                self.display(ctx),
                other.display(ctx)
            ),
            Kind::Fcn => format!(
                "Attempted to compare the function {} with the value:\n{}",
                self.display(ctx),
                other.display(ctx)
            ),
            Kind::Model => unreachable!("model values are handled before kind dispatch"),
        };
        eval_err("E1101", msg)
    }

    /// Number of elements of a set value (`Interval` may exceed `u32`).
    fn set_size(&self) -> i128 {
        match self {
            Value::SetEnum(elems) => elems.len() as i128,
            Value::Interval { lo, hi } => {
                if lo > hi {
                    0
                } else {
                    i128::from(*hi) - i128::from(*lo) + 1
                }
            }
            _ => unreachable!("set_size on non-set"),
        }
    }

    /// Set comparison: cardinality first, then elements lexicographically in
    /// sorted order (`SetEnumValue.compareTo`, `IntervalValue.compareTo`).
    fn set_cmp(&self, other: &Value, ctx: &ValueCtx) -> Result<Ordering, Diag> {
        let (sa, sb) = (self.set_size(), other.set_size());
        if sa != sb {
            return Ok(sa.cmp(&sb));
        }
        // Interval fast path (IntervalValue.compareTo): equal sizes, so the
        // lows decide; empty intervals are equal regardless of bounds.
        if let (Value::Interval { lo: a, .. }, Value::Interval { lo: b, .. }) = (self, other) {
            if sa == 0 {
                return Ok(Ordering::Equal);
            }
            return Ok(a.cmp(b));
        }
        // At least one side is a SetEnum, so the common size fits in memory.
        let mut ia = self.set_elems();
        let mut ib = other.set_elems();
        while let (Some(a), Some(b)) = (ia.next(), ib.next()) {
            let cmp = a.tla_cmp(&b, ctx)?;
            if cmp != Ordering::Equal {
                return Ok(cmp);
            }
        }
        Ok(Ordering::Equal)
    }

    /// The elements of a set value in normalized (sorted) order.
    fn set_elems(&self) -> SetElems<'_> {
        match self {
            Value::SetEnum(elems) => SetElems::Enum(elems.iter()),
            Value::Interval { lo, hi } => SetElems::Interval { next: *lo, hi: *hi, done: lo > hi },
            _ => unreachable!("set_elems on non-set"),
        }
    }

    /// The canonical function view of a composite value (Tuple/Record/FcnRcd
    /// are all functions in TLA+); all comparison and fingerprinting of
    /// composites routes through this.
    fn fcn_view(&self) -> FcnView<'_> {
        match self {
            Value::Tuple(elems) => FcnView::Tuple(elems),
            Value::Record(fields) => FcnView::Record(fields),
            Value::FcnRcd { dom, rng } => FcnView::Fcn { dom, rng },
            _ => unreachable!("fcn_view on non-function"),
        }
    }

    /// Function comparison: size first, then domains lexicographically, then
    /// ranges lexicographically (`FcnRcdValue.compareTo` and the equivalent
    /// Tuple/Record specializations).
    fn fcn_cmp(&self, other: &Value, ctx: &ValueCtx) -> Result<Ordering, Diag> {
        if matches!(self, Value::FcnLambda(_)) || matches!(other, Value::FcnLambda(_)) {
            return Err(eval_err(
                "E1197",
                format!(
                    "Attempted to compare a function over a non-enumerable domain:\n{}",
                    self.display(ctx)
                ),
            ));
        }
        let a = self.fcn_view();
        let b = other.fcn_view();
        let cmp = a.len().cmp(&b.len());
        if cmp != Ordering::Equal {
            return Ok(cmp);
        }
        for i in 0..a.len() {
            let cmp = a.dom_value(i).tla_cmp(&b.dom_value(i), ctx)?;
            if cmp != Ordering::Equal {
                return Ok(cmp);
            }
        }
        for i in 0..a.len() {
            let cmp = a.rng(i).tla_cmp(b.rng(i), ctx)?;
            if cmp != Ordering::Equal {
                return Ok(cmp);
            }
        }
        Ok(Ordering::Equal)
    }

    // ----- symbolic-set expansion, cardinality, membership -----

    /// Number of elements of any set value without expanding it, `i128::MAX`
    /// on arithmetic overflow (still correctly rejected by any real limit).
    /// Errors on non-sets and on the non-enumerable Nat/Int/STRING.
    pub fn set_card(&self, ctx: &ValueCtx) -> Result<i128, Diag> {
        match self {
            Value::SetEnum(elems) => Ok(elems.len() as i128),
            Value::Interval { .. } => Ok(self.set_size()),
            Value::BoolSet => Ok(2),
            Value::Subset(s) => {
                let n = s.set_card(ctx)?;
                if n >= 127 {
                    Ok(i128::MAX)
                } else {
                    Ok(1i128 << n)
                }
            }
            Value::SetOfFcns { dom, rng } => {
                let d = dom.set_card(ctx)?;
                let r = rng.set_card(ctx)?;
                let exp = u32::try_from(d).unwrap_or(u32::MAX);
                Ok(r.checked_pow(exp).unwrap_or(i128::MAX))
            }
            Value::SetOfRcds(fields) => {
                let mut card = 1i128;
                for (_, s) in fields.iter() {
                    let n = s.set_card(ctx)?;
                    card = card.checked_mul(n).unwrap_or(i128::MAX);
                }
                Ok(card)
            }
            Value::SetOfTuples(sets) => {
                let mut card = 1i128;
                for s in sets.iter() {
                    let n = s.set_card(ctx)?;
                    card = card.checked_mul(n).unwrap_or(i128::MAX);
                }
                Ok(card)
            }
            Value::NatSet | Value::IntSet | Value::StringSet | Value::SeqSet(_) => {
                Err(eval_err(
                    "E1107",
                    format!(
                        "Attempted to enumerate the non-enumerable set {}.",
                        self.display(ctx)
                    ),
                ))
            }
            Value::SetPred(sp) => with_lazy_hook(|h| match h {
                Some(h) => Ok(h.set_pred_elems(sp, ctx, DEFAULT_ENUM_LIMIT)?.len() as i128),
                None => Err(no_hook_err("enumerate")),
            }),
            // Over-approximations: only used by the enumeration guard.
            Value::SetDiff(l, _) => l.set_card(ctx),
            Value::SetCap(l, _) => l.set_card(ctx),
            Value::SetCup(l, r) => {
                // Over-approximation (duplicates uncounted) — only used for
                // the enumeration guard; expansion dedups.
                let a = l.set_card(ctx)?;
                let b = r.set_card(ctx)?;
                Ok(a.checked_add(b).unwrap_or(i128::MAX))
            }
            _ => Err(eval_err(
                "E1106",
                format!("Attempted to enumerate a non-set value:\n{}", self.display(ctx)),
            )),
        }
    }

    /// The "too big to enumerate" guard shared by every expansion site.
    fn enum_guard(&self, ctx: &ValueCtx, limit: usize) -> Result<usize, Diag> {
        let card = self.set_card(ctx)?;
        if card > limit as i128 {
            return Err(eval_err(
                "E1108",
                format!(
                    "Attempted to enumerate a set that is too big:\n{}\n({} elements; the limit is {}).",
                    self.display(ctx),
                    if card == i128::MAX { "more than 2^127".to_string() } else { card.to_string() },
                    limit
                ),
            ));
        }
        Ok(card as usize)
    }

    /// The elements of this set in normalized (sorted, deduplicated) order,
    /// expanding symbolic sets under the `limit` cardinality guard.
    pub fn expanded_elems(&self, ctx: &ValueCtx, limit: usize) -> Result<Vec<Value>, Diag> {
        // Lazy variants expand through the evaluator hook / by filtering,
        // before the cardinality guard (their size is not known upfront).
        match self {
            Value::SetPred(sp) => {
                return with_lazy_hook(|h| match h {
                    Some(h) => h.set_pred_elems(sp, ctx, limit),
                    None => Err(no_hook_err("enumerate")),
                })
            }
            Value::SetDiff(l, r) => {
                let mut kept = Vec::new();
                for e in l.expanded_elems(ctx, limit)? {
                    if !r.member(&e, ctx)? {
                        kept.push(e);
                    }
                }
                return Ok(kept);
            }
            Value::SetCap(l, r) => {
                let mut kept = Vec::new();
                for e in l.expanded_elems(ctx, limit)? {
                    if r.member(&e, ctx)? {
                        kept.push(e);
                    }
                }
                return Ok(kept);
            }
            _ => {}
        }
        let card = self.enum_guard(ctx, limit)?;
        match self {
            Value::SetEnum(elems) => Ok(elems.as_ref().clone()),
            Value::Interval { .. } => Ok(self.set_elems().collect()),
            Value::BoolSet => Ok(vec![Value::Bool(false), Value::Bool(true)]),
            Value::Subset(s) => {
                // Bitmask enumeration over the (sorted) base elements: each
                // mask yields an already-normalized SetEnum.
                let base = s.expanded_elems(ctx, limit)?;
                let mut subsets = Vec::with_capacity(card);
                for mask in 0..(1usize << base.len()) {
                    let sub: Vec<Value> = base
                        .iter()
                        .enumerate()
                        .filter(|(i, _)| mask & (1 << i) != 0)
                        .map(|(_, v)| v.clone())
                        .collect();
                    subsets.push(Value::SetEnum(Rc::new(sub)));
                }
                sorted_distinct(subsets, ctx)
            }
            Value::SetOfFcns { dom, rng } => {
                // Odometer over |rng|^|dom| range choices; the shared domain
                // is sorted, so each function is a valid normalized FcnRcd.
                let dom_elems = Rc::new(dom.expanded_elems(ctx, limit)?);
                let rng_elems = rng.expanded_elems(ctx, limit)?;
                let mut fcns = Vec::with_capacity(card);
                product_foreach(dom_elems.len(), rng_elems.len(), |choice| {
                    let vals: Vec<Value> = choice.iter().map(|&i| rng_elems[i].clone()).collect();
                    fcns.push(Value::FcnRcd { dom: dom_elems.clone(), rng: Rc::new(vals) });
                    Ok(())
                })?;
                sorted_distinct(fcns, ctx)
            }
            Value::SetOfRcds(fields) => {
                let mut parts: Vec<Vec<Value>> = Vec::with_capacity(fields.len());
                for (_, s) in fields.iter() {
                    parts.push(s.expanded_elems(ctx, limit)?);
                }
                let mut rcds = Vec::with_capacity(card);
                mixed_product_foreach(&parts, |choice| {
                    // Field names are pre-sorted, so this is a valid Record.
                    let pairs: Vec<(Sym, Value)> = fields
                        .iter()
                        .enumerate()
                        .map(|(k, (name, _))| (*name, parts[k][choice[k]].clone()))
                        .collect();
                    rcds.push(Value::Record(Rc::new(pairs)));
                    Ok(())
                })?;
                sorted_distinct(rcds, ctx)
            }
            Value::SetOfTuples(sets) => {
                let mut parts: Vec<Vec<Value>> = Vec::with_capacity(sets.len());
                for s in sets.iter() {
                    parts.push(s.expanded_elems(ctx, limit)?);
                }
                let mut tups = Vec::with_capacity(card);
                mixed_product_foreach(&parts, |choice| {
                    let elems: Vec<Value> =
                        choice.iter().enumerate().map(|(k, &i)| parts[k][i].clone()).collect();
                    tups.push(Value::tuple(elems));
                    Ok(())
                })?;
                sorted_distinct(tups, ctx)
            }
            Value::SetCup(l, r) => {
                let mut elems = l.expanded_elems(ctx, limit)?;
                elems.extend(r.expanded_elems(ctx, limit)?);
                let sorted = sort_fallible(elems, &mut |a, b| a.tla_cmp(b, ctx))?;
                let mut out: Vec<Value> = Vec::with_capacity(sorted.len());
                for v in sorted {
                    match out.last() {
                        Some(prev) if prev.tla_cmp(&v, ctx)? == Ordering::Equal => {}
                        _ => out.push(v),
                    }
                }
                Ok(out)
            }
            _ => unreachable!("enum_guard rejects non-enumerable values"),
        }
    }

    /// Expand a (possibly symbolic) set to a normalized `SetEnum` under the
    /// `limit` cardinality guard, as Java's `toSetEnum` conversions do.
    pub fn expand_to_set_enum(&self, ctx: &ValueCtx, limit: usize) -> Result<Value, Diag> {
        Ok(Value::SetEnum(Rc::new(self.expanded_elems(ctx, limit)?)))
    }

    /// `elem \in self` for any set value — symbolic sets test membership
    /// WITHOUT expansion, as `SetOfFcnsValue.member` and friends do.
    pub fn member(&self, elem: &Value, ctx: &ValueCtx) -> Result<bool, Diag> {
        // Untyped model values are members of nothing but compare with
        // everything; typed ones only mix with sets of their own type
        // (delegated to tla_cmp in the enumerated cases below).
        match self {
            Value::SetEnum(elems) => {
                for e in elems.iter() {
                    if elem.tla_cmp(e, ctx)? == Ordering::Equal {
                        return Ok(true);
                    }
                }
                Ok(false)
            }
            Value::Interval { lo, hi } => match elem {
                Value::Int(i) => Ok(*lo <= *i && *i <= *hi),
                Value::Model { ty: None, .. } => Ok(false),
                // An empty interval contains nothing, whatever the element's
                // kind (IntervalValue.member only faults when low <= high).
                _ if lo > hi => Ok(false),
                _ => Err(eval_err(
                    "E1109",
                    format!(
                        "Attempted to check if the value:\n{}\nis in the integer interval {}.",
                        elem.display(ctx),
                        self.display(ctx)
                    ),
                )),
            },
            Value::BoolSet => match elem {
                Value::Bool(_) => Ok(true),
                Value::Model { ty: None, .. } => Ok(false),
                _ => Err(self.member_kind_err(elem, ctx)),
            },
            Value::StringSet => match elem {
                Value::Str(_) => Ok(true),
                Value::Model { ty: None, .. } => Ok(false),
                _ => Err(self.member_kind_err(elem, ctx)),
            },
            Value::NatSet => match elem {
                Value::Int(i) => Ok(*i >= 0),
                Value::Model { ty: None, .. } => Ok(false),
                _ => Err(self.member_kind_err(elem, ctx)),
            },
            Value::IntSet => match elem {
                Value::Int(_) => Ok(true),
                Value::Model { ty: None, .. } => Ok(false),
                _ => Err(self.member_kind_err(elem, ctx)),
            },
            // f \in [S -> T]: DOMAIN f = S and every range value in T
            // (SetOfFcnsValue.member — no expansion of [S -> T]).
            Value::SetOfFcns { dom, rng } => {
                if matches!(elem, Value::Model { ty: None, .. }) {
                    return Ok(false);
                }
                let view = match elem {
                    Value::Tuple(_) | Value::Record(_) | Value::FcnRcd { .. } => elem.fcn_view(),
                    _ => {
                        return Err(eval_err(
                            "E1110",
                            format!(
                                "Attempted to check if\n{}\nwhich is not a TLC function value, \
                                 is in the set of functions:\n{}",
                                elem.display(ctx),
                                self.display(ctx)
                            ),
                        ))
                    }
                };
                let edom: Vec<Value> = (0..view.len()).map(|i| view.dom_value(i)).collect();
                let edom = Value::SetEnum(Rc::new(edom));
                if edom.tla_cmp(dom, ctx)? != Ordering::Equal {
                    return Ok(false);
                }
                for i in 0..view.len() {
                    if !rng.member(view.rng(i), ctx)? {
                        return Ok(false);
                    }
                }
                Ok(true)
            }
            Value::SetOfRcds(fields) => {
                if matches!(elem, Value::Model { ty: None, .. }) {
                    return Ok(false);
                }
                let Some(pairs) = elem.as_record_pairs(ctx) else {
                    return Err(eval_err(
                        "E1110",
                        format!(
                            "Attempted to check if\n{}\nwhich is not a record, is in the set \
                             of records:\n{}",
                            elem.display(ctx),
                            self.display(ctx)
                        ),
                    ));
                };
                if pairs.len() != fields.len() {
                    return Ok(false);
                }
                for ((fname, fset), (ename, eval)) in fields.iter().zip(&pairs) {
                    if ctx.interner.str(*fname) != ctx.interner.str(*ename) {
                        return Ok(false);
                    }
                    if !fset.member(eval, ctx)? {
                        return Ok(false);
                    }
                }
                Ok(true)
            }
            Value::SetOfTuples(sets) => {
                if matches!(elem, Value::Model { ty: None, .. }) {
                    return Ok(false);
                }
                let Some(elems) = elem.as_tuple_elems() else {
                    return Err(eval_err(
                        "E1110",
                        format!(
                            "Attempted to check if\n{}\nwhich is not a tuple, is in the set \
                             of tuples:\n{}",
                            elem.display(ctx),
                            self.display(ctx)
                        ),
                    ));
                };
                if elems.len() != sets.len() {
                    return Ok(false);
                }
                for (s, e) in sets.iter().zip(&elems) {
                    if !s.member(e, ctx)? {
                        return Ok(false);
                    }
                }
                Ok(true)
            }
            // e \in SUBSET S: every element of e is in S (needs e's elements
            // but never expands SUBSET S itself).
            Value::Subset(s) => {
                if matches!(elem, Value::Model { ty: None, .. }) {
                    return Ok(false);
                }
                if elem.kind() != Kind::Set {
                    return Err(eval_err(
                        "E1110",
                        format!(
                            "Attempted to check if the non-set value\n{}\nis in\n{}",
                            elem.display(ctx),
                            self.display(ctx)
                        ),
                    ));
                }
                for e in elem.expanded_elems(ctx, DEFAULT_ENUM_LIMIT)? {
                    if !s.member(&e, ctx)? {
                        return Ok(false);
                    }
                }
                Ok(true)
            }
            Value::SetCup(l, r) => {
                Ok(l.member(elem, ctx)? || r.member(elem, ctx)?)
            }
            Value::SetPred(sp) => with_lazy_hook(|h| match h {
                Some(h) => h.set_pred_member(sp, elem, ctx),
                None => Err(no_hook_err("test membership in")),
            }),
            // `s \in Seq(S)`: s must be a sequence with every element in S
            // (Java module override Sequences.Seq + SetOfSequences).
            Value::SeqSet(base) => match elem.as_tuple_elems() {
                Some(items) => {
                    for it in &items {
                        if !base.member(it, ctx)? {
                            return Ok(false);
                        }
                    }
                    Ok(true)
                }
                None => match elem {
                    Value::Model { ty: None, .. } => Ok(false),
                    _ => Err(self.member_kind_err(elem, ctx)),
                },
            },
            Value::SetDiff(l, r) => Ok(l.member(elem, ctx)? && !r.member(elem, ctx)?),
            Value::SetCap(l, r) => Ok(l.member(elem, ctx)? && r.member(elem, ctx)?),
            _ => Err(eval_err(
                "E1106",
                format!(
                    "Attempted to check set membership in a non-set value:\n{}",
                    self.display(ctx)
                ),
            )),
        }
    }

    fn member_kind_err(&self, elem: &Value, ctx: &ValueCtx) -> Diag {
        eval_err(
            "E1109",
            format!(
                "Attempted to check if the value:\n{}\nis an element of {}.",
                elem.display(ctx),
                self.display(ctx)
            ),
        )
    }

    /// Sequence view: the elements of a tuple, or of a `FcnRcd` whose domain
    /// is exactly `1..n` (Java `toTuple`). `None` for everything else.
    pub fn as_tuple_elems(&self) -> Option<Vec<Value>> {
        match self {
            Value::Tuple(elems) => Some(elems.as_ref().clone()),
            Value::FcnRcd { dom, rng } => {
                let seq = dom
                    .iter()
                    .enumerate()
                    .all(|(i, d)| matches!(d, Value::Int(n) if *n == i as i64 + 1));
                if seq {
                    Some(rng.as_ref().clone())
                } else {
                    None
                }
            }
            _ => None,
        }
    }

    /// Record view: the (name, value) pairs of a record, or of a `FcnRcd`
    /// whose domain is all strings (Java `toRcd`), sorted by name string.
    pub fn as_record_pairs(&self, ctx: &ValueCtx) -> Option<Vec<(Sym, Value)>> {
        let _ = ctx;
        match self {
            Value::Record(fields) => Some(fields.as_ref().clone()),
            Value::FcnRcd { dom, rng } => {
                let mut pairs = Vec::with_capacity(dom.len());
                for (d, v) in dom.iter().zip(rng.iter()) {
                    match d {
                        Value::Str(s) => pairs.push((*s, v.clone())),
                        _ => return None,
                    }
                }
                // FcnRcd domain order is tla_cmp order on strings, which is
                // already the record field order (string contents).
                Some(pairs)
            }
            _ => None,
        }
    }

    // ----- fingerprints -----

    /// Fingerprint of this value, starting from `FP64.New()` — the tag +
    /// payload scheme of the Java `fingerPrint` methods.
    pub fn fingerprint(&self, ctx: &ValueCtx) -> Result<u64, Diag> {
        self.fp_extend(ctx.fp.new_fp(), ctx)
    }

    /// Extend `fp` by this value (the Java `fingerPrint(long fp)` shape).
    pub fn fp_extend(&self, fp: u64, ctx: &ValueCtx) -> Result<u64, Diag> {
        let t = ctx.fp;
        match self {
            Value::Bool(b) => {
                let fp = t.extend(fp, BOOLVALUE);
                Ok(t.extend(fp, if *b { b't' } else { b'f' }))
            }
            Value::Int(i) => {
                let fp = t.extend(fp, INTVALUE);
                Ok(t.extend_i64(fp, *i))
            }
            Value::Str(s) => Ok(str_fp(t, fp, ctx.interner.str(*s))),
            // Java hashes the UniqueString token here; we hash the name
            // (deterministic by content).
            Value::Model { name, .. } => {
                let fp = t.extend(fp, MODELVALUE);
                Ok(str_fp(t, fp, ctx.interner.str(*name)))
            }
            Value::SetEnum(elems) => {
                let mut fp = t.extend(fp, SETENUMVALUE);
                fp = t.extend_u32(fp, set_size_u32(self, ctx)?);
                for e in elems.iter() {
                    fp = e.fp_extend(fp, ctx)?;
                }
                Ok(fp)
            }
            // IntervalValue.fingerPrint: identical to the equivalent SetEnum.
            Value::Interval { lo, hi } => {
                let mut fp = t.extend(fp, SETENUMVALUE);
                fp = t.extend_u32(fp, set_size_u32(self, ctx)?);
                let mut i = *lo;
                while i <= *hi {
                    fp = t.extend(fp, INTVALUE);
                    fp = t.extend_i64(fp, i);
                    if i == *hi {
                        break;
                    }
                    i += 1;
                }
                Ok(fp)
            }
            // Tuples, records, and function records all fingerprint under
            // the FCNRCDVALUE scheme, which is what makes
            // <<1, 2>> == [i \in 1..2 |-> i] fingerprint-equal.
            Value::Tuple(_) | Value::Record(_) | Value::FcnRcd { .. } => {
                let view = self.fcn_view();
                let len = u32::try_from(view.len()).map_err(|_| {
                    eval_err(
                        "E1105",
                        format!(
                            "Size of function exceeds the maximum representable size (32bits): {}.",
                            self.display(ctx)
                        ),
                    )
                })?;
                let mut fp = t.extend(fp, FCNRCDVALUE);
                fp = t.extend_u32(fp, len);
                for i in 0..view.len() {
                    fp = view.dom_fp(i, fp, ctx)?;
                    fp = view.rng(i).fp_extend(fp, ctx)?;
                }
                Ok(fp)
            }
            // Java fingerprints symbolic sets by normalizing to SetEnumValue
            // first; same here (Nat/Int/STRING error as non-enumerable).
            Value::SetOfFcns { .. }
            | Value::Subset(_)
            | Value::SetOfRcds(_)
            | Value::SetOfTuples(_)
            | Value::BoolSet
            | Value::StringSet
            | Value::NatSet
            | Value::IntSet
            | Value::SetPred(_)
            | Value::SetCup(_, _)
            | Value::SeqSet(_)
            | Value::SetDiff(_, _)
            | Value::SetCap(_, _) => {
                self.expand_to_set_enum(ctx, DEFAULT_ENUM_LIMIT)?.fp_extend(fp, ctx)
            }
            Value::FcnLambda(_) => Err(eval_err(
                "E1197",
                format!(
                    "Attempted to fingerprint a function over a non-enumerable domain:\n{}",
                    self.display(ctx)
                ),
            )),
        }
    }

    // ----- printing -----

    /// Render in TLA+ syntax, following TLC's `toString` conventions.
    pub fn display(&self, ctx: &ValueCtx) -> String {
        let mut out = String::new();
        self.write_display(&mut out, ctx);
        out
    }

    fn write_display(&self, out: &mut String, ctx: &ValueCtx) {
        match self {
            Value::Bool(b) => out.push_str(if *b { "TRUE" } else { "FALSE" }),
            Value::Int(i) => out.push_str(&i.to_string()),
            Value::Str(s) => {
                out.push('"');
                for ch in ctx.interner.str(*s).chars() {
                    if ch == '"' || ch == '\\' {
                        out.push('\\');
                    }
                    out.push(ch);
                }
                out.push('"');
            }
            Value::Model { name, .. } => out.push_str(ctx.interner.str(*name)),
            Value::SetEnum(elems) => {
                out.push('{');
                for (i, e) in elems.iter().enumerate() {
                    if i > 0 {
                        out.push_str(", ");
                    }
                    e.write_display(out, ctx);
                }
                out.push('}');
            }
            Value::Interval { lo, hi } => {
                if lo <= hi {
                    out.push_str(&format!("{lo}..{hi}"));
                } else {
                    out.push_str("{}");
                }
            }
            Value::Tuple(elems) => write_tuple(out, elems, ctx),
            Value::Record(fields) => {
                out.push('[');
                for (i, (name, v)) in fields.iter().enumerate() {
                    if i > 0 {
                        out.push_str(", ");
                    }
                    out.push_str(ctx.interner.str(*name));
                    out.push_str(" |-> ");
                    v.write_display(out, ctx);
                }
                out.push(']');
            }
            // FcnRcdValue.toString: record form if the domain is all record
            // field names, sequence form if the domain is 1..n, otherwise
            // the (d1 :> v1 @@ d2 :> v2) function form.
            Value::FcnRcd { dom, rng } => {
                if dom.is_empty() {
                    out.push_str("<<>>");
                } else if dom.iter().all(|d| match d {
                    Value::Str(s) => is_record_name(ctx.interner.str(*s)),
                    _ => false,
                }) {
                    out.push('[');
                    for (i, (d, v)) in dom.iter().zip(rng.iter()).enumerate() {
                        if i > 0 {
                            out.push_str(", ");
                        }
                        if let Value::Str(s) = d {
                            out.push_str(ctx.interner.str(*s));
                        }
                        out.push_str(" |-> ");
                        v.write_display(out, ctx);
                    }
                    out.push(']');
                } else if dom
                    .iter()
                    .enumerate()
                    .all(|(i, d)| matches!(d, Value::Int(n) if *n == i as i64 + 1))
                {
                    write_tuple(out, rng, ctx);
                } else {
                    out.push('(');
                    for (i, (d, v)) in dom.iter().zip(rng.iter()).enumerate() {
                        if i > 0 {
                            out.push_str(" @@ ");
                        }
                        d.write_display(out, ctx);
                        out.push_str(" :> ");
                        v.write_display(out, ctx);
                    }
                    out.push(')');
                }
            }
            Value::SetOfFcns { dom, rng } => {
                out.push('[');
                dom.write_display(out, ctx);
                out.push_str(" -> ");
                rng.write_display(out, ctx);
                out.push(']');
            }
            Value::Subset(s) => {
                out.push_str("SUBSET ");
                s.write_display(out, ctx);
            }
            Value::SetOfRcds(fields) => {
                out.push('[');
                for (i, (name, s)) in fields.iter().enumerate() {
                    if i > 0 {
                        out.push_str(", ");
                    }
                    out.push_str(ctx.interner.str(*name));
                    out.push_str(": ");
                    s.write_display(out, ctx);
                }
                out.push(']');
            }
            Value::SetOfTuples(sets) => {
                for (i, s) in sets.iter().enumerate() {
                    if i > 0 {
                        out.push_str(" \\X ");
                    }
                    s.write_display(out, ctx);
                }
            }
            Value::BoolSet => out.push_str("BOOLEAN"),
            Value::StringSet => out.push_str("STRING"),
            Value::NatSet => out.push_str("Nat"),
            Value::IntSet => out.push_str("Int"),
            Value::SetPred(sp) => {
                let expanded = with_lazy_hook(|h| {
                    h.and_then(|h| h.set_pred_elems(sp, ctx, DEFAULT_ENUM_LIMIT).ok())
                });
                match expanded {
                    Some(elems) => Value::SetEnum(Rc::new(elems)).write_display(out, ctx),
                    None => {
                        out.push_str("{x \\in ");
                        sp.domain.write_display(out, ctx);
                        out.push_str(" : ...}");
                    }
                }
            }
            Value::SeqSet(base) => {
                out.push_str("Seq(");
                base.write_display(out, ctx);
                out.push(')');
            }
            Value::SetDiff(l, r) => {
                l.write_display(out, ctx);
                out.push_str(" \\ ");
                r.write_display(out, ctx);
            }
            Value::SetCap(l, r) => {
                l.write_display(out, ctx);
                out.push_str(" \\cap ");
                r.write_display(out, ctx);
            }
            Value::SetCup(l, r) => {
                l.write_display(out, ctx);
                out.push_str(" \\cup ");
                r.write_display(out, ctx);
            }
            Value::FcnLambda(lf) => {
                out.push_str("[x \\in ");
                for (i, d) in lf.domains.iter().enumerate() {
                    if i > 0 {
                        out.push_str(" \\X ");
                    }
                    d.write_display(out, ctx);
                }
                out.push_str(" |-> ...]");
            }
        }
    }
}

/// Sort values with `tla_cmp`; the inputs are known distinct by construction
/// (product enumerations never repeat), so no dedup pass is needed.
fn sorted_distinct(items: Vec<Value>, ctx: &ValueCtx) -> Result<Vec<Value>, Diag> {
    sort_fallible(items, &mut |a, b| a.tla_cmp(b, ctx))
}

/// Odometer over `width` positions each ranging over `0..n` (the `[S -> T]`
/// range-choice enumeration). Runs `f` once with the empty choice when
/// `width == 0`; runs it zero times when `n == 0` and `width > 0`.
fn product_foreach(
    width: usize,
    n: usize,
    mut f: impl FnMut(&[usize]) -> Result<(), Diag>,
) -> Result<(), Diag> {
    if width > 0 && n == 0 {
        return Ok(());
    }
    let mut idx = vec![0usize; width];
    loop {
        f(&idx)?;
        let mut k = width;
        loop {
            if k == 0 {
                return Ok(());
            }
            k -= 1;
            idx[k] += 1;
            if idx[k] < n {
                break;
            }
            idx[k] = 0;
        }
    }
}

/// Odometer over positions with individual ranges `parts[k].len()`.
fn mixed_product_foreach(
    parts: &[Vec<Value>],
    mut f: impl FnMut(&[usize]) -> Result<(), Diag>,
) -> Result<(), Diag> {
    if parts.iter().any(|p| p.is_empty()) && !parts.is_empty() {
        return Ok(());
    }
    let mut idx = vec![0usize; parts.len()];
    loop {
        f(&idx)?;
        let mut k = parts.len();
        loop {
            if k == 0 {
                return Ok(());
            }
            k -= 1;
            idx[k] += 1;
            if idx[k] < parts[k].len() {
                break;
            }
            idx[k] = 0;
        }
    }
}

fn write_tuple(out: &mut String, elems: &[Value], ctx: &ValueCtx) {
    out.push_str("<<");
    for (i, e) in elems.iter().enumerate() {
        if i > 0 {
            out.push_str(", ");
        }
        e.write_display(out, ctx);
    }
    out.push_str(">>");
}

/// `FcnRcdValue.isName`: a record field name is letters/digits/underscores
/// with at least one letter, and not a `WF_`/`SF_` fairness name.
fn is_record_name(s: &str) -> bool {
    let mut has_letter = false;
    for ch in s.chars() {
        if ch == '_' {
            continue;
        }
        if !ch.is_alphanumeric() {
            return false;
        }
        has_letter = has_letter || ch.is_alphabetic();
    }
    has_letter && (s.len() < 4 || (!s.starts_with("WF_") && !s.starts_with("SF_")))
}

/// The `STRINGVALUE`-tagged fingerprint payload (`StringValue.fingerPrint`
/// and the record-field-name hashing in `RecordValue.fingerPrint`).
fn str_fp(t: &Fp64Table, fp: u64, s: &str) -> u64 {
    let fp = t.extend(fp, STRINGVALUE);
    let fp = t.extend_u32(fp, s.len() as u32);
    t.extend_str(fp, s)
}

/// Set cardinality as `u32` for fingerprints; like `IntervalValue.size()`,
/// exceeding the 32-bit representable size is a user error.
fn set_size_u32(set: &Value, ctx: &ValueCtx) -> Result<u32, Diag> {
    u32::try_from(set.set_size()).map_err(|_| {
        eval_err(
            "E1105",
            format!(
                "Size of interval value exceeds the maximum representable size (32bits): {}.",
                set.display(ctx)
            ),
        )
    })
}

/// Iterator over a set value's elements in normalized order.
enum SetElems<'a> {
    Enum(std::slice::Iter<'a, Value>),
    Interval { next: i64, hi: i64, done: bool },
}

impl Iterator for SetElems<'_> {
    type Item = Value;

    fn next(&mut self) -> Option<Value> {
        match self {
            SetElems::Enum(it) => it.next().cloned(),
            SetElems::Interval { next, hi, done } => {
                if *done {
                    return None;
                }
                let v = *next;
                if v == *hi {
                    *done = true;
                } else {
                    *next += 1;
                }
                Some(Value::Int(v))
            }
        }
    }
}

/// The canonical function view: domain and range in normalized (sorted)
/// order for each of the three function representations.
enum FcnView<'a> {
    /// Domain is implicitly `1..len`.
    Tuple(&'a [Value]),
    /// Domain is the field names as strings.
    Record(&'a [(Sym, Value)]),
    Fcn { dom: &'a [Value], rng: &'a [Value] },
}

impl FcnView<'_> {
    fn len(&self) -> usize {
        match self {
            FcnView::Tuple(elems) => elems.len(),
            FcnView::Record(fields) => fields.len(),
            FcnView::Fcn { dom, .. } => dom.len(),
        }
    }

    /// The `i`-th domain element as a value (cheap: scalars or an `Rc`
    /// clone).
    fn dom_value(&self, i: usize) -> Value {
        match self {
            FcnView::Tuple(_) => Value::Int(i as i64 + 1),
            FcnView::Record(fields) => Value::Str(fields[i].0),
            FcnView::Fcn { dom, .. } => dom[i].clone(),
        }
    }

    fn rng(&self, i: usize) -> &Value {
        match self {
            FcnView::Tuple(elems) => &elems[i],
            FcnView::Record(fields) => &fields[i].1,
            FcnView::Fcn { rng, .. } => &rng[i],
        }
    }

    /// Extend `fp` by the `i`-th domain element, exactly as the Java
    /// fingerPrint bodies do (TupleValue writes `INTVALUE, i+1`; RecordValue
    /// writes the `STRINGVALUE` payload; FcnRcdValue recurses).
    fn dom_fp(&self, i: usize, fp: u64, ctx: &ValueCtx) -> Result<u64, Diag> {
        match self {
            FcnView::Tuple(_) => {
                let fp = ctx.fp.extend(fp, INTVALUE);
                Ok(ctx.fp.extend_i64(fp, i as i64 + 1))
            }
            FcnView::Record(fields) => Ok(str_fp(ctx.fp, fp, ctx.interner.str(fields[i].0))),
            FcnView::Fcn { dom, .. } => dom[i].fp_extend(fp, ctx),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> (Interner, Fp64Table) {
        (Interner::new(), Fp64Table::new())
    }

    #[test]
    fn scalar_ordering_and_errors() {
        let (mut int, fp) = setup();
        let a = Value::Str(int.intern("a"));
        let b = Value::Str(int.intern("b"));
        let ctx = ValueCtx { interner: &int, fp: &fp };
        assert_eq!(Value::Int(1).tla_cmp(&Value::Int(2), &ctx).unwrap(), Ordering::Less);
        assert_eq!(
            Value::Bool(false).tla_cmp(&Value::Bool(true), &ctx).unwrap(),
            Ordering::Less
        );
        assert_eq!(a.tla_cmp(&b, &ctx).unwrap(), Ordering::Less);
        assert!(Value::Int(1).tla_cmp(&a, &ctx).is_err());
        assert!(Value::Bool(true).tla_cmp(&Value::Int(1), &ctx).is_err());
    }

    #[test]
    fn interval_equals_set_enum() {
        let (int, fp) = setup();
        let ctx = ValueCtx { interner: &int, fp: &fp };
        let s = Value::set_enum(vec![Value::Int(2), Value::Int(1)], &ctx).unwrap();
        let iv = Value::interval(1, 2);
        assert!(iv.tla_eq(&s, &ctx).unwrap());
        assert_eq!(iv.fingerprint(&ctx).unwrap(), s.fingerprint(&ctx).unwrap());
        // Empty interval == empty set, regardless of bounds.
        let empty = Value::set_enum(vec![], &ctx).unwrap();
        assert!(Value::interval(5, 1).tla_eq(&empty, &ctx).unwrap());
        assert_eq!(
            Value::interval(5, 1).fingerprint(&ctx).unwrap(),
            empty.fingerprint(&ctx).unwrap()
        );
    }

    #[test]
    fn tuple_record_fcn_unification() {
        let (mut int, fp) = setup();
        let a = int.intern("a");
        let ctx = ValueCtx { interner: &int, fp: &fp };
        let tup = Value::tuple(vec![Value::Int(10), Value::Int(20)]);
        let fcn = Value::fcn_rcd(
            vec![Value::Int(2), Value::Int(1)],
            vec![Value::Int(20), Value::Int(10)],
            &ctx,
        )
        .unwrap();
        assert!(tup.tla_eq(&fcn, &ctx).unwrap());
        assert_eq!(tup.fingerprint(&ctx).unwrap(), fcn.fingerprint(&ctx).unwrap());

        let rcd = Value::record(vec![(a, Value::Int(1))], &ctx).unwrap();
        let fcn_s =
            Value::fcn_rcd(vec![Value::Str(a)], vec![Value::Int(1)], &ctx).unwrap();
        assert!(rcd.tla_eq(&fcn_s, &ctx).unwrap());
        assert_eq!(rcd.fingerprint(&ctx).unwrap(), fcn_s.fingerprint(&ctx).unwrap());
    }

    #[test]
    fn duplicate_domain_is_error() {
        let (int, fp) = setup();
        let ctx = ValueCtx { interner: &int, fp: &fp };
        let err = Value::fcn_rcd(
            vec![Value::Int(1), Value::Int(1)],
            vec![Value::Int(2), Value::Int(3)],
            &ctx,
        )
        .unwrap_err();
        assert!(err.message.contains("occurs multiple times in the function domain"));
    }

    #[test]
    fn display_forms() {
        let (mut int, fp) = setup();
        let a = int.intern("a");
        let s = int.intern("hi");
        let ctx = ValueCtx { interner: &int, fp: &fp };
        assert_eq!(Value::Bool(true).display(&ctx), "TRUE");
        assert_eq!(Value::Int(-3).display(&ctx), "-3");
        assert_eq!(Value::Str(s).display(&ctx), "\"hi\"");
        assert_eq!(Value::interval(1, 2).display(&ctx), "1..2");
        assert_eq!(Value::interval(2, 1).display(&ctx), "{}");
        let set = Value::set_enum(vec![Value::Int(2), Value::Int(1)], &ctx).unwrap();
        assert_eq!(set.display(&ctx), "{1, 2}");
        let tup = Value::tuple(vec![Value::Int(1), Value::Int(2)]);
        assert_eq!(tup.display(&ctx), "<<1, 2>>");
        let rcd = Value::record(vec![(a, Value::Int(1))], &ctx).unwrap();
        assert_eq!(rcd.display(&ctx), "[a |-> 1]");
        // FcnRcd with a string-name domain prints in record form.
        let fcn_s = Value::fcn_rcd(vec![Value::Str(a)], vec![Value::Int(1)], &ctx).unwrap();
        assert_eq!(fcn_s.display(&ctx), "[a |-> 1]");
        // FcnRcd with domain 1..n prints in sequence form.
        let fcn_t = Value::fcn_rcd(
            vec![Value::Int(1), Value::Int(2)],
            vec![Value::Int(10), Value::Int(20)],
            &ctx,
        )
        .unwrap();
        assert_eq!(fcn_t.display(&ctx), "<<10, 20>>");
        // General function form.
        let fcn_g = Value::fcn_rcd(
            vec![Value::Int(0), Value::Int(2)],
            vec![Value::Int(10), Value::Int(20)],
            &ctx,
        )
        .unwrap();
        assert_eq!(fcn_g.display(&ctx), "(0 :> 10 @@ 2 :> 20)");
        let empty = Value::fcn_rcd(vec![], vec![], &ctx).unwrap();
        assert_eq!(empty.display(&ctx), "<<>>");
    }
}
