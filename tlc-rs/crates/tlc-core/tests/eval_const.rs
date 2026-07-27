//! Constant-expression evaluator golden tests (milestone M3).
//!
//! Expected values marked "Java-verified" were produced by running the real
//! Java TLC (tla2tools.jar 2.19, `ASSUME PrintT(...)` in a one-state spec)
//! on the same expressions; the rest follow directly from the ported code
//! paths.

use tlc_core::diag::Diag;
use tlc_core::eval::Evaluator;
use tlc_core::intern::Interner;
use tlc_core::sem;
use tlc_core::value::fp::Fp64Table;
use tlc_core::value::{Value, ValueCtx};
use tlc_core::MapResolver;

const EXTENDS: &str = "EXTENDS Naturals, Integers, Sequences, FiniteSets, TLC, Bags";

/// Analyze a module wrapping `defs` (which must define `Probe`), evaluate
/// `Probe`, and render the result. Errors render as `Err(message)`.
fn probe_with(header: &str, defs: &str) -> Result<String, String> {
    let src = format!("---- MODULE T ----\n{header}\n{defs}\n====\n");
    let mut interner = Interner::new();
    let analysis = sem::analyze("T", &src, &MapResolver { modules: &[] }, &mut interner)
        .map_err(|ds| {
            ds.iter().map(|d| d.to_string()).collect::<Vec<_>>().join("\n")
        })?;
    let fp = Fp64Table::new();
    let vctx = ValueCtx { interner: &interner, fp: &fp };
    let ev = Evaluator::new(&analysis, vctx);
    // Lazy predicate sets evaluate through the hook (as run_check installs).
    let _lazy = tlc_core::value::install_lazy_eval(&ev);
    let v = ev.eval_def_named("Probe").map_err(|d: Diag| d.message)?;
    Ok(v.display(&ev.vctx))
}

fn probe(defs: &str) -> Result<String, String> {
    probe_with(EXTENDS, defs)
}

#[track_caller]
fn eval_ok(expr: &str) -> String {
    probe(&format!("Probe == {expr}")).unwrap_or_else(|e| panic!("eval of `{expr}` failed: {e}"))
}

#[track_caller]
fn eval_err(expr: &str) -> String {
    match probe(&format!("Probe == {expr}")) {
        Ok(v) => panic!("eval of `{expr}` unexpectedly succeeded with {v}"),
        Err(e) => e,
    }
}

// ---- arithmetic (Java-verified: divmod/expt golden run) --------------------

#[test]
fn arithmetic_div_mod_floor() {
    // Java-verified: `-7 \div 2` parses as -(7 \div 2) since \div binds
    // tighter than unary minus.
    assert_eq!(eval_ok("-7 \\div 2"), "-3");
    assert_eq!(eval_ok("(-7) \\div 2"), "-4");
    assert_eq!(eval_ok("-7 % 2"), "1"); // (-7) % 2 — unary minus binds tighter
    assert_eq!(eval_ok("7 \\div (-2)"), "-4"); // Java-verified floor
    assert_eq!(eval_ok("(-7) \\div (-2)"), "3"); // Java-verified
    assert_eq!(eval_ok("-1 % 3"), "2"); // Java-verified
    assert_eq!(eval_ok("6 \\div 2"), "3");
    assert_eq!(eval_ok("0 \\div 5"), "0");
    assert_eq!(eval_ok("7 \\div 2"), "3");
}

#[test]
fn arithmetic_expt_and_overflow() {
    assert_eq!(eval_ok("2^10"), "1024"); // Java-verified
    assert_eq!(eval_ok("(-2)^3"), "-8"); // Java-verified
    assert_eq!(eval_ok("1^0"), "1"); // Java-verified
    assert_eq!(eval_ok("2^0"), "1"); // Java-verified
    assert!(eval_err("0^0").contains("0^0 is undefined")); // Java-verified
    assert!(eval_err("2^63").contains("Overflow"));
    assert!(eval_err("9223372036854775807 + 1").contains("Overflow"));
    assert!(eval_err("1 \\div 0").contains("The second argument of \\div is 0"));
    assert!(eval_err("7 % (-2)").contains("positive number"));
    assert!(eval_err("1 + \"a\"").contains("The second argument of + should be an integer"));
}

