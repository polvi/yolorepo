//! Golden error tests for semantic analysis and level checking.

use tlc_core::diag::{Category, Diag};
use tlc_core::intern::Interner;
use tlc_core::sem;
use tlc_core::MapResolver;

fn analyze_err(src: &str) -> Vec<Diag> {
    analyze_err_named("T", src)
}

fn analyze_err_named(name: &str, src: &str) -> Vec<Diag> {
    let mut interner = Interner::new();
    let resolver = MapResolver { modules: &[] };
    match sem::analyze(name, src, &resolver, &mut interner) {
        Ok(_) => panic!("expected analysis to fail:\n{src}"),
        Err(ds) => ds,
    }
}

fn assert_has(diags: &[Diag], category: Category, code: &str) {
    assert!(
        diags.iter().any(|d| d.category == category && d.code == code),
        "expected a {category:?} diagnostic with code {code}, got:\n{}",
        diags.iter().map(|d| d.to_string()).collect::<Vec<_>>().join("\n")
    );
}

#[test]
fn undefined_symbol() {
    let diags = analyze_err("---- MODULE T ----\nFoo == Bar\n====\n");
    assert_has(&diags, Category::Semantic, "S0101");
    let d = diags.iter().find(|d| d.code == "S0101").unwrap();
    assert!(d.message.contains("Bar"), "message names the symbol: {}", d.message);
    assert!(d.span.is_some(), "diagnostic carries a span");
}

#[test]
fn duplicate_definition() {
    let diags = analyze_err("---- MODULE T ----\nFoo == 1\nFoo == 2\n====\n");
    assert_has(&diags, Category::Semantic, "S0102");
    let d = diags.iter().find(|d| d.code == "S0102").unwrap();
    assert!(d.message.contains("Foo"));
    assert!(!d.notes.is_empty(), "redefinition notes the previous site");
}

#[test]
fn binder_shadowing_is_an_error() {
    // A bound variable shadowing a definition is also "multiply-defined".
    let diags = analyze_err("---- MODULE T ----\nFoo == 1\nBar == \\E Foo \\in {1} : TRUE\n====\n");
    assert_has(&diags, Category::Semantic, "S0102");
}

#[test]
fn arity_mismatch() {
    let diags = analyze_err("---- MODULE T ----\nFoo(x) == x\nBar == Foo(1, 2)\n====\n");
    assert_has(&diags, Category::Semantic, "S0103");
    let d = diags.iter().find(|d| d.code == "S0103").unwrap();
    assert!(
        d.message.contains("1 argument") && d.message.contains("2"),
        "message states declared vs actual arity: {}",
        d.message
    );
}

#[test]
fn double_prime_is_a_level_error() {
    let diags = analyze_err("---- MODULE T ----\nVARIABLE x\nA == x''\n====\n");
    assert_has(&diags, Category::Level, "L0001");
}

#[test]
fn assume_with_state_variable() {
    let diags = analyze_err("---- MODULE T ----\nVARIABLE x\nASSUME x = 1\n====\n");
    assert_has(&diags, Category::Level, "L0002");
}

#[test]
fn instance_with_substitution_unsupported() {
    let diags = analyze_err(
        "---- MODULE T ----\nVARIABLE x\nI == INSTANCE M WITH y <- x\n====\n",
    );
    assert_has(&diags, Category::Unsupported, "U0201");
}

#[test]
fn undefined_module() {
    let diags = analyze_err("---- MODULE T ----\nEXTENDS NoSuchModule\n====\n");
    assert_has(&diags, Category::Semantic, "S0001");
}

#[test]
fn recursive_without_definition() {
    let diags = analyze_err("---- MODULE T ----\nRECURSIVE Foo(_)\n====\n");
    assert_has(&diags, Category::Semantic, "S0109");
}

#[test]
fn at_outside_except() {
    let diags = analyze_err("---- MODULE T ----\nFoo == @\n====\n");
    assert_has(&diags, Category::Semantic, "S0106");
}

#[test]
fn recursive_definition_resolves() {
    // Sanity: RECURSIVE forward reference is legal and analyzes clean.
    let src = "---- MODULE T ----\nEXTENDS Naturals\nRECURSIVE Fact(_)\n\
               Fact(n) == IF n = 0 THEN 1 ELSE n * Fact(n - 1)\n====\n";
    let mut interner = Interner::new();
    let resolver = MapResolver { modules: &[] };
    let a = sem::analyze("T", src, &resolver, &mut interner).unwrap_or_else(|ds| {
        panic!(
            "expected clean analysis:\n{}",
            ds.iter().map(|d| d.to_string()).collect::<Vec<_>>().join("\n")
        )
    });
    let fact = a.find_def(&interner, a.root, "Fact").unwrap();
    assert_eq!(a.def_level(fact), 0);
}
