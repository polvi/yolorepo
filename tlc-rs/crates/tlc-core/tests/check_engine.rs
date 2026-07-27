//! Unit tests for the model checker (M4–M6): init enumeration, next-state
//! enumeration with bind/unbind backtracking, UNCHANGED handling, BFS check
//! ordering, deadlock, traces, and action properties.

use tlc_core::api::{CheckResponse, Status};
use tlc_core::check::bfs::CheckBudget;
use tlc_core::check::run_check_with_resolver;
use tlc_core::MapResolver;

fn check(spec_body: &str, cfg: &str) -> CheckResponse {
    let src = format!("---- MODULE T ----\nEXTENDS Naturals, Sequences, FiniteSets, TLC\n{spec_body}\n====\n");
    run_check_with_resolver(
        "T",
        &src,
        cfg,
        &MapResolver { modules: &[] },
        None,
        &CheckBudget::default(),
    )
}

fn stats(r: &CheckResponse) -> (u64, u64, u64) {
    let s = r.stats.as_ref().expect("stats");
    (s.states_generated, s.distinct_states, s.initial_states)
}

#[test]
fn init_assignment_and_membership() {
    // x = 1 -> one init state.
    let r = check("VARIABLE x\nInit == x = 1\nNext == x' = x", "INIT Init\nNEXT Next\nCHECK_DEADLOCK FALSE");
    assert_eq!(r.status, Status::Ok);
    assert_eq!(stats(&r), (2, 1, 1));

    // x \in 1..3 -> three init states.
    let r = check("VARIABLE x\nInit == x \\in 1..3\nNext == x' = x", "INIT Init\nNEXT Next\nCHECK_DEADLOCK FALSE");
    assert_eq!(r.status, Status::Ok);
    assert_eq!(stats(&r), (6, 3, 3));
}

#[test]
fn init_disjunction_and_guard_pruning() {
    // Disjunction generates both branches; a guard prunes.
    let r = check(
        "VARIABLE x\nInit == \\/ x = 1 /\\ x > 0\n        \\/ x = 2 /\\ x > 5\nNext == x' = x",
        "INIT Init\nNEXT Next\nCHECK_DEADLOCK FALSE",
    );
    assert_eq!(r.status, Status::Ok);
    // Both disjuncts bind x, only the first passes its guard.
    assert_eq!(stats(&r).2, 1);
}

#[test]
fn init_multi_var_conjunction() {
    let r = check(
        "VARIABLES x, y\nInit == x \\in 1..2 /\\ y \\in 1..2\nNext == UNCHANGED <<x, y>>",
        "INIT Init\nNEXT Next\nCHECK_DEADLOCK FALSE",
    );
    assert_eq!(r.status, Status::Ok);
    assert_eq!(stats(&r).1, 4);
}

#[test]
fn init_incomplete_is_error() {
    let r = check(
        "VARIABLES x, y\nInit == x = 1\nNext == UNCHANGED <<x, y>>",
        "INIT Init\nNEXT Next",
    );
    assert_eq!(r.status, Status::EvalError);
    let msg = &r.errors[0].message;
    assert!(msg.contains('y'), "{msg}");
}

#[test]
fn next_binding_and_backtracking() {
    // The first disjunct binds x' then fails its guard; a leaked binding
    // would block the second disjunct from binding x' = 2.
    let r = check(
        "VARIABLE x\nInit == x = 0\nNext == \\/ x' = 1 /\\ FALSE\n        \\/ x' = 2",
        "INIT Init\nNEXT Next\nCHECK_DEADLOCK FALSE",
    );
    assert_eq!(r.status, Status::Ok);
    // States: 0 (init) and 2. Generated: 1 init + one successor per step
    // (from 0 -> 2, from 2 -> 2).
    assert_eq!(stats(&r), (3, 2, 1));
}