#[test]
fn number_literal_radixes() {
    assert_eq!(eval_ok("\\b1010"), "10");
    assert_eq!(eval_ok("\\o17"), "15");
    assert_eq!(eval_ok("\\hFF"), "255");
}

// ---- logic -----------------------------------------------------------------

#[test]
fn logic_short_circuit_and_strictness() {
    assert_eq!(eval_ok("TRUE /\\ FALSE"), "FALSE");
    assert_eq!(eval_ok("FALSE \\/ TRUE"), "TRUE");
    assert_eq!(eval_ok("FALSE => (1 \\div 0 = 0)"), "TRUE"); // rhs not evaluated
    assert_eq!(eval_ok("FALSE /\\ (1 \\div 0 = 0)"), "FALSE"); // short-circuit
    assert_eq!(eval_ok("TRUE \\/ (1 \\div 0 = 0)"), "TRUE"); // short-circuit
    assert_eq!(eval_ok("TRUE <=> TRUE"), "TRUE");
    assert_eq!(eval_ok("~FALSE"), "TRUE");
    assert!(eval_err("3 /\\ TRUE").contains("not a boolean"));
    // Junction lists.
    assert_eq!(
        probe("Probe ==\n  /\\ 1 < 2\n  /\\ 2 < 3\n  /\\ TRUE").unwrap(),
        "TRUE"
    );
    assert_eq!(
        probe("Probe ==\n  \\/ FALSE\n  \\/ 2 = 3\n  \\/ 2 = 2").unwrap(),
        "TRUE"
    );
}

// ---- sets ------------------------------------------------------------------

#[test]
fn set_operations() {
    assert_eq!(eval_ok("{3, 1, 2, 1}"), "{1, 2, 3}");
    assert_eq!(eval_ok("{1, 2} \\cup {2, 3}"), "{1, 2, 3}");
    assert_eq!(eval_ok("{1, 2, 3} \\cap {2, 3, 4}"), "{2, 3}");
    assert_eq!(eval_ok("{1, 2, 3} \\ {2}"), "{1, 3}");
    assert_eq!(eval_ok("UNION {{1, 2}, {2, 3}}"), "{1, 2, 3}"); // Java-verified
    assert_eq!(eval_ok("{1, 2} \\subseteq {1, 2, 3}"), "TRUE");
    assert_eq!(eval_ok("{1, 2} \\subseteq {1, 3}"), "FALSE");
    assert_eq!(eval_ok("2 \\in 1..3"), "TRUE");
    assert_eq!(eval_ok("4 \\notin 1..3"), "TRUE");
    assert_eq!(eval_ok("{x \\in 1..10 : x % 3 = 0}"), "{3, 6, 9}");
    assert_eq!(eval_ok("{x * x : x \\in 1..3}"), "{1, 4, 9}");
    // SUBSET stays symbolic until it must be expanded (Java's PrintT
    // deep-normalizes before printing; equality below is Java-verified,
    // including the cardinality-first element order of the expansion).
    assert_eq!(eval_ok("SUBSET {1, 2}"), "SUBSET {1, 2}");
    assert_eq!(eval_ok("SUBSET {1, 2} = {{}, {1}, {2}, {1, 2}}"), "TRUE");
    assert_eq!(eval_ok("{s \\in SUBSET {1, 2} : TRUE}"), "{{}, {1}, {2}, {1, 2}}");
    assert_eq!(eval_ok("{1} \\X {2, 3} = {<<1, 2>>, <<1, 3>>}"), "TRUE");
    assert_eq!(eval_ok("1..3 = {3, 2, 1}"), "TRUE");
    assert_eq!(eval_ok("\\A b \\in BOOLEAN : b \\/ ~b"), "TRUE");
    // Mixed-kind set construction errors on normalization, as Java.
    assert!(eval_err("{1, \"a\"}").contains("compare"));
}

