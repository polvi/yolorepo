--------------------------- MODULE Gratos_AAuth ----------------------------
(* AAuth Person Server consent/mission state machines (acceptance test). *)
EXTENDS Naturals, FiniteSets

CONSTANTS
    Users,
    MissionIds,
    PendingIds,
    Resources,
    MaxAmt,
    NoUser

ASSUME NoUser \notin Users
ASSUME MaxAmt \in Nat \ {0}

MStatuses == {"none", "proposed", "active", "completed", "declined", "revoked", "expired"}
MClosed   == {"completed", "declined", "revoked", "expired"}
Activated == {"active", "completed", "revoked"}
PStatuses == {"none", "pending", "approved", "denied", "gone"}

Budgets    == [Resources -> 0..MaxAmt]
ZeroBudget == [r \in Resources |-> 0]

VARIABLES
    mStatus,
    mHint,
    mCode,
    mProposed,
    mGranted,
    mBy,
    mDecisions,
    mMintedAt,
    pStatus,
    pCode,
    pMinted,
    pDelivered

missionVars == <<mStatus, mHint, mCode, mProposed, mGranted, mBy, mDecisions, mMintedAt>>
pendingVars == <<pStatus, pCode, pMinted, pDelivered>>
vars == <<missionVars, pendingVars>>

Init ==
    /\ mStatus    = [m \in MissionIds |-> "none"]
    /\ mHint      = [m \in MissionIds |-> NoUser]
    /\ mCode      = [m \in MissionIds |-> FALSE]
    /\ mProposed  = [m \in MissionIds |-> ZeroBudget]
    /\ mGranted   = [m \in MissionIds |-> ZeroBudget]
    /\ mBy        = [m \in MissionIds |-> NoUser]
    /\ mDecisions = [m \in MissionIds |-> 0]
    /\ mMintedAt  = [m \in MissionIds |-> {}]
    /\ pStatus    = [p \in PendingIds |-> "none"]
    /\ pCode      = [p \in PendingIds |-> FALSE]
    /\ pMinted    = [p \in PendingIds |-> 0]
    /\ pDelivered = [p \in PendingIds |-> 0]

Propose(m, hint, b) ==
    /\ mStatus[m] = "none"
    /\ mStatus'   = [mStatus EXCEPT ![m] = "proposed"]
    /\ mHint'     = [mHint EXCEPT ![m] = hint]
    /\ mCode'     = [mCode EXCEPT ![m] = TRUE]
    /\ mProposed' = [mProposed EXCEPT ![m] = b]
    /\ UNCHANGED <<mGranted, mBy, mDecisions, mMintedAt, pendingVars>>

Approve(m, u, g) ==
    /\ mStatus[m] = "proposed"
    /\ mCode[m]
    /\ mHint[m] \in {NoUser, u}
    /\ \A r \in Resources : g[r] <= mProposed[m][r]
    /\ mStatus'    = [mStatus EXCEPT ![m] = "active"]
    /\ mCode'      = [mCode EXCEPT ![m] = FALSE]
    /\ mGranted'   = [mGranted EXCEPT ![m] = g]
    /\ mBy'        = [mBy EXCEPT ![m] = u]
    /\ mDecisions' = [mDecisions EXCEPT ![m] = @ + 1]
    /\ UNCHANGED <<mHint, mProposed, mMintedAt, pendingVars>>

Decline(m, u) ==
    /\ mStatus[m] = "proposed"
    /\ mCode[m]
    /\ mHint[m] \in {NoUser, u}
    /\ mStatus'    = [mStatus EXCEPT ![m] = "declined"]
    /\ mCode'      = [mCode EXCEPT ![m] = FALSE]
    /\ mBy'        = [mBy EXCEPT ![m] = u]
    /\ mDecisions' = [mDecisions EXCEPT ![m] = @ + 1]
    /\ UNCHANGED <<mHint, mProposed, mGranted, mMintedAt, pendingVars>>

ExpireProposal(m) ==
    /\ mStatus[m] = "proposed"
    /\ mStatus' = [mStatus EXCEPT ![m] = "expired"]
    /\ mCode'   = [mCode EXCEPT ![m] = FALSE]
    /\ UNCHANGED <<mHint, mProposed, mGranted, mBy, mDecisions, mMintedAt, pendingVars>>

Complete(m) ==
    /\ mStatus[m] = "active"
    /\ mStatus' = [mStatus EXCEPT ![m] = "completed"]
    /\ UNCHANGED <<mHint, mCode, mProposed, mGranted, mBy, mDecisions, mMintedAt, pendingVars>>

Revoke(m, u) ==
    /\ mStatus[m] = "active"
    /\ mBy[m] = u
    /\ mStatus' = [mStatus EXCEPT ![m] = "revoked"]
    /\ UNCHANGED <<mHint, mCode, mProposed, mGranted, mBy, mDecisions, mMintedAt, pendingVars>>

MintBudgetToken(m) ==
    /\ mStatus[m] = "active"
    /\ \E r \in Resources : mGranted[m][r] > 0
    /\ mMintedAt' = [mMintedAt EXCEPT ![m] = @ \cup {mStatus[m]}]
    /\ UNCHANGED <<mStatus, mHint, mCode, mProposed, mGranted, mBy, mDecisions, pendingVars>>

