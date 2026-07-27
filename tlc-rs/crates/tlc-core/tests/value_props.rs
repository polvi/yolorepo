//! Hand-rolled property tests for the value system: eq ⇒ fingerprint-eq
//! across representations, normalization idempotence, comparison error
//! semantics, and deterministic ordering.

use std::cmp::Ordering;

use tlc_core::intern::Interner;
use tlc_core::value::fp::Fp64Table;
use tlc_core::value::{Value, ValueCtx};

/// Deterministic LCG for shuffling (no external dependencies).
struct Lcg(u64);

impl Lcg {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        self.0 >> 33
    }
}

fn shuffle<T>(items: &mut [T], rng: &mut Lcg) {
    for i in (1..items.len()).rev() {
        let j = (rng.next() % (i as u64 + 1)) as usize;
        items.swap(i, j);
    }
}

/// Asserts the pair is equal under `tla_eq`, fingerprint-equal, and
/// `Ordering::Equal` under `tla_cmp` in both directions.
fn assert_all_equal(a: &Value, b: &Value, ctx: &ValueCtx) {
    assert!(a.tla_eq(b, ctx).unwrap(), "{} != {}", a.display(ctx), b.display(ctx));
    assert!(b.tla_eq(a, ctx).unwrap());
    assert_eq!(a.tla_cmp(b, ctx).unwrap(), Ordering::Equal);
    assert_eq!(
        a.fingerprint(ctx).unwrap(),
        b.fingerprint(ctx).unwrap(),
        "fingerprints differ: {} vs {}",
        a.display(ctx),
        b.display(ctx)
    );
}

#[test]
fn eq_implies_fp_eq_across_representations() {
    let mut int = Interner::new();
    let (a, b) = (int.intern("a"), int.intern("b"));
    let fp = Fp64Table::new();
    let ctx = ValueCtx { interner: &int, fp: &fp };

    // <<1, 2>> == [i \in 1..2 |-> i] (as an explicit FcnRcd).
    let tup = Value::tuple(vec![Value::Int(1), Value::Int(2)]);
    let fcn = Value::fcn_rcd(
        vec![Value::Int(1), Value::Int(2)],
        vec![Value::Int(1), Value::Int(2)],
        &ctx,
    )
    .unwrap();
    assert_all_equal(&tup, &fcn, &ctx);

    // Construction order must not matter for the normalized function.
    let fcn_rev = Value::fcn_rcd(
        vec![Value::Int(2), Value::Int(1)],
        vec![Value::Int(2), Value::Int(1)],
        &ctx,
    )
    .unwrap();
    assert_all_equal(&tup, &fcn_rev, &ctx);

    // Record == function with string domain, regardless of field order.
    let rcd = Value::record(vec![(b, Value::Int(2)), (a, Value::Int(1))], &ctx).unwrap();
    let fcn_s = Value::fcn_rcd(
        vec![Value::Str(a), Value::Str(b)],
        vec![Value::Int(1), Value::Int(2)],
        &ctx,
    )
    .unwrap();
    assert_all_equal(&rcd, &fcn_s, &ctx);

    // Interval == SetEnum with the same elements.
    let iv = Value::interval(-1, 3);
    let se = Value::set_enum(
        (-1..=3).map(Value::Int).collect(),
        &ctx,
    )
    .unwrap();
    assert_all_equal(&iv, &se, &ctx);

    // Empty forms: <<>> == empty function; {} == empty interval.
    let empty_tup = Value::tuple(vec![]);
    let empty_fcn = Value::fcn_rcd(vec![], vec![], &ctx).unwrap();
    let empty_rcd = Value::record(vec![], &ctx).unwrap();
    assert_all_equal(&empty_tup, &empty_fcn, &ctx);
    assert_all_equal(&empty_tup, &empty_rcd, &ctx);
    let empty_set = Value::set_enum(vec![], &ctx).unwrap();
    assert_all_equal(&Value::interval(1, 0), &empty_set, &ctx);

    // Nested: a set of tuples equals the same set built from equivalent
    // function-record representations.
    let s1 = Value::set_enum(
        vec![
            Value::tuple(vec![Value::Int(1), Value::Int(2)]),
            Value::tuple(vec![Value::Int(3), Value::Int(4)]),
        ],
        &ctx,
    )
    .unwrap();
    let s2 = Value::set_enum(
        vec![
            Value::fcn_rcd(
                vec![Value::Int(2), Value::Int(1)],
                vec![Value::Int(4), Value::Int(3)],
                &ctx,
            )
            .unwrap(),
            Value::fcn_rcd(
                vec![Value::Int(1), Value::Int(2)],
                vec![Value::Int(1), Value::Int(2)],
                &ctx,
            )
            .unwrap(),
        ],
        &ctx,
    )
    .unwrap();
    assert_all_equal(&s1, &s2, &ctx);

    // Nested records inside sets, mixed with the fcn representation.
    let s3 = Value::set_enum(
        vec![Value::record(vec![(a, Value::interval(1, 2))], &ctx).unwrap()],
        &ctx,
    )
    .unwrap();
    let s4 = Value::set_enum(
        vec![Value::fcn_rcd(
            vec![Value::Str(a)],
            vec![Value::set_enum(vec![Value::Int(2), Value::Int(1)], &ctx).unwrap()],
            &ctx,
        )
        .unwrap()],
        &ctx,
    )
    .unwrap();
    assert_all_equal(&s3, &s4, &ctx);
}