#[test]
fn next_exists_enumeration() {
    let r = check(
        "VARIABLE x\nInit == x = 0\nNext == \\E d \\in 1..3 : x' = d",
        "INIT Init\nNEXT Next\nCHECK_DEADLOCK FALSE",
    );
    assert_eq!(r.status, Status::Ok);
    // 1 init + 3 successors from each of the 4 distinct states.
    assert_eq!(stats(&r), (1 + 4 * 3, 4, 1));
}

#[test]
fn next_equality_check_when_already_bound() {
    // x' = 1 /\ x' = 2 is unsatisfiable; x' = 1 /\ x' = 1 is fine.
    let r = check(
        "VARIABLE x\nInit == x = 0\nNext == x' = 1 /\\ x' = 2",
        "INIT Init\nNEXT Next",
    );
    assert_eq!(r.status, Status::Deadlock);
    let r = check(
        "VARIABLE x\nInit == x = 0\nNext == x' = 1 /\\ x' = 1",
        "INIT Init\nNEXT Next\nCHECK_DEADLOCK FALSE",
    );
    assert_eq!(r.status, Status::Ok);
    assert_eq!(stats(&r).1, 2);
}

#[test]
fn unchanged_variants() {
    // UNCHANGED of a variable, a tuple, and a definition expanding to vars.
    let r = check(
        "VARIABLES x, y\nvars == <<x, y>>\nInit == x = 0 /\\ y = 0\n\
         Next == \\/ x' = x + 1 /\\ x < 2 /\\ UNCHANGED y\n        \\/ UNCHANGED vars",
        "INIT Init\nNEXT Next\nCHECK_DEADLOCK FALSE",
    );
    assert_eq!(r.status, Status::Ok);
    assert_eq!(stats(&r).1, 3); // x in 0..2
}

#[test]
fn box_action_inside_next() {
    // [A]_x inside the next relation: allows stuttering explicitly.
    let r = check(
        "VARIABLE x\nInit == x = 0\nA == x' = x + 1 /\\ x < 1\nNext == [A]_x",
        "INIT Init\nNEXT Next\nCHECK_DEADLOCK FALSE",
    );
    assert_eq!(r.status, Status::Ok);
    assert_eq!(stats(&r).1, 2);
}

#[test]
fn angle_action_inside_next() {
    // <<A>>_x requires the subscript to change: pure stutter is excluded.
    let r = check(
        "VARIABLE x\nInit == x = 0\nA == x' \\in {x, x + 1} /\\ x < 1\nNext == <<A>>_x",
        "INIT Init\nNEXT Next",
    );
    // From x=0: only x'=1 (x'=0 stutters, excluded); from x=1: A's guard
    // fails -> deadlock.
    assert_eq!(r.status, Status::Deadlock);
    let v = r.violation.expect("deadlock trace");
    assert_eq!(v.trace.len(), 2);
}

#[test]
fn parameterized_action_with_primed_param() {
    // The Java LazyValue path: a param bound to a variable, primed inside.
    let r = check(
        "VARIABLE s\nOp(var) == \\E v \\in 0..2 : var' = v /\\ var' > var\n\
         Init == s = 0\nNext == Op(s)",
        "INIT Init\nNEXT Next\nCHECK_DEADLOCK FALSE",
    );
    assert_eq!(r.status, Status::Ok);
    assert_eq!(stats(&r).1, 3);
}

#[test]
fn spec_decomposition() {
    let r = check(
        "VARIABLE x\nInit == x = 0\nNext == x' = (x + 1) % 3\n\
         Spec == Init /\\ [][Next]_x",
        "SPECIFICATION Spec\nCHECK_DEADLOCK FALSE",
    );
    assert_eq!(r.status, Status::Ok);
    assert_eq!(stats(&r).1, 3);
}

#[test]
fn invariant_violation_with_trace() {
    let r = check(
        "VARIABLE x\nInit == x = 0\nNext == x' = x + 1\nInv == x < 3",
        "INIT Init\nNEXT Next\nINVARIANT Inv\nCHECK_DEADLOCK FALSE",
    );
    assert_eq!(r.status, Status::InvariantViolation);
    let v = r.violation.expect("violation");
    assert_eq!(v.name, "Inv");
    // Trace 0 -> 1 -> 2 -> 3: four states, shortest by BFS.
    assert_eq!(v.trace.len(), 4);
    assert_eq!(v.trace[0].pretty, "/\\ x = 0\n");
    assert_eq!(v.trace[3].pretty, "/\\ x = 3\n");
}