#[test]
fn symbolic_set_membership_without_expansion() {
    // [1..10 -> 1..10] has 10^10 elements — far over the enumeration limit;
    // membership must not expand it.
    assert_eq!(eval_ok("[i \\in 1..10 |-> 11 - i] \\in [1..10 -> 1..10]"), "TRUE");
    assert_eq!(eval_ok("[i \\in 1..10 |-> i + 5] \\in [1..10 -> 1..10]"), "FALSE");
    // Java-verified membership golden run.
    assert_eq!(eval_ok("[i \\in 1..2 |-> i] \\in [1..2 -> Nat]"), "TRUE");
    assert_eq!(eval_ok("<<1, 2>> \\in [1..2 -> Nat]"), "TRUE");
    assert_eq!(eval_ok("[i \\in 1..2 |-> i] \\in [1..3 -> Nat]"), "FALSE");
    assert_eq!(eval_ok("[a |-> 1] \\in [{\"a\"} -> Int]"), "TRUE"); // Java-verified
    assert_eq!(eval_ok("[a |-> 1] \\in [a : {1, 2}]"), "TRUE");
    assert_eq!(eval_ok("[a |-> 3] \\in [a : {1, 2}]"), "FALSE");
    assert_eq!(eval_ok("<<1, 4>> \\in {1, 2} \\X {3, 4}"), "TRUE");
    // Nat / Int / BOOLEAN / STRING (Java-verified golden run).
    assert_eq!(eval_ok("3 \\in Nat"), "TRUE");
    assert_eq!(eval_ok("-3 \\in Nat"), "FALSE");
    assert_eq!(eval_ok("-3 \\in Int"), "TRUE");
    assert_eq!(eval_ok("{TRUE, FALSE} = BOOLEAN"), "TRUE"); // Java-verified
    assert_eq!(eval_ok("\"a\" \\in STRING"), "TRUE");
}

#[test]
fn symbolic_set_cardinality_and_limits() {
    // Java-verified cardinalities.
    assert_eq!(eval_ok("Cardinality(SUBSET {1, 2, 3})"), "8");
    assert_eq!(eval_ok("Cardinality([{1, 2} -> {1, 2, 3}])"), "9");
    assert_eq!(eval_ok("Cardinality([a : {1, 2}, b : {1, 2, 3}])"), "6");
    assert_eq!(eval_ok("Cardinality({1, 2} \\X {3, 4, 5})"), "6");
    assert_eq!(eval_ok("IsFiniteSet(1..10)"), "TRUE");
    assert_eq!(eval_ok("IsFiniteSet(Nat)"), "FALSE");
    // Enumerating a set over the limit is a clean error.
    assert!(eval_err("\\A s \\in SUBSET (1..30) : TRUE").contains("too big"));
    assert!(eval_err("\\E n \\in Nat : n = 1").contains("non-enumerable"));
}

// ---- functions, records, tuples --------------------------------------------

#[test]
fn functions_and_application() {
    assert_eq!(eval_ok("[i \\in 1..3 |-> i * i][2]"), "4");
    assert_eq!(eval_ok("[i \\in 1..3 |-> i * i]"), "<<1, 4, 9>>");
    assert_eq!(eval_ok("[x \\in 1..2, y \\in 1..2 |-> 10 * x + y][2, 1]"), "21");
    assert_eq!(eval_ok("[<<x, y>> \\in {1} \\X {2} |-> x + y][<<1, 2>>]"), "3");
    assert_eq!(eval_ok("DOMAIN [a |-> 1, b |-> 2]"), "{\"a\", \"b\"}");
    assert_eq!(eval_ok("DOMAIN <<9, 9>>"), "1..2");
    assert_eq!(eval_ok("<<7, 8, 9>>[3]"), "9");
    assert_eq!(eval_ok("[a |-> 1, b |-> 2].b"), "2");
    // Java-verified unifications.
    assert_eq!(eval_ok("<<1, 2>> = [i \\in 1..2 |-> i]"), "TRUE");
    assert_eq!(eval_ok("[a |-> 1] = (\"a\" :> 1)"), "TRUE");
    // Errors.
    assert!(eval_err("[i \\in 1..3 |-> i][4]").contains("not in the domain"));
    assert!(eval_err("[a |-> 1].c").contains("field c"));
    assert!(eval_err("5[1]").contains("non-function"));
}

