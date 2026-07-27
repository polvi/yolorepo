//! Native operator overrides — the analog of `tlc2/module/{Naturals,
//! Integers, Sequences, FiniteSets, TLC}.java`. When a name resolves to one
//! of these standard-module definitions, the evaluator calls the native
//! implementation instead of evaluating the module's dummy `.tla` body.
//!
//! Semantics ported exactly from the Java methods, in particular:
//! - `\div` / `%` are floor-based: `-7 \div 2 = -4`, `-7 % 2 = 1`; `%`
//!   requires a positive second argument, `\div` a non-zero one.
//! - `^` requires a non-negative exponent; `0^0 = 1`.
//! - Arithmetic overflow is a user error (on `i64` here; Java uses 32 bits —
//!   a documented deviation).

use crate::diag::{Category, Diag};
use crate::value::{Value, ValueCtx};

/// Which native implementation a standard-module definition maps to.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Native {
    // Naturals / Integers
    Plus,
    Minus,
    Times,
    Expt,
    Lt,
    Leq,
    Gt,
    Geq,
    DotDot,
    Divide,
    Mod,
    NatSet,
    IntSet,
    Neg,
    // Sequences
    SeqSet,
    Len,
    Concat,
    Append,
    Head,
    Tail,
    SubSeq,
    // FiniteSets
    Cardinality,
    IsFiniteSet,
    // TLC
    Print,
    PrintT,
    Assert,
    JavaTime,
    TLCGet,
    TLCSet,
    MakeFcn,
    CombineFcn,
    RandomElement,
    Any,
    ToString,
    /// `SortSeq(s, Op)` — higher-order (the comparator is an operator).
    SortSeq,
    /// `SelectSeq(s, Test)` — higher-order (the test is an operator).
    SelectSeq,
    /// `Permutations(S)`.
    Permutations,
    /// `Bags!IsABag(B)` (native override; the .tla version errors on
    /// non-integer ranges).
    IsABag,
}

/// The override table, keyed by (defining module, definition name) — the
/// analog of `TLARegistry` plus the per-module method lookup.
pub fn native_of(module: &str, name: &str) -> Option<Native> {
    use Native::*;
    let n = match (module, name) {
        ("Naturals", "+") => Plus,
        ("Naturals", "-") => Minus,
        ("Naturals", "*") => Times,
        ("Naturals", "^") => Expt,
        ("Naturals", "<") => Lt,
        ("Naturals", "\\leq") => Leq,
        ("Naturals", ">") => Gt,
        ("Naturals", "\\geq") => Geq,
        ("Naturals", "..") => DotDot,
        ("Naturals", "\\div") => Divide,
        ("Naturals", "%") => Mod,
        ("Naturals", "Nat") => NatSet,
        ("Integers", "Int") => IntSet,
        ("Integers", "-.") => Neg,
        ("Sequences", "Seq") => SeqSet,
        ("Sequences", "Len") => Len,
        ("Sequences", "\\o") => Concat,
        ("Sequences", "Append") => Append,
        ("Sequences", "Head") => Head,
        ("Sequences", "Tail") => Tail,
        ("Sequences", "SubSeq") => SubSeq,
        ("FiniteSets", "Cardinality") => Cardinality,
        ("FiniteSets", "IsFiniteSet") => IsFiniteSet,
        ("TLC", "Print") => Print,
        ("TLC", "PrintT") => PrintT,
        ("TLC", "Assert") => Assert,
        ("TLC", "JavaTime") => JavaTime,
        ("TLC", "TLCGet") => TLCGet,
        ("TLC", "TLCSet") => TLCSet,
        ("TLC", ":>") => MakeFcn,
        ("TLC", "@@") => CombineFcn,
        ("TLC", "RandomElement") => RandomElement,
        ("TLC", "Any") => Any,
        ("TLC", "ToString") => ToString,
        ("TLC", "SortSeq") => SortSeq,
        ("Sequences", "SelectSeq") => SelectSeq,
        ("TLC", "Permutations") => Permutations,
        ("Bags", "IsABag") => IsABag,
        _ => return None,
    };
    Some(n)
}

