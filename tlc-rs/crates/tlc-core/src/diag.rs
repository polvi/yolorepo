//! Diagnostics: every user-visible error or warning the engine can produce.
//!
//! All user errors flow through `Diag` as `Result<_, Diag>` (or are collected
//! into a `Diagnostics` sink during parsing/semantic analysis). Categories map
//! onto the service API's `status` values.

use crate::loc::Span;
use serde::Serialize;
use std::fmt;

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Category {
    Syntax,
    Semantic,
    Level,
    Config,
    Eval,
    Unsupported,
}

#[derive(Clone, Debug, Serialize)]
pub struct Diag {
    pub category: Category,
    /// Stable machine-readable code, e.g. "P0001". Prefix by category:
    /// P=syntax, S=semantic, L=level, C=config, E=eval, U=unsupported.
    pub code: &'static str,
    pub message: String,
    pub span: Option<Span>,
    /// Secondary locations (e.g. previous definition site on a redefinition).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub notes: Vec<(String, Option<Span>)>,
}

impl Diag {
    pub fn new(category: Category, code: &'static str, message: impl Into<String>) -> Self {
        Diag { category, code, message: message.into(), span: None, notes: Vec::new() }
    }

    pub fn with_span(mut self, span: Span) -> Self {
        self.span = Some(span);
        self
    }

    pub fn note(mut self, message: impl Into<String>, span: Option<Span>) -> Self {
        self.notes.push((message.into(), span));
        self
    }

    pub fn syntax(code: &'static str, message: impl Into<String>, span: Span) -> Self {
        Diag::new(Category::Syntax, code, message).with_span(span)
    }

    pub fn unsupported(code: &'static str, message: impl Into<String>, span: Span) -> Self {
        Diag::new(Category::Unsupported, code, message).with_span(span)
    }
}

impl fmt::Display for Diag {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.span {
            Some(s) => write!(
                f,
                "{:?} error [{}] at {}..{}: {}",
                self.category, self.code, s.start, s.end, self.message
            ),
            None => write!(f, "{:?} error [{}]: {}", self.category, self.code, self.message),
        }
    }
}

/// Collects multiple diagnostics during a phase that shouldn't stop at the
/// first error (parsing, semantic analysis).
#[derive(Default, Debug)]
pub struct Diagnostics {
    pub items: Vec<Diag>,
}

impl Diagnostics {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, d: Diag) {
        self.items.push(d);
    }

    pub fn has_errors(&self) -> bool {
        !self.items.is_empty()
    }
}
