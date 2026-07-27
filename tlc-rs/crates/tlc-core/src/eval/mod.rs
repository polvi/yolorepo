//! Expression evaluation (milestones M3–M6: the constant evaluator plus the
//! state-aware action evaluator).
//!
//! - [`context`] — persistent evaluation contexts (`tlc2/util/Context.java`).
//! - [`eval`] — the evaluator core (`Tool.eval`/`evalAppl`).
//! - [`action`] — init/next-state structural enumeration
//!   (`Tool.getInitStates`/`getNextStates`/`processUnchanged`).
//! - `natives` — native overrides for the standard modules
//!   (`tlc2/module/*.java`).

pub mod action;
pub mod context;
#[allow(clippy::module_inception)]
pub mod eval;
mod natives;

pub use action::Pred;
pub use context::{Binding, Ctx, CtxKey, OpBinding};
pub use eval::{EvalLimits, Evaluator, Override};