#[test]
fn set_dedup_across_representations() {
    let int = Interner::new();
    let fp = Fp64Table::new();
    let ctx = ValueCtx { interner: &int, fp: &fp };

    // {<<1, 2>>, [i \in 1..2 |-> i]} has cardinality 1.
    let set = Value::set_enum(
        vec![
            Value::tuple(vec![Value::Int(1), Value::Int(2)]),
            Value::fcn_rcd(
                vec![Value::Int(1), Value::Int(2)],
                vec![Value::Int(1), Value::Int(2)],
                &ctx,
            )
            .unwrap(),
        ],
        &ctx,
    )
    .unwrap();
    match &set {
        Value::SetEnum(elems) => assert_eq!(elems.len(), 1),
        other => panic!("expected SetEnum, got {}", other.display(&ctx)),
    }

    // {1..2, {1, 2}, {2, 1}} has cardinality 1.
    let set2 = Value::set_enum(
        vec![
            Value::interval(1, 2),
            Value::set_enum(vec![Value::Int(1), Value::Int(2)], &ctx).unwrap(),
            Value::set_enum(vec![Value::Int(2), Value::Int(1)], &ctx).unwrap(),
        ],
        &ctx,
    )
    .unwrap();
    match &set2 {
        Value::SetEnum(elems) => assert_eq!(elems.len(), 1),
        other => panic!("expected SetEnum, got {}", other.display(&ctx)),
    }
}

#[test]
fn normalize_idempotence() {
    let int = Interner::new();
    let fp = Fp64Table::new();
    let ctx = ValueCtx { interner: &int, fp: &fp };

    let once = Value::set_enum(
        vec![Value::Int(3), Value::Int(1), Value::Int(2), Value::Int(1)],
        &ctx,
    )
    .unwrap();
    let elems = match &once {
        Value::SetEnum(e) => e.as_ref().clone(),
        _ => unreachable!(),
    };
    let twice = Value::set_enum(elems, &ctx).unwrap();
    assert_all_equal(&once, &twice, &ctx);
    match (&once, &twice) {
        (Value::SetEnum(a), Value::SetEnum(b)) => {
            assert_eq!(a.len(), 3);
            assert_eq!(a.len(), b.len());
            for (x, y) in a.iter().zip(b.iter()) {
                assert_eq!(x.tla_cmp(y, &ctx).unwrap(), Ordering::Equal);
            }
        }
        _ => unreachable!(),
    }
}

