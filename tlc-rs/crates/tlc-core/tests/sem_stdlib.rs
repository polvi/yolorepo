//! Semantic analysis over the bundled standard modules: the whole EXTENDS /
//! LOCAL INSTANCE closure (all six stdlib modules) must load and resolve.

use tlc_core::intern::Interner;
use tlc_core::sem;
use tlc_core::MapResolver;

const SPEC: &str = r#"
---- MODULE T ----
EXTENDS Naturals, Integers, Sequences, FiniteSets, Bags

Three == 1 + 2
NegOne == -1
SeqLen(s) == Len(s) + Len(Append(s, 3))
Card == Cardinality({1, 2, 3})
BagStuff == BagCardinality(SetToBag({1, 2}) (+) EmptyBag)
Range(a, b) == a .. b
====
"#;

#[test]
fn stdlib_closure_analyzes() {
    let mut interner = Interner::new();
    let resolver = MapResolver { modules: &[] };
    let a = sem::analyze("T", SPEC, &resolver, &mut interner).unwrap_or_else(|ds| {
        panic!(
            "analysis failed:\n{}",
            ds.iter().map(|d| d.to_string()).collect::<Vec<_>>().join("\n")
        )
    });

    // Naturals, Integers, Sequences, FiniteSets, TLC (via Bags), Bags + T.
    assert_eq!(a.modules.len(), 7, "expected all six stdlib modules plus T");
    for name in ["Naturals", "Integers", "Sequences", "FiniteSets", "TLC", "Bags"] {
        let sym = interner.get(name).unwrap_or_else(|| panic!("{name} not interned"));
        assert!(a.module_ids.contains_key(&sym), "module {name} not loaded");
    }

    // The root is last, and everything here is constant-level.
    let root = a.root;
    assert_eq!(a.module(root).name, interner.get("T").unwrap());
    for def in ["Three", "SeqLen", "Card", "BagStuff", "Range"] {
        let d = a.find_def(&interner, root, def).unwrap_or_else(|| panic!("{def} not found"));
        assert_eq!(a.def_level(d), 0, "{def} should be constant-level");
    }

    // `+` in T resolves to the Naturals definition (imported via EXTENDS),
    // exactly like a user-defined operator symbol would.
    let plus = interner.get("+").unwrap();
    let naturals = a.module_ids[&interner.get("Naturals").unwrap()];
    let plus_def = a.find_def(&interner, naturals, "+").expect("Naturals defines +");
    let three = a.find_def(&interner, root, "Three").unwrap();
    let body = a.defs[three.0 as usize].body.expect("Three has a body");
    assert_eq!(a.expr_ref(root, body), Some(sem::Ref::Def(plus_def)));
    let _ = plus;
}