#[test]
fn constraint_gates_exploration_but_not_invariants() {
    // Java ordering: a successor outside the CONSTRAINT is still
    // invariant-checked but never explored.
    let r = check(
        "VARIABLE x\nInit == x = 0\nNext == x' = x + 1\nC == x < 2\nInv == x /= 1",
        "INIT Init\nNEXT Next\nCONSTRAINT C\nINVARIANT Inv\nCHECK_DEADLOCK FALSE",
    );
    assert_eq!(r.status, Status::InvariantViolation);
    let r = check(
        "VARIABLE x\nInit == x = 0\nNext == x' = x + 1\nC == x < 2\nInv == x /= 5",
        "INIT Init\nNEXT Next\nCONSTRAINT C\nINVARIANT Inv\nCHECK_DEADLOCK FALSE",
    );
    // x=2 is generated (and checked) but not explored, so x never reaches 5;
    // states outside the constraint are not fingerprinted (Java isInModel
    // gates the FPSet).
    assert_eq!(r.status, Status::Ok);
    assert_eq!(stats(&r).1, 2); // 0 and 1 in the fp set
}

#[test]
fn deadlock_detection_and_self_loop() {
    let r = check(
        "VARIABLE x\nInit == x = 0\nNext == x' = x + 1 /\\ x < 2",
        "INIT Init\nNEXT Next",
    );
    assert_eq!(r.status, Status::Deadlock);
    let v = r.violation.expect("trace");
    assert_eq!(v.trace.len(), 3); // 0 -> 1 -> 2 deadlocked

    // A self-loop is a successor: no deadlock.
    let r = check(
        "VARIABLE x\nInit == x = 0\nNext == x' = x",
        "INIT Init\nNEXT Next",
    );
    assert_eq!(r.status, Status::Ok);
}

#[test]
fn implied_action_property() {
    // Monotonicity property [][x' >= x]_x violated by a decreasing step.
    let r = check(
        "VARIABLE x\nInit == x = 0\nNext == \\/ x' = x + 1 /\\ x < 2\n        \\/ x' = 0 /\\ x = 2\n\
         Mono == [][x' >= x]_x",
        "INIT Init\nNEXT Next\nPROPERTY Mono\nCHECK_DEADLOCK FALSE",
    );
    assert_eq!(r.status, Status::InvariantViolation);
    let v = r.violation.expect("violation");
    assert_eq!(v.kind, "action_property");
    // 0 -> 1 -> 2 -> 0: the violating transition ends the trace.
    assert_eq!(v.trace.len(), 4);
}

#[test]
fn implied_action_allows_stuttering_subscript() {
    // [][A]_v holds when the subscript is unchanged even if A is false.
    let r = check(
        "VARIABLES x, y\nInit == x = 0 /\\ y = 0\n\
         Next == \\/ x' = x + 1 /\\ x < 2 /\\ UNCHANGED y\n        \\/ y' = y + 1 /\\ y < 1 /\\ UNCHANGED x\n\
         P == [][y' = y + 1]_y",
        "INIT Init\nNEXT Next\nPROPERTY P\nCHECK_DEADLOCK FALSE",
    );
    // Transitions that change only x leave y unchanged: property holds.
    assert_eq!(r.status, Status::Ok);
}

#[test]
fn state_property_checked_on_init_only() {
    // A state-level PROPERTY behaves like an implied init.
    let r = check(
        "VARIABLE x\nInit == x = 1\nNext == x' = x + 1 /\\ x < 4\nP == x = 1",
        "INIT Init\nNEXT Next\nPROPERTY P\nCHECK_DEADLOCK FALSE",
    );
    // Only initial states must satisfy it.
    assert_eq!(r.status, Status::Ok);
}

