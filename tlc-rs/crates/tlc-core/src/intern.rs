//! String interning, the analog of tlatools' `util.UniqueString`.
//!
//! Owned per-`Spec` (no globals) so wasm instances and parallel native runs
//! never share mutable state.

use hashbrown::HashMap;
use std::cell::RefCell;
use std::fmt;

/// An interned string. Cheap to copy/compare; resolve via [`Interner::str`].
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Sym(u32);

impl Sym {
    pub fn index(self) -> usize {
        self.0 as usize
    }
}

impl fmt::Debug for Sym {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Sym({})", self.0)
    }
}

/// Append-only: interned strings are boxed (stable heap addresses), so
/// `str` can hand out `&str` borrows of `&self` while `intern_ref` keeps
/// admitting new strings behind a `RefCell` (needed by runtime string
/// producers like `\o` on strings, where only `&Interner` is in scope).
#[derive(Default)]
pub struct Interner {
    inner: RefCell<Inner>,
}

#[derive(Default)]
struct Inner {
    map: HashMap<Box<str>, Sym>,
    strings: Vec<Box<str>>,
}

impl Interner {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn intern(&mut self, s: &str) -> Sym {
        self.intern_ref(s)
    }

    /// Intern through a shared reference (see the type-level comment).
    pub fn intern_ref(&self, s: &str) -> Sym {
        let mut inner = self.inner.borrow_mut();
        if let Some(&sym) = inner.map.get(s) {
            return sym;
        }
        let sym = Sym(u32::try_from(inner.strings.len()).expect("interner overflow"));
        let boxed: Box<str> = s.into();
        inner.strings.push(boxed.clone());
        inner.map.insert(boxed, sym);
        sym
    }

    pub fn get(&self, s: &str) -> Option<Sym> {
        self.inner.borrow().map.get(s).copied()
    }

    pub fn str(&self, sym: Sym) -> &str {
        let inner = self.inner.borrow();
        let boxed: &str = &inner.strings[sym.index()];
        // SAFETY: the boxed string's heap allocation is stable (the vec is
        // append-only and boxes are never dropped while `self` lives), so
        // extending the borrow to `&self`'s lifetime is sound.
        unsafe { &*(boxed as *const str) }
    }

    pub fn len(&self) -> usize {
        self.inner.borrow().strings.len()
    }

    pub fn is_empty(&self) -> bool {
        self.inner.borrow().strings.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn intern_roundtrip() {
        let mut i = Interner::new();
        let a = i.intern("TypeOK");
        let b = i.intern("Init");
        let a2 = i.intern("TypeOK");
        assert_eq!(a, a2);
        assert_ne!(a, b);
        assert_eq!(i.str(a), "TypeOK");
        assert_eq!(i.str(b), "Init");
    }
}