#[test]
fn except_updates() {
    // Java-verified: deep path with @.
    assert_eq!(eval_ok("[ [a |-> <<1, 2>>] EXCEPT !.a[2] = @ + 10 ]"), "[a |-> <<1, 12>>]");
    assert_eq!(eval_ok("[ [i \\in 1..3 |-> i] EXCEPT ![1] = 0, ![2] = @ + 5 ]"), "<<0, 7, 3>>");
    assert_eq!(eval_ok("[ [a |-> 1, b |-> 2] EXCEPT !.a = @ * 10 ]"), "[a |-> 10, b |-> 2]");
    // Java-verified: updates along non-existing paths warn and do nothing.
    assert_eq!(eval_ok("[ [i \\in 1..3 |-> i * i] EXCEPT ![5] = 99 ]"), "<<1, 4, 9>>");
    assert_eq!(eval_ok("[ [a |-> 1, b |-> 2] EXCEPT !.c = 9 ]"), "[a |-> 1, b |-> 2]");
    // Nested @ in tuple-of-record.
    assert_eq!(
        eval_ok("[ <<[n |-> 5]>> EXCEPT ![1].n = @ - 1 ]"),
        "<<[n |-> 4]>>"
    );
}

#[test]
fn tlc_module_function_builders() {
    assert_eq!(eval_ok("(1 :> 2) @@ (1 :> 3) @@ (2 :> 4)"), "<<2, 4>>"); // Java-verified
    assert_eq!(eval_ok("(\"x\" :> 1) @@ (\"y\" :> 2)"), "[x |-> 1, y |-> 2]");
    assert_eq!(eval_ok("(0 :> \"a\")"), "(0 :> \"a\")");
}

// ---- quantifiers and CHOOSE ------------------------------------------------

#[test]
fn quantifiers() {
    assert_eq!(eval_ok("\\A x \\in 1..3 : \\E y \\in 1..3 : x + y = 4"), "TRUE"); // Java-verified
    assert_eq!(eval_ok("\\E x \\in 1..3 : x > 3"), "FALSE");
    assert_eq!(eval_ok("\\A x \\in {} : FALSE"), "TRUE");
    assert_eq!(eval_ok("\\E x \\in {} : TRUE"), "FALSE");
    assert_eq!(eval_ok("\\E x, y \\in 1..2 : x + y = 4"), "TRUE");
    assert_eq!(eval_ok("\\E <<a, b>> \\in {1, 2} \\X {3, 4} : a + b = 6"), "TRUE");
    // Short-circuiting must skip evaluation of later bodies.
    assert_eq!(eval_ok("\\E x \\in 1..3 : x = 1 \\/ 1 \\div 0 = 0"), "TRUE");
    assert!(eval_err("\\E x : x = 1").contains("unbounded"));
    assert!(eval_err("\\A x \\in 1..3 : x").contains("not a boolean"));
}

#[test]
fn choose_determinism() {
    // First element in normalized (sorted) order — Java-verified.
    assert_eq!(eval_ok("CHOOSE x \\in {3, 1, 2} : TRUE"), "1");
    assert_eq!(eval_ok("CHOOSE x \\in 1..10 : x * x > 10"), "4");
    // Java-verified tuple-destructuring CHOOSE.
    assert_eq!(eval_ok("CHOOSE <<x, y>> \\in (1..2) \\X (1..2) : x + y = 3"), "<<1, 2>>");
    assert!(eval_err("CHOOSE x \\in {1, 2} : x > 5").contains("no element of S satisfied P"));
    assert!(eval_err("CHOOSE x : x = 1").contains("unbounded CHOOSE"));
}

// ---- sequences -------------------------------------------------------------