/// Builtin fallback: the same natives addressed by operator spelling, for
/// specs that use an arithmetic/sequence operator symbol that did not
/// resolve to a definition (e.g. tests without `EXTENDS Naturals`; Java
/// SANY would reject those outright — a documented deviation).
pub fn native_of_spelling(op: &str) -> Option<Native> {
    use Native::*;
    let n = match op {
        "+" => Plus,
        "-" => Minus,
        "*" => Times,
        "^" => Expt,
        "<" => Lt,
        "\\leq" => Leq,
        ">" => Gt,
        "\\geq" => Geq,
        ".." => DotDot,
        "\\div" => Divide,
        "%" => Mod,
        "-." => Neg,
        "\\o" => Concat,
        ":>" => MakeFcn,
        "@@" => CombineFcn,
        _ => return None,
    };
    Some(n)
}

fn err(code: &'static str, msg: String) -> Diag {
    Diag::new(Category::Eval, code, msg)
}

fn int_arg(v: &Value, pos: &str, op: &str, want: &str, ctx: &ValueCtx) -> Result<i64, Diag> {
    match v {
        Value::Int(i) => Ok(*i),
        _ => Err(err(
            "E1301",
            format!(
                "The {} argument of {} should be {}, but instead it is:\n{}",
                pos,
                op,
                want,
                v.display(ctx)
            ),
        )),
    }
}

fn overflow(text: String) -> Diag {
    err("E1302", format!("Overflow when computing {text}"))
}

/// A sequence argument (tuple view), or the Java-style argument error.
fn seq_arg(v: &Value, pos: &str, op: &str, ctx: &ValueCtx) -> Result<Vec<Value>, Diag> {
    v.as_tuple_elems().ok_or_else(|| {
        err(
            "E1301",
            format!(
                "The {} argument of {} should be a sequence, but instead it is:\n{}",
                pos,
                op,
                v.display(ctx)
            ),
        )
    })
}

// ---- Naturals / Integers (tlc2.module.Naturals, Integers) ------------------

pub fn plus(a: &Value, b: &Value, ctx: &ValueCtx) -> Result<Value, Diag> {
    let (x, y) = (int_arg(a, "first", "+", "an integer", ctx)?, int_arg(b, "second", "+", "an integer", ctx)?);
    x.checked_add(y).map(Value::Int).ok_or_else(|| overflow(format!("{x}+{y}")))
}

pub fn minus(a: &Value, b: &Value, ctx: &ValueCtx) -> Result<Value, Diag> {
    let (x, y) = (int_arg(a, "first", "-", "an integer", ctx)?, int_arg(b, "second", "-", "an integer", ctx)?);
    x.checked_sub(y).map(Value::Int).ok_or_else(|| overflow(format!("{x}-{y}")))
}

pub fn times(a: &Value, b: &Value, ctx: &ValueCtx) -> Result<Value, Diag> {
    let (x, y) = (int_arg(a, "first", "*", "an integer", ctx)?, int_arg(b, "second", "*", "an integer", ctx)?);
    x.checked_mul(y).map(Value::Int).ok_or_else(|| overflow(format!("{x}*{y}")))
}

pub fn neg(a: &Value, ctx: &ValueCtx) -> Result<Value, Diag> {
    let x = int_arg(a, "first", "-.", "an integer", ctx)?;
    x.checked_neg().map(Value::Int).ok_or_else(|| overflow(format!("-{x}")))
}