#[test]
fn budget_max_states_stops() {
    let src = "---- MODULE T ----\nEXTENDS Naturals\nVARIABLE x\nInit == x = 0\nNext == x' = x + 1\n====\n";
    let budget = CheckBudget { max_states: Some(500), ..CheckBudget::default() };
    let r = run_check_with_resolver(
        "T",
        src,
        "INIT Init\nNEXT Next\nCHECK_DEADLOCK FALSE",
        &MapResolver { modules: &[] },
        None,
        &budget,
    );
    assert_eq!(r.status, Status::ResourceLimit);
    let d = r.diagnostic.expect("diagnostic");
    assert!(d.states_generated >= 500);
    assert!(!d.level_growth.is_empty());
}

#[test]
fn model_values_and_constants() {
    let r = check(
        "CONSTANTS Users, NoUser\nVARIABLE holder\n\
         Init == holder = NoUser\n\
         Next == (holder = NoUser /\\ (\\E u \\in Users : holder' = u)) \\/ \
         (holder /= NoUser /\\ holder' = NoUser)",
        "INIT Init\nNEXT Next\nCONSTANT Users = {u1, u2}\nNoUser = NoUser\nCHECK_DEADLOCK FALSE",
    );
    assert_eq!(r.status, Status::Ok);
    assert_eq!(stats(&r).1, 3);
}

#[test]
fn constant_substitution() {
    let r = check(
        "CONSTANT Op(_)\nVARIABLE x\nDouble(n) == 2 * n\n\
         Init == x = 1\nNext == x' = Op(x) /\\ x < 8",
        "INIT Init\nNEXT Next\nCONSTANT Op <- Double\nCHECK_DEADLOCK FALSE",
    );
    assert_eq!(r.status, Status::Ok);
    assert_eq!(stats(&r).1, 4); // 1, 2, 4, 8
}

#[test]
fn unassigned_constant_is_config_error() {
    let r = check(
        "CONSTANT N\nVARIABLE x\nInit == x = N\nNext == x' = x",
        "INIT Init\nNEXT Next",
    );
    assert_eq!(r.status, Status::ConfigError);
    assert!(r.errors[0].message.contains("not assigned"), "{}", r.errors[0].message);
}

#[test]
fn action_level_invariant_is_config_error() {
    let r = check(
        "VARIABLE x\nInit == x = 0\nNext == x' = x\nInv == x' = x",
        "INIT Init\nNEXT Next\nINVARIANT Inv",
    );
    assert_eq!(r.status, Status::ConfigError);
    assert!(r.errors[0].message.contains("not a state predicate"), "{}", r.errors[0].message);
}

#[test]
fn liveness_property_is_unsupported() {
    let r = check(
        "VARIABLE x\nInit == x = 0\nNext == x' = x\nP == <>(x = 1)",
        "INIT Init\nNEXT Next\nPROPERTY P",
    );
    assert_eq!(r.status, Status::UnsupportedFeature);
}

#[test]
fn fairness_conjunct_in_spec_is_ignored() {
    let r = check(
        "VARIABLE x\nInit == x = 0\nNext == x' = (x + 1) % 2\n\
         Spec == Init /\\ [][Next]_x /\\ WF_x(Next)",
        "SPECIFICATION Spec\nCHECK_DEADLOCK FALSE",
    );
    assert_eq!(r.status, Status::Ok);
    assert_eq!(stats(&r).1, 2);
}

#[test]
fn forall_in_next() {
    let r = check(
        "VARIABLE f\nInit == f = [i \\in 1..2 |-> 0]\n\
         Next == \\E i \\in 1..2 : /\\ f[i] < 1\n                         /\\ f' = [f EXCEPT ![i] = @ + 1]",
        "INIT Init\nNEXT Next\nCHECK_DEADLOCK FALSE",
    );
    assert_eq!(r.status, Status::Ok);
    assert_eq!(stats(&r).1, 4); // f over {0,1}^2
}
