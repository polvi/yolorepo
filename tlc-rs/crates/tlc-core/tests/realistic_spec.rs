//! Parse test over a spec shaped like the user's agent-generated workload:
//! junction lists, function updates with `EXCEPT`/`@`, `[X -> Y]`, `SUBSET`,
//! quantifiers, tuples/UNCHANGED, `Spec == Init /\ [][Next]_vars`, and
//! box-action properties.

use tlc_core::intern::Interner;
use tlc_core::loc::FileId;

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
fn realistic_spec_parses() {
    let mut interner = Interner::new();
    let sf = tlc_core::syntax::parse_source(SPEC, FileId(0), &mut interner)
        .unwrap_or_else(|d| panic!("parse failed: {d}"));
    assert_eq!(interner.str(sf.module.name), "Workload");
    assert_eq!(sf.module.extends.len(), 2);
    // VARIABLES + 14 definitions + 2 ASSUME
    assert!(sf.module.units.len() >= 17, "got {} units", sf.module.units.len());
}