/// `Naturals.Expt`: negative exponent and `0^0` are errors.
pub fn expt(a: &Value, b: &Value, ctx: &ValueCtx) -> Result<Value, Diag> {
    let x = int_arg(a, "first", "^", "an integer", ctx)?;
    let y = int_arg(b, "second", "^", "a natural number", ctx)?;
    if y < 0 {
        return Err(err(
            "E1301",
            format!("The second argument of ^ should be a natural number, but instead it is:\n{y}"),
        ));
    }
    if y == 0 {
        if x == 0 {
            return Err(err("E1308", "0^0 is undefined.".to_string()));
        }
        return Ok(Value::Int(1));
    }
    let exp = u32::try_from(y).map_err(|_| overflow(format!("{x}^{y}")))?;
    x.checked_pow(exp).map(Value::Int).ok_or_else(|| overflow(format!("{x}^{y}")))
}

fn cmp_ints(a: &Value, b: &Value, op: &str, ctx: &ValueCtx) -> Result<(i64, i64), Diag> {
    Ok((
        int_arg(a, "first", op, "an integer", ctx)?,
        int_arg(b, "second", op, "an integer", ctx)?,
    ))
}

pub fn lt(a: &Value, b: &Value, ctx: &ValueCtx) -> Result<Value, Diag> {
    let (x, y) = cmp_ints(a, b, "<", ctx)?;
    Ok(Value::Bool(x < y))
}

pub fn leq(a: &Value, b: &Value, ctx: &ValueCtx) -> Result<Value, Diag> {
    let (x, y) = cmp_ints(a, b, "<=", ctx)?;
    Ok(Value::Bool(x <= y))
}

pub fn gt(a: &Value, b: &Value, ctx: &ValueCtx) -> Result<Value, Diag> {
    let (x, y) = cmp_ints(a, b, ">", ctx)?;
    Ok(Value::Bool(x > y))
}

pub fn geq(a: &Value, b: &Value, ctx: &ValueCtx) -> Result<Value, Diag> {
    let (x, y) = cmp_ints(a, b, ">=", ctx)?;
    Ok(Value::Bool(x >= y))
}

pub fn dotdot(a: &Value, b: &Value, ctx: &ValueCtx) -> Result<Value, Diag> {
    let (x, y) = cmp_ints(a, b, "..", ctx)?;
    Ok(Value::interval(x, y))
}

/// `Naturals.Divide` — floor division; the divisor must be non-zero.
pub fn divide(a: &Value, b: &Value, ctx: &ValueCtx) -> Result<Value, Diag> {
    let (x, y) = cmp_ints(a, b, "\\div", ctx)?;
    if y == 0 {
        return Err(err("E1303", "The second argument of \\div is 0.".to_string()));
    }
    // Port of the Java adjustment: truncate, then decrement when the
    // truncated quotient is negative and inexact (= floor division).
    let q = x.checked_div(y).ok_or_else(|| overflow(format!("{x}\\div{y}")))?;
    let q = if q < 0 && q * y != x { q - 1 } else { q };
    Ok(Value::Int(q))
}

/// `Naturals.Mod` — the second argument must be positive; the result is
/// always in `0..y-1`.
pub fn modulo(a: &Value, b: &Value, ctx: &ValueCtx) -> Result<Value, Diag> {
    let (x, y) = cmp_ints(a, b, "%", ctx)?;
    if y <= 0 {
        return Err(err(
            "E1301",
            format!("The second argument of % should be a positive number, but instead it is:\n{y}"),
        ));
    }
    let r = x % y;
    Ok(Value::Int(if r < 0 { r + y } else { r }))
}

// ---- Sequences (tlc2.module.Sequences) -------------------------------------

pub fn len(a: &Value, ctx: &ValueCtx) -> Result<Value, Diag> {
    if let Value::Str(s) = a {
        return Ok(Value::Int(ctx.interner.str(*s).chars().count() as i64));
    }
    let elems = a.as_tuple_elems().ok_or_else(|| {
        err(
            "E1301",
            format!("The argument of Len should be a sequence, but instead it is:\n{}", a.display(ctx)),
        )
    })?;
    Ok(Value::Int(elems.len() as i64))
}

