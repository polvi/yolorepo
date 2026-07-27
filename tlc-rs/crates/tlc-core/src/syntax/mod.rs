//! Syntax: lexer, parser, and AST for TLA+ modules.

pub mod ast;
pub mod lexer;
pub mod ops;
pub mod parser;
pub mod token;

pub use lexer::Lexer;
pub use parser::parse_source;
pub use token::{Kw, Tok, Token};
