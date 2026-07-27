//! tlc-core: TLA+ parser, level checker, and finite-state safety model
//! checker — a ground-up reimplementation of the safety subset of SANY + TLC.
//!
//! Design rules:
//! - No filesystem access: modules are resolved through [`ModuleResolver`].
//! - No clocks or threads: the checker polls an injected deadline callback.
//! - No panics for user errors: everything user-visible is `Result<_, Diag>`.
//! - Builds cleanly for `wasm32-unknown-unknown`.

pub mod api;
pub mod cfg;
pub mod check;
pub mod diag;
pub mod eval;
pub mod intern;
pub mod loc;
pub mod sem;
pub mod stdlib;
pub mod syntax;
pub mod value;

use std::borrow::Cow;

/// Supplies TLA+ module source text by module name. The CLI implements this
/// over the filesystem; the wasm entry point implements it over the request's
/// in-memory module map. Standard modules are consulted automatically before
/// this resolver.
pub trait ModuleResolver {
    fn resolve(&self, name: &str) -> Option<Cow<'_, str>>;
}

/// Resolver over a fixed in-memory set of (name, source) pairs.
pub struct MapResolver<'a> {
    pub modules: &'a [(String, String)],
}

impl ModuleResolver for MapResolver<'_> {
    fn resolve(&self, name: &str) -> Option<Cow<'_, str>> {
        self.modules
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, s)| Cow::Borrowed(s.as_str()))
    }
}