#[test]
fn sequence_natives() {
    // Java-verified golden run.
    assert_eq!(eval_ok("SubSeq(<<1, 2, 3, 4>>, 2, 3)"), "<<2, 3>>");
    assert_eq!(eval_ok("SubSeq(<<1, 2>>, 2, 1)"), "<<>>");
    assert_eq!(eval_ok("Append(<<1>>, 2)"), "<<1, 2>>");
    assert_eq!(eval_ok("Tail(<<1, 2, 3>>)"), "<<2, 3>>");
    assert_eq!(eval_ok("Head(<<1, 2>>)"), "1");
    assert_eq!(eval_ok("<<1, 2>> \\o <<3>>"), "<<1, 2, 3>>");
    assert_eq!(eval_ok("Len(<<7, 8, 9>>)"), "3");
    assert_eq!(eval_ok("Len(\"abc\")"), "3"); // Java-verified
    assert_eq!(eval_ok("Len(<<>>)"), "0");
    // Java-verified Seq membership (no materialization).
    assert_eq!(eval_ok("<<1, 2>> \\in Seq({1, 2, 3})"), "TRUE");
    assert_eq!(eval_ok("<<1, 4>> \\in Seq({1, 2, 3})"), "FALSE");
    assert_eq!(eval_ok("<<>> \\in Seq({1})"), "TRUE");
    // Seq(S) is now a first-class (lazy) set value.
    assert_eq!(eval_ok("Seq({1})"), "Seq({1})");
    assert!(eval_err("Head(<<>>)").contains("empty sequence"));
    assert!(eval_err("SubSeq(<<1, 2>>, 1, 3)").contains("domain"));
    // SelectSeq goes through the generic path (LET + recursive function +
    // operator parameter).
    assert_eq!(eval_ok("SelectSeq(<<1, 2, 3, 4>>, LAMBDA x : x % 2 = 0)"), "<<2, 4>>");
}

// ---- strings ---------------------------------------------------------------

#[test]
fn strings() {
    assert_eq!(eval_ok("\"ab\" = \"ab\""), "TRUE"); // Java-verified
    assert_eq!(eval_ok("\"a\" # \"b\""), "TRUE"); // Java-verified
    assert_eq!(eval_ok("{\"b\", \"a\", \"b\"}"), "{\"a\", \"b\"}"); // Java-verified
    assert_eq!(eval_ok("\"hi\" \\in {\"hi\", \"lo\"}"), "TRUE");
    assert!(eval_err("\"a\" < \"b\"").contains("integer"));
}

// ---- control flow ----------------------------------------------------------

#[test]
fn if_and_case() {
    assert_eq!(eval_ok("IF 1 < 2 THEN \"y\" ELSE \"n\""), "\"y\"");
    assert_eq!(eval_ok("IF 1 > 2 THEN \"y\" ELSE \"n\""), "\"n\"");
    assert!(eval_err("IF 3 THEN 1 ELSE 2").contains("condition of an IF"));
    assert_eq!(eval_ok("CASE 2 > 1 -> \"a\" [] OTHER -> \"b\""), "\"a\"");
    assert_eq!(eval_ok("CASE 1 > 2 -> \"a\" [] 2 > 1 -> \"b\" [] OTHER -> \"c\""), "\"b\"");
    assert_eq!(eval_ok("CASE 1 > 2 -> \"a\" [] OTHER -> \"c\""), "\"c\"");
    assert!(eval_err("CASE 1 > 2 -> \"a\"").contains("CASE with no conditions true"));
}

// ---- LET, recursion, operators ---------------------------------------------

#[test]
fn let_definitions() {
    assert_eq!(eval_ok("LET x == 3 y == x + 1 IN x * y"), "12");
    assert_eq!(eval_ok("LET Sq(n) == n * n IN Sq(5)"), "25");
    assert_eq!(eval_ok("LET f[i \\in 1..3] == i * 2 IN f[3]"), "6");
    // Lazy: an unused LET definition is never evaluated.
    assert_eq!(eval_ok("LET boom == 1 \\div 0 IN 42"), "42");
    // LET defs capture enclosing parameters.
    assert_eq!(
        probe("Op(x) == LET y == x + 1 IN y * y\nProbe == Op(2) + Op(3)").unwrap(),
        "25"
    );
}

#[test]
fn let_memoization_of_constant_defs() {
    // The memoized LET value must evaluate (and Print) exactly once.
    let src = format!("---- MODULE T ----\n{EXTENDS}\nProbe == LET v == Print(\"m\", 3) IN v + v\n====\n");
    let mut interner = Interner::new();
    let analysis =
        sem::analyze("T", &src, &MapResolver { modules: &[] }, &mut interner).unwrap();
    let fp = Fp64Table::new();
    let vctx = ValueCtx { interner: &interner, fp: &fp };
    let ev = Evaluator::new(&analysis, vctx);
    let v = ev.eval_def_named("Probe").unwrap();
    assert_eq!(v.display(&ev.vctx), "6");
    assert_eq!(ev.printed.borrow().as_slice(), ["\"m\"  3"]);
}