#[test]
fn cmp_error_cases() {
    let mut int = Interner::new();
    let a = Value::Str(int.intern("a"));
    let fp = Fp64Table::new();
    let ctx = ValueCtx { interner: &int, fp: &fp };

    // Int vs Str / Bool / Set / Tuple: user errors, both directions.
    let one = Value::Int(1);
    let set = Value::set_enum(vec![Value::Int(1)], &ctx).unwrap();
    let tup = Value::tuple(vec![Value::Int(1)]);
    for other in [&a, &Value::Bool(true), &set, &tup] {
        assert!(one.tla_cmp(other, &ctx).is_err(), "1 vs {}", other.display(&ctx));
        assert!(other.tla_cmp(&one, &ctx).is_err(), "{} vs 1", other.display(&ctx));
    }
    let err = one.tla_cmp(&a, &ctx).unwrap_err();
    assert!(err.message.contains("compare integer"), "message: {}", err.message);

    // Sets don't compare with functions.
    assert!(set.tla_cmp(&tup, &ctx).is_err());
    assert!(tup.tla_cmp(&set, &ctx).is_err());

    // Interval vs non-set: same error as the equivalent SetEnum.
    assert!(Value::interval(1, 2).tla_cmp(&one, &ctx).is_err());
}

#[test]
fn model_value_rules() {
    let mut int = Interner::new();
    let m1 = Value::model("m1", &mut int);
    let m2 = Value::model("m2", &mut int);
    let ta1 = Value::model("t_a1", &mut int);
    let ta2 = Value::model("t_a2", &mut int);
    let ub1 = Value::model("u_b1", &mut int);
    let fp = Fp64Table::new();
    let ctx = ValueCtx { interner: &int, fp: &fp };

    // Untyped vs untyped: by name; unequal unless the same value.
    assert_eq!(m1.tla_cmp(&m2, &ctx).unwrap(), Ordering::Less);
    assert!(m1.tla_eq(&m1, &ctx).unwrap());
    assert!(!m1.tla_eq(&m2, &ctx).unwrap());

    // Untyped compares with anything: below all non-model values.
    for v in [Value::Int(0), Value::Bool(false), Value::tuple(vec![])] {
        assert_eq!(m1.tla_cmp(&v, &ctx).unwrap(), Ordering::Less);
        assert_eq!(v.tla_cmp(&m1, &ctx).unwrap(), Ordering::Greater);
        assert!(!m1.tla_eq(&v, &ctx).unwrap());
    }

    // Typed vs same-typed and typed vs untyped: fine, by name.
    assert_eq!(ta1.tla_cmp(&ta2, &ctx).unwrap(), Ordering::Less);
    assert!(ta1.tla_eq(&ta1, &ctx).unwrap());
    assert!(ta1.tla_cmp(&m1, &ctx).is_ok());
    assert!(m1.tla_cmp(&ta1, &ctx).is_ok());

    // Typed vs differently-typed: error.
    assert!(ta1.tla_cmp(&ub1, &ctx).is_err());
    assert!(ub1.tla_cmp(&ta1, &ctx).is_err());

    // Typed vs non-model value: error, both directions.
    assert!(ta1.tla_cmp(&Value::Int(1), &ctx).is_err());
    assert!(Value::Int(1).tla_cmp(&ta1, &ctx).is_err());

    // Model values are set members without errors (untyped sorts anywhere).
    let s = Value::set_enum(vec![m1.clone(), Value::Int(1), m2.clone()], &ctx).unwrap();
    match &s {
        Value::SetEnum(e) => assert_eq!(e.len(), 3),
        _ => unreachable!(),
    }
}

/// A pool of 100 pairwise-distinct small values.
fn distinct_values(int: &mut Interner) -> Vec<Value> {
    let syms: Vec<_> = (0..10).map(|i| int.intern(&format!("s{i}"))).collect();
    let fp = Fp64Table::new();
    let mut vals = Vec::new();
    // 30 ints, 2 bools, 10 strings.
    vals.extend((0..30).map(Value::Int));
    vals.push(Value::Bool(false));
    vals.push(Value::Bool(true));
    vals.extend(syms.iter().map(|s| Value::Str(*s)));
    {
        let ctx = ValueCtx { interner: int, fp: &fp };
        // 20 sets {0..k}.
        for k in 0..20 {
            vals.push(Value::set_enum((0..=k).map(Value::Int).collect(), &ctx).unwrap());
        }
        // 20 tuples <<k>> and <<k, k>>.
        for k in 0..10 {
            vals.push(Value::tuple(vec![Value::Int(k)]));
            vals.push(Value::tuple(vec![Value::Int(k), Value::Int(k)]));
        }
        // 10 records [sK |-> K].
        for (k, s) in syms.iter().enumerate() {
            vals.push(Value::record(vec![(*s, Value::Int(k as i64))], &ctx).unwrap());
        }
        // 8 intervals starting above the {0..k} sets to stay distinct.
        for k in 0..8 {
            vals.push(Value::interval(100, 100 + k));
        }
    }
    assert_eq!(vals.len(), 100);
    vals
}