CreatePending(p) ==
    /\ pStatus[p] = "none"
    /\ pStatus' = [pStatus EXCEPT ![p] = "pending"]
    /\ pCode'   = [pCode EXCEPT ![p] = TRUE]
    /\ UNCHANGED <<pMinted, pDelivered, missionVars>>

ApprovePending(p) ==
    /\ pStatus[p] = "pending"
    /\ pCode[p]
    /\ pStatus' = [pStatus EXCEPT ![p] = "approved"]
    /\ pCode'   = [pCode EXCEPT ![p] = FALSE]
    /\ pMinted' = [pMinted EXCEPT ![p] = @ + 1]
    /\ UNCHANGED <<pDelivered, missionVars>>

DenyPending(p) ==
    /\ pStatus[p] = "pending"
    /\ pCode[p]
    /\ pStatus' = [pStatus EXCEPT ![p] = "denied"]
    /\ pCode'   = [pCode EXCEPT ![p] = FALSE]
    /\ UNCHANGED <<pMinted, pDelivered, missionVars>>

PickupPending(p) ==
    /\ pStatus[p] \in {"approved", "denied"}
    /\ pStatus'    = [pStatus EXCEPT ![p] = "gone"]
    /\ pDelivered' = [pDelivered EXCEPT ![p] = IF pStatus[p] = "approved" THEN @ + 1 ELSE @]
    /\ UNCHANGED <<pCode, pMinted, missionVars>>

ExpirePending(p) ==
    /\ pStatus[p] \in {"pending", "approved", "denied"}
    /\ pStatus' = [pStatus EXCEPT ![p] = "gone"]
    /\ pCode'   = [pCode EXCEPT ![p] = FALSE]
    /\ UNCHANGED <<pMinted, pDelivered, missionVars>>

ExpirePendingCode(p) ==
    /\ pStatus[p] = "pending"
    /\ pCode[p]
    /\ pCode' = [pCode EXCEPT ![p] = FALSE]
    /\ UNCHANGED <<pStatus, pMinted, pDelivered, missionVars>>

Next ==
    \/ \E m \in MissionIds :
        \/ \E hint \in Users \cup {NoUser} : \E b \in Budgets : Propose(m, hint, b)
        \/ \E u \in Users :
            \/ \E g \in Budgets : Approve(m, u, g)
            \/ Decline(m, u)
            \/ Revoke(m, u)
        \/ ExpireProposal(m)
        \/ Complete(m)
        \/ MintBudgetToken(m)
    \/ \E p \in PendingIds :
        \/ CreatePending(p)
        \/ ApprovePending(p)
        \/ DenyPending(p)
        \/ PickupPending(p)
        \/ ExpirePending(p)
        \/ ExpirePendingCode(p)

Spec == Init /\ [][Next]_vars

TypeOK ==
    /\ mStatus    \in [MissionIds -> MStatuses]
    /\ mHint      \in [MissionIds -> Users \cup {NoUser}]
    /\ mCode      \in [MissionIds -> BOOLEAN]
    /\ mProposed  \in [MissionIds -> Budgets]
    /\ mGranted   \in [MissionIds -> Budgets]
    /\ mBy        \in [MissionIds -> Users \cup {NoUser}]
    /\ mDecisions \in [MissionIds -> 0..2]
    /\ mMintedAt  \in [MissionIds -> SUBSET MStatuses]
    /\ pStatus    \in [PendingIds -> PStatuses]
    /\ pCode      \in [PendingIds -> BOOLEAN]
    /\ pMinted    \in [PendingIds -> 0..2]
    /\ pDelivered \in [PendingIds -> 0..2]

CodeSingleUse ==
    /\ \A m \in MissionIds :
        /\ mDecisions[m] <= 1
        /\ mStatus[m] # "proposed" => ~mCode[m]
    /\ \A p \in PendingIds :
        pStatus[p] # "pending" => ~pCode[p]

ApproverBinding ==
    \A m \in MissionIds :
        mStatus[m] \in {"active", "completed", "revoked", "declined"} =>
            mHint[m] \in {NoUser, mBy[m]}

AttenuationNeverWidens ==
    \A m \in MissionIds :
        IF mStatus[m] \in Activated
        THEN \A r \in Resources : mGranted[m][r] <= mProposed[m][r]
        ELSE mGranted[m] = ZeroBudget

NoIssuanceAfterClose ==
    \A m \in MissionIds : mMintedAt[m] \subseteq {"active"}

OneShotPickup ==
    \A p \in PendingIds :
        /\ pMinted[p] <= 1
        /\ pDelivered[p] <= 1
        /\ pDelivered[p] <= pMinted[p]

ClosedIsTerminal ==
    [][\A m \in MissionIds : mStatus[m] \in MClosed => mStatus'[m] = mStatus[m]]_vars

GoneIsTerminal ==
    [][\A p \in PendingIds : pStatus[p] = "gone" => pStatus'[p] = "gone"]_vars

=============================================================================
