//! Source locations and spans.
//!
//! Columns count Unicode codepoints, not bytes: junction-list alignment in
//! TLA+ is column-based and a `∧` bullet is 3 UTF-8 bytes wide but one column.
//! Lines and columns are 1-based, matching SANY's reported locations.

use serde::Serialize;
use std::fmt;

/// Identifies a parsed source file (module file or .cfg) within a session.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, Serialize)]
pub struct FileId(pub u32);

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
pub struct Pos {
    pub line: u32,
    /// 1-based codepoint column.
    pub col: u32,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
pub struct Span {
    pub file: FileId,
    pub start: Pos,
    pub end: Pos,
}

impl Span {
    pub fn point(file: FileId, pos: Pos) -> Self {
        Span { file, start: pos, end: pos }
    }

    pub fn merge(self, other: Span) -> Span {
        debug_assert_eq!(self.file, other.file);
        let start = if (self.start.line, self.start.col) <= (other.start.line, other.start.col) {
            self.start
        } else {
            other.start
        };
        let end = if (self.end.line, self.end.col) >= (other.end.line, other.end.col) {
            self.end
        } else {
            other.end
        };
        Span { file: self.file, start, end }
    }
}

impl fmt::Display for Pos {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}:{}", self.line, self.col)
    }
}