#[test]
fn recursive_operators_and_functions() {
    assert_eq!(
        probe("RECURSIVE Fact(_)\nFact(n) == IF n = 0 THEN 1 ELSE n * Fact(n - 1)\nProbe == Fact(10)")
            .unwrap(),
        "3628800"
    );
    // Recursive function definition (factorial via f[n-1]).
    assert_eq!(
        probe("f[n \\in 0..5] == IF n = 0 THEN 1 ELSE n * f[n - 1]\nProbe == f[5]").unwrap(),
        "120"
    );
    // Recursive function inside LET (Fibonacci).
    assert_eq!(
        eval_ok("LET fib[n \\in 0..10] == IF n < 2 THEN n ELSE fib[n - 1] + fib[n - 2] IN fib[10]"),
        "55"
    );
    // Infinite recursion hits the depth/stack guard, not the process stack.
    assert!(probe("RECURSIVE Inf(_)\nInf(n) == Inf(n + 1)\nProbe == Inf(0)")
        .unwrap_err()
        .contains("recursion limit"));
}

#[test]
fn higher_order_operators() {
    assert_eq!(
        probe("Twice(op(_), x) == op(op(x))\nSucc(n) == n + 1\nProbe == Twice(Succ, 5)").unwrap(),
        "7"
    );
    assert_eq!(
        probe("Apply2(op(_, _), a, b) == op(a, b)\nProbe == Apply2(LAMBDA x, y : x + y, 2, 3)")
            .unwrap(),
        "5"
    );
    // Permutations from TLC.tla evaluates via the generic path
    // ({f \in [S -> S] : ...} over symbolic [S -> S]).
    assert_eq!(eval_ok("Cardinality(Permutations({1, 2, 3}))"), "6");
}

#[test]
fn bags_via_generic_path() {
    // Bags has no natives: CHOOSE/EXCEPT/LET-heavy definitions evaluate
    // through the generic evaluator.
    assert_eq!(eval_ok("BagCardinality(SetToBag({1, 2}) (+) EmptyBag)"), "2");
    assert_eq!(eval_ok("BagToSet(SetToBag({1, 2}))"), "{1, 2}");
    assert_eq!(eval_ok("CopiesIn(1, SetToBag({1, 2}) (+) SetToBag({1}))"), "2");
}

// ---- TLC module ------------------------------------------------------------

#[test]
fn print_and_assert() {
    let src = format!(
        "---- MODULE T ----\n{EXTENDS}\nProbe == /\\ PrintT(\"hello\")\n         /\\ Print(1..2, TRUE)\n====\n"
    );
    let mut interner = Interner::new();
    let analysis =
        sem::analyze("T", &src, &MapResolver { modules: &[] }, &mut interner).unwrap();
    let fp = Fp64Table::new();
    let vctx = ValueCtx { interner: &interner, fp: &fp };
    let ev = Evaluator::new(&analysis, vctx);
    let v = ev.eval_def_named("Probe").unwrap();
    assert_eq!(v.display(&ev.vctx), "TRUE");
    assert_eq!(ev.printed.borrow().as_slice(), ["\"hello\"", "1..2  TRUE"]);

    assert_eq!(eval_ok("Assert(1 < 2, \"fine\")"), "TRUE");
    let e = eval_err("Assert(1 > 2, \"boom\")");
    assert!(e.contains("The first argument of Assert evaluated to FALSE"), "{e}");
    assert!(e.contains("\"boom\""), "{e}");
    assert!(eval_err("TLCGet(1)").contains("has no value"));
}

// ---- constants, state variables, model values ------------------------------