pub fn concat(a: &Value, b: &Value, ctx: &ValueCtx) -> Result<Value, Diag> {
    // String concatenation (Java StringValue \o override).
    if let (Value::Str(x), Value::Str(y)) = (a, b) {
        let joined = format!("{}{}", ctx.interner.str(*x), ctx.interner.str(*y));
        return Ok(Value::Str(ctx.interner.intern_ref(&joined)));
    }
    let mut xs = seq_arg(a, "first", "\\o", ctx)?;
    let ys = seq_arg(b, "second", "\\o", ctx)?;
    xs.extend(ys);
    Ok(Value::tuple(xs))
}

pub fn append(a: &Value, e: &Value, ctx: &ValueCtx) -> Result<Value, Diag> {
    let mut xs = seq_arg(a, "first", "Append", ctx)?;
    xs.push(e.clone());
    Ok(Value::tuple(xs))
}

pub fn head(a: &Value, ctx: &ValueCtx) -> Result<Value, Diag> {
    let xs = seq_arg(a, "first", "Head", ctx)?;
    xs.first().cloned().ok_or_else(|| {
        err("E1305", "Attempted to apply Head to the empty sequence.".to_string())
    })
}

pub fn tail(a: &Value, ctx: &ValueCtx) -> Result<Value, Diag> {
    let xs = seq_arg(a, "first", "Tail", ctx)?;
    if xs.is_empty() {
        return Err(err("E1305", "Attempted to apply Tail to the empty sequence.".to_string()));
    }
    Ok(Value::tuple(xs[1..].to_vec()))
}

/// `Sequences.SubSeq(s, m, n)` — `m > n` gives the empty sequence without
/// domain checks; otherwise both endpoints must lie in `1..Len(s)`.
pub fn subseq(s: &Value, m: &Value, n: &Value, ctx: &ValueCtx) -> Result<Value, Diag> {
    let xs = seq_arg(s, "first", "SubSeq", ctx)?;
    let beg = int_arg(m, "second", "SubSeq", "a natural number", ctx)?;
    let end = int_arg(n, "third", "SubSeq", "a natural number", ctx)?;
    if beg > end {
        return Ok(Value::tuple(Vec::new()));
    }
    let len = xs.len() as i64;
    let not_in_domain = |pos: &str, v: i64| {
        err(
            "E1306",
            format!(
                "The {} argument of SubSeq must be in the domain of its first argument:\n{}\n, \
                 but instead it is\n{}",
                pos,
                s.display(ctx),
                v
            ),
        )
    };
    if beg < 1 || beg > len {
        return Err(not_in_domain("second", beg));
    }
    if end < 1 || end > len {
        return Err(not_in_domain("third", end));
    }
    Ok(Value::tuple(xs[(beg - 1) as usize..end as usize].to_vec()))
}

// ---- FiniteSets (tlc2.module.FiniteSets) -----------------------------------

pub fn cardinality(a: &Value, ctx: &ValueCtx) -> Result<Value, Diag> {
    let card = a.set_card(ctx).map_err(|_| {
        err(
            "E1301",
            format!(
                "The argument of Cardinality should be a finite set, but instead it is:\n{}",
                a.display(ctx)
            ),
        )
    })?;
    i64::try_from(card)
        .map(Value::Int)
        .map_err(|_| overflow(format!("Cardinality({})", a.display(ctx))))
}

/// `Bags!IsABag(B)` — B is a function whose range is positive integers
/// (native override tlc2/module/Bags.IsABag; the .tla fallback errors on
/// non-integer ranges where the native returns FALSE).
pub fn is_a_bag(a: &Value, _ctx: &ValueCtx) -> Result<Value, Diag> {
    let rng: Vec<Value> = match a {
        Value::FcnRcd { rng, .. } => rng.as_ref().clone(),
        Value::Tuple(elems) => elems.as_ref().clone(),
        Value::Record(fields) => fields.iter().map(|(_, v)| v.clone()).collect(),
        _ => return Ok(Value::Bool(false)),
    };
    Ok(Value::Bool(rng.iter().all(|v| matches!(v, Value::Int(n) if *n > 0))))
}

