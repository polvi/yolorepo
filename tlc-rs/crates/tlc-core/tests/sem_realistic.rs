//! Semantic + level analysis of the realistic agent-workload spec (same
//! source as tests/realistic_spec.rs), with exact level assertions.

use tlc_core::intern::Interner;
use tlc_core::sem;
use tlc_core::syntax::ast::Unit;
use tlc_core::MapResolver;

const SPEC: &str = r#"
---- MODULE Workload ----
EXTENDS Naturals, FiniteSets

CONSTANTS Users, MissionIds, Resources, MaxAmt, NoUser

ASSUME NoUser \notin Users
ASSUME MaxAmt \in Nat \ {0}

MStatuses == {"none", "proposed", "active", "completed"}
MClosed   == {"completed", "declined"}
Budgets    == [Resources -> 0..MaxAmt]
ZeroBudget == [r \in Resources |-> 0]

VARIABLES mStatus, mCode, mProposed, mGranted, mMintedAt

vars == <<mStatus, mCode, mProposed, mGranted, mMintedAt>>

Init ==
    /\ mStatus    = [m \in MissionIds |-> "none"]
    /\ mCode      = [m \in MissionIds |-> FALSE]
    /\ mProposed  = [m \in MissionIds |-> ZeroBudget]
    /\ mGranted   = [m \in MissionIds |-> ZeroBudget]
    /\ mMintedAt  = [m \in MissionIds |-> {}]

Propose(m, b) ==
    /\ mStatus[m] = "none"
    /\ mStatus'   = [mStatus EXCEPT ![m] = "proposed"]
    /\ mCode'     = [mCode EXCEPT ![m] = TRUE]
    /\ mProposed' = [mProposed EXCEPT ![m] = b]
    /\ UNCHANGED <<mGranted, mMintedAt>>

Approve(m, u, g) ==
    /\ mStatus[m] = "proposed"
    /\ mCode[m]
    /\ \A r \in Resources : g[r] <= mProposed[m][r]
    /\ mStatus'    = [mStatus EXCEPT ![m] = "active"]
    /\ mCode'      = [mCode EXCEPT ![m] = FALSE]
    /\ mGranted'   = [mGranted EXCEPT ![m] = g]
    /\ UNCHANGED <<mProposed, mMintedAt>>

MintBudgetToken(m) ==
    /\ mStatus[m] = "active"
    /\ \E r \in Resources : mGranted[m][r] > 0
    /\ mMintedAt' = [mMintedAt EXCEPT ![m] = @ \cup {mStatus[m]}]
    /\ UNCHANGED <<mStatus, mCode, mProposed, mGranted>>

Next ==
    \/ \E m \in MissionIds :
        \/ \E b \in Budgets : Propose(m, b)
        \/ \E u \in Users : \E g \in Budgets : Approve(m, u, g)
        \/ MintBudgetToken(m)

Spec == Init /\ [][Next]_vars

TypeOK ==
    /\ mStatus    \in [MissionIds -> MStatuses]
    /\ mCode      \in [MissionIds -> BOOLEAN]
    /\ mMintedAt  \in [MissionIds -> SUBSET MStatuses]

NoIssuanceAfterClose ==
    \A m \in MissionIds : mMintedAt[m] \subseteq {"active"}

ClosedIsTerminal ==
    [][\A m \in MissionIds : mStatus[m] \in MClosed => mStatus'[m] = mStatus[m]]_vars
====
"#;

#[test]
fn realistic_spec_analyzes_with_expected_levels() {
    let mut interner = Interner::new();
    let resolver = MapResolver { modules: &[] };
    let a = sem::analyze("Workload", SPEC, &resolver, &mut interner).unwrap_or_else(|ds| {
        panic!(
            "analysis failed:\n{}",
            ds.iter().map(|d| d.to_string()).collect::<Vec<_>>().join("\n")
        )
    });
    let root = a.root;

    let expected: &[(&str, sem::Level)] = &[
        ("MStatuses", 0),
        ("Budgets", 0),
        ("ZeroBudget", 0),
        ("vars", 1),
        ("Init", 1),
        ("TypeOK", 1),
        ("NoIssuanceAfterClose", 1),
        ("Propose", 2),
        ("Approve", 2),
        ("MintBudgetToken", 2),
        ("Next", 2),
        ("Spec", 3),
        ("ClosedIsTerminal", 3),
    ];
    for (name, level) in expected {
        let d = a
            .find_def(&interner, root, name)
            .unwrap_or_else(|| panic!("definition {name} not found"));
        assert_eq!(a.def_level(d), *level, "level of {name}");
    }

    // Both ASSUME expressions are constant-level.
    let mut assumes = 0;
    for unit in &a.module(root).source.module.units {
        if let Unit::Assume { expr, .. } = unit {
            assert_eq!(a.level(root, *expr), 0, "ASSUME expression level");
            assumes += 1;
        }
    }
    assert_eq!(assumes, 2);
}