#[test]
fn constants_and_state_variables() {
    // Unbound constant.
    let e = probe_with(&format!("{EXTENDS}\nCONSTANT N"), "Probe == N + 1").unwrap_err();
    assert!(e.contains("constant parameter N is not assigned"), "{e}");
    // State variable in a constant expression.
    let e = probe_with(&format!("{EXTENDS}\nVARIABLE y"), "Probe == y = 1").unwrap_err();
    assert!(e.contains("state variable 'y'"), "{e}");

    // Bound constant + model values through the public API.
    let src = format!("---- MODULE T ----\n{EXTENDS}\nCONSTANTS N, X\nProbe == {{X}} \\cup {{1 .. N}}\n====\n");
    let mut interner = Interner::new();
    let analysis =
        sem::analyze("T", &src, &MapResolver { modules: &[] }, &mut interner).unwrap();
    let mv = Value::model("mv1", &mut interner);
    let fp = Fp64Table::new();
    let vctx = ValueCtx { interner: &interner, fp: &fp };
    let mut ev = Evaluator::new(&analysis, vctx);
    let n = analysis.consts.iter().position(|c| interner.str(c.name) == "N").unwrap();
    let x = analysis.consts.iter().position(|c| interner.str(c.name) == "X").unwrap();
    ev.const_values.insert(sem::ConstId(n as u32), Value::Int(3));
    ev.const_values.insert(sem::ConstId(x as u32), mv);
    let v = ev.eval_def_named("Probe").unwrap();
    assert_eq!(v.display(&ev.vctx), "{mv1, 1..3}");
}

// ---- action/temporal rejection ---------------------------------------------

#[test]
fn action_and_temporal_operators_are_rejected() {
    let hdr = format!("{EXTENDS}\nVARIABLE y");
    assert!(probe_with(&hdr, "Probe == y' = 1").unwrap_err().contains("constant expression"));
    assert!(probe_with(&hdr, "Probe == [][y' = y]_y").unwrap_err().contains("constant expression"));
    assert!(probe_with(&hdr, "Probe == WF_y(y' = y)").unwrap_err().contains("constant expression"));
    assert!(probe_with(&hdr, "Probe == ENABLED (y = 1)").unwrap_err().contains("ENABLED"));
}

// ---- fingerprint / equality agreement --------------------------------------

#[test]
fn symbolic_sets_fingerprint_as_their_expansion() {
    let src = format!(
        "---- MODULE T ----\n{EXTENDS}\nA == SUBSET {{1, 2}}\nB == {{{{}}, {{1}}, {{2}}, {{1, 2}}}}\nC == [{{1}} -> {{2, 3}}]\nD == {{(1 :> 2), (1 :> 3)}}\n====\n"
    );
    let mut interner = Interner::new();
    let analysis =
        sem::analyze("T", &src, &MapResolver { modules: &[] }, &mut interner).unwrap();
    let fp = Fp64Table::new();
    let vctx = ValueCtx { interner: &interner, fp: &fp };
    let ev = Evaluator::new(&analysis, vctx);
    for (a, b) in [("A", "B"), ("C", "D")] {
        let va = ev.eval_def_named(a).unwrap();
        let vb = ev.eval_def_named(b).unwrap();
        assert!(va.tla_eq(&vb, &ev.vctx).unwrap(), "{a} != {b}");
        assert_eq!(
            va.fingerprint(&ev.vctx).unwrap(),
            vb.fingerprint(&ev.vctx).unwrap(),
            "fp({a}) != fp({b})"
        );
    }
}

#[test]
fn except_warning_is_recorded() {
    let src = format!(
        "---- MODULE T ----\n{EXTENDS}\nProbe == [ [a |-> 1] EXCEPT !.b = 2 ]\n====\n"
    );
    let mut interner = Interner::new();
    let analysis =
        sem::analyze("T", &src, &MapResolver { modules: &[] }, &mut interner).unwrap();
    let fp = Fp64Table::new();
    let vctx = ValueCtx { interner: &interner, fp: &fp };
    let ev = Evaluator::new(&analysis, vctx);
    let v = ev.eval_def_named("Probe").unwrap();
    assert_eq!(v.display(&ev.vctx), "[a |-> 1]");
    assert_eq!(ev.warnings.borrow().len(), 1);
    assert!(ev.warnings.borrow()[0].contains("EXCEPT was applied to non-existing fields"));
}