pub fn is_finite_set(a: &Value, ctx: &ValueCtx) -> Result<Value, Diag> {
    match a {
        Value::NatSet | Value::IntSet | Value::StringSet => Ok(Value::Bool(false)),
        _ => {
            // Any other set value we represent is finite; set_card doubles
            // as the "is it a set" check.
            a.set_card(ctx)?;
            Ok(Value::Bool(true))
        }
    }
}

// ---- TLC (tlc2.module.TLC) -------------------------------------------------

/// `d :> e` — the singleton function.
pub fn make_fcn(d: &Value, e: &Value, ctx: &ValueCtx) -> Result<Value, Diag> {
    Value::fcn_rcd(vec![d.clone()], vec![e.clone()], ctx)
}

/// `f @@ g` — function merge with left precedence (`TLC.CombineFcn`).
pub fn combine_fcn(f: &Value, g: &Value, ctx: &ValueCtx) -> Result<Value, Diag> {
    let fv = as_fcn_pairs(f).ok_or_else(|| {
        err(
            "E1301",
            format!("The first argument of @@ should be a function, but instead it is:\n{}", f.display(ctx)),
        )
    })?;
    let gv = as_fcn_pairs(g).ok_or_else(|| {
        err(
            "E1301",
            format!("The second argument of @@ should be a function, but instead it is:\n{}", g.display(ctx)),
        )
    })?;
    let (mut dom, mut rng): (Vec<Value>, Vec<Value>) = fv.into_iter().unzip();
    for (d, v) in gv {
        let mut found = false;
        for existing in &dom {
            if existing.tla_cmp(&d, ctx)? == std::cmp::Ordering::Equal {
                found = true;
                break;
            }
        }
        if !found {
            dom.push(d);
            rng.push(v);
        }
    }
    Value::fcn_rcd(dom, rng, ctx)
}

/// The (domain, range) pairs of any function-class value.
fn as_fcn_pairs(v: &Value) -> Option<Vec<(Value, Value)>> {
    match v {
        Value::FcnRcd { dom, rng } => {
            Some(dom.iter().cloned().zip(rng.iter().cloned()).collect())
        }
        Value::Tuple(elems) => Some(
            elems.iter().enumerate().map(|(i, e)| (Value::Int(i as i64 + 1), e.clone())).collect(),
        ),
        Value::Record(fields) => {
            Some(fields.iter().map(|(n, e)| (Value::Str(*n), e.clone())).collect())
        }
        _ => None,
    }
}

/// `Assert(val, out)` — TRUE passes through; anything else is a user error
/// showing `out` (`EC.TLC_VALUE_ASSERT_FAILED`).
pub fn assert_native(val: &Value, out: &Value, ctx: &ValueCtx) -> Result<Value, Diag> {
    if matches!(val, Value::Bool(true)) {
        Ok(Value::Bool(true))
    } else {
        Err(err(
            "E1307",
            format!(
                "The first argument of Assert evaluated to FALSE; the second argument was:\n{}",
                out.display(ctx)
            ),
        ))
    }
}

/// `s \in Seq(S)` without materializing `Seq(S)`: a sequence whose elements
/// are all members of `S` (`Sequences.member`).
pub fn seq_member(s: &Value, range: &Value, ctx: &ValueCtx) -> Result<bool, Diag> {
    let Some(elems) = s.as_tuple_elems() else {
        if matches!(s, Value::Model { ty: None, .. }) {
            return Ok(false);
        }
        return Err(err(
            "E1109",
            format!(
                "Attempted to check if the value:\n{}\nis in the set Seq({}).",
                s.display(ctx),
                range.display(ctx)
            ),
        ));
    };
    for e in &elems {
        if !range.member(e, ctx)? {
            return Ok(false);
        }
    }
    Ok(true)
}
