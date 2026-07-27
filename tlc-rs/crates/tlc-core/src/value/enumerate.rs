//! Enumeration of set values, the analog of `ValueEnumeration` in
//! `tlc2/value/impl` (`SetEnumValue.Enumerator`, `IntervalValue.Enumerator`).
//!
//! Lazy-set enumerators (`SUBSET S`, `[S -> T]`, ...) arrive with the
//! evaluator milestone.

use std::rc::Rc;

use super::Value;

/// A resettable enumerator over a set's elements in normalized order
/// (`ValueEnumeration.nextElement`/`reset`).
pub trait ValEnum {
    fn next(&mut self) -> Option<Value>;
    fn reset(&mut self);
}

/// Enumerates a normalized `SetEnum`'s elements in order.
pub struct SetEnumIter {
    elems: Rc<Vec<Value>>,
    index: usize,
}

impl SetEnumIter {
    pub fn new(elems: Rc<Vec<Value>>) -> Self {
        SetEnumIter { elems, index: 0 }
    }
}

impl ValEnum for SetEnumIter {
    fn next(&mut self) -> Option<Value> {
        let v = self.elems.get(self.index).cloned();
        if v.is_some() {
            self.index += 1;
        }
        v
    }

    fn reset(&mut self) {
        self.index = 0;
    }
}

/// Enumerates `lo..hi` in ascending order (empty when `lo > hi`).
pub struct IntervalIter {
    lo: i64,
    hi: i64,
    next: i64,
    done: bool,
}

impl IntervalIter {
    pub fn new(lo: i64, hi: i64) -> Self {
        IntervalIter { lo, hi, next: lo, done: lo > hi }
    }
}

impl ValEnum for IntervalIter {
    fn next(&mut self) -> Option<Value> {
        if self.done {
            return None;
        }
        let v = self.next;
        if v == self.hi {
            self.done = true;
        } else {
            self.next += 1;
        }
        Some(Value::Int(v))
    }

    fn reset(&mut self) {
        self.next = self.lo;
        self.done = self.lo > self.hi;
    }
}

impl Value {
    /// An enumerator over this value's elements, if it is an enumerable set.
    pub fn enumerator(&self) -> Option<Box<dyn ValEnum>> {
        match self {
            Value::SetEnum(elems) => Some(Box::new(SetEnumIter::new(elems.clone()))),
            Value::Interval { lo, hi } => Some(Box::new(IntervalIter::new(*lo, *hi))),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::intern::Interner;
    use crate::value::fp::Fp64Table;
    use crate::value::ValueCtx;

    #[test]
    fn set_enum_iteration_and_reset() {
        let int = Interner::new();
        let fp = Fp64Table::new();
        let ctx = ValueCtx { interner: &int, fp: &fp };
        let set =
            Value::set_enum(vec![Value::Int(3), Value::Int(1), Value::Int(2)], &ctx).unwrap();
        let mut e = set.enumerator().unwrap();
        let mut seen = Vec::new();
        while let Some(v) = e.next() {
            seen.push(v.display(&ctx));
        }
        assert_eq!(seen, ["1", "2", "3"]);
        e.reset();
        assert_eq!(e.next().unwrap().display(&ctx), "1");
    }

    #[test]
    fn interval_iteration_bounds() {
        let int = Interner::new();
        let fp = Fp64Table::new();
        let ctx = ValueCtx { interner: &int, fp: &fp };
        let mut e = IntervalIter::new(-1, 1);
        let mut seen = Vec::new();
        while let Some(v) = e.next() {
            seen.push(v.display(&ctx));
        }
        assert_eq!(seen, ["-1", "0", "1"]);
        assert!(e.next().is_none());
        e.reset();
        assert_eq!(e.next().unwrap().display(&ctx), "-1");

        // Empty interval yields nothing.
        let mut empty = IntervalIter::new(2, 1);
        assert!(empty.next().is_none());

        // Endpoint at i64::MAX must not overflow.
        let mut edge = IntervalIter::new(i64::MAX - 1, i64::MAX);
        assert!(edge.next().is_some());
        assert!(edge.next().is_some());
        assert!(edge.next().is_none());
    }
}