#[test]
fn fingerprints_of_distinct_values_are_distinct() {
    let mut int = Interner::new();
    let vals = distinct_values(&mut int);
    let fp = Fp64Table::new();
    let ctx = ValueCtx { interner: &int, fp: &fp };
    let mut fps = Vec::new();
    for v in &vals {
        fps.push((v.fingerprint(&ctx).unwrap(), v.display(&ctx)));
    }
    for i in 0..fps.len() {
        for j in (i + 1)..fps.len() {
            assert_ne!(fps[i].0, fps[j].0, "collision: {} vs {}", fps[i].1, fps[j].1);
        }
    }
}

#[test]
fn deterministic_ordering_of_shuffled_values() {
    let mut int = Interner::new();
    let vals = distinct_values(&mut int);
    let fp = Fp64Table::new();
    let ctx = ValueCtx { interner: &int, fp: &fp };

    // Comparable subsets (cross-kind comparison is an error, so sort within
    // kind classes): ints+bools can't mix either. Use the sets subset and
    // the tuples/records (functions) subset, plus ints alone.
    let ints: Vec<Value> = vals.iter().filter(|v| matches!(v, Value::Int(_))).cloned().collect();
    let sets: Vec<Value> = vals
        .iter()
        .filter(|v| matches!(v, Value::SetEnum(_) | Value::Interval { .. }))
        .cloned()
        .collect();

    for pool in [ints, sets] {
        let mut rng1 = Lcg(42);
        let mut rng2 = Lcg(0xdeadbeef);
        let mut shuffled1 = pool.clone();
        let mut shuffled2 = pool.clone();
        shuffle(&mut shuffled1, &mut rng1);
        shuffle(&mut shuffled2, &mut rng2);
        // Sorting goes through set_enum's normalization (sort + dedup); the
        // pools are duplicate-free so cardinality must be preserved.
        let s1 = Value::set_enum(shuffled1, &ctx).unwrap();
        let s2 = Value::set_enum(shuffled2, &ctx).unwrap();
        let (e1, e2) = match (&s1, &s2) {
            (Value::SetEnum(a), Value::SetEnum(b)) => (a, b),
            _ => unreachable!(),
        };
        assert_eq!(e1.len(), pool.len());
        assert_eq!(e1.len(), e2.len());
        for (x, y) in e1.iter().zip(e2.iter()) {
            assert_eq!(
                x.tla_cmp(y, &ctx).unwrap(),
                Ordering::Equal,
                "order differs: {} vs {}",
                x.display(&ctx),
                y.display(&ctx)
            );
        }
        // And the sorted order is strictly increasing.
        for w in e1.windows(2) {
            assert_eq!(w[0].tla_cmp(&w[1], &ctx).unwrap(), Ordering::Less);
        }
    }
}

#[test]
fn record_duplicate_field_is_error() {
    let mut int = Interner::new();
    let a = int.intern("a");
    let fp = Fp64Table::new();
    let ctx = ValueCtx { interner: &int, fp: &fp };
    let err = Value::record(vec![(a, Value::Int(1)), (a, Value::Int(2))], &ctx).unwrap_err();
    assert!(err.message.contains("occurs multiple times in record"));
}

#[test]
fn set_construction_propagates_comparison_errors() {
    let mut int = Interner::new();
    let a = Value::Str(int.intern("a"));
    let fp = Fp64Table::new();
    let ctx = ValueCtx { interner: &int, fp: &fp };
    // {1, "a"} is a comparison error during normalization.
    assert!(Value::set_enum(vec![Value::Int(1), a], &ctx).is_err());
}
