//! Token definitions.
//!
//! Operator tokens carry a *canonical* spelling: every synonym (`∧`, `\land`
//! → `/\`; `=<`, `≤`, `\leq` → `<=`; …) is normalized at lex time, mirroring
//! SANY's `Operators.resolveSynonym`.

use crate::intern::Sym;
use crate::loc::Span;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kw {
    Action,
    Assume,
    Assumption, // ASSUMPTION | AXIOM
    By,
    Case,
    Choose,
    Constant, // CONSTANT | CONSTANTS
    Define,
    Defs, // DEF | DEFS (proof syntax)
    Else,
    Except,
    Extends,
    Have,
    Hide,
    If,
    Instance,
    LetIn, // IN
    Lambda,
    Let,
    Local,
    Module,
    New,
    Obvious,
    Omitted,
    Only,
    Other,
    Pick,
    Proof,
    Proposition, // PROPOSITION | LEMMA | COROLLARY
    Prove,
    Qed,
    Recursive,
    State,
    Suffices,
    Take,
    Temporal,
    Then,
    Theorem,
    Use,
    Variable, // VARIABLE | VARIABLES
    Witness,
    With,
}

impl Kw {
    pub fn from_word(w: &str) -> Option<Kw> {
        Some(match w {
            "ACTION" | "ACTIONS" => Kw::Action,
            "ASSUME" => Kw::Assume,
            "ASSUMPTION" | "AXIOM" => Kw::Assumption,
            "BY" => Kw::By,
            "CASE" => Kw::Case,
            "CHOOSE" => Kw::Choose,
            "CONSTANT" | "CONSTANTS" => Kw::Constant,
            "DEFINE" => Kw::Define,
            "DEF" | "DEFS" => Kw::Defs,
            "ELSE" => Kw::Else,
            "EXCEPT" => Kw::Except,
            "EXTENDS" => Kw::Extends,
            "HAVE" => Kw::Have,
            "HIDE" => Kw::Hide,
            "IF" => Kw::If,
            "INSTANCE" => Kw::Instance,
            "IN" => Kw::LetIn,
            "LAMBDA" => Kw::Lambda,
            "LET" => Kw::Let,
            "LOCAL" => Kw::Local,
            "MODULE" => Kw::Module,
            "NEW" => Kw::New,
            "OBVIOUS" => Kw::Obvious,
            "OMITTED" => Kw::Omitted,
            "ONLY" => Kw::Only,
            "OTHER" => Kw::Other,
            "PICK" => Kw::Pick,
            "PROOF" => Kw::Proof,
            "PROPOSITION" | "LEMMA" | "COROLLARY" => Kw::Proposition,
            "PROVE" => Kw::Prove,
            "QED" => Kw::Qed,
            "RECURSIVE" => Kw::Recursive,
            "STATE" => Kw::State,
            "SUFFICES" => Kw::Suffices,
            "TAKE" => Kw::Take,
            "TEMPORAL" | "TEMPORALS" => Kw::Temporal,
            "THEN" => Kw::Then,
            "THEOREM" => Kw::Theorem,
            "USE" => Kw::Use,
            "VARIABLE" | "VARIABLES" => Kw::Variable,
            "WITNESS" => Kw::Witness,
            "WITH" => Kw::With,
            _ => return None,
        })
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Tok {
    /// `---- MODULE` (dashes + MODULE folded into one token, as in SANY).
    ModuleBegin,
    /// `----` row of 4+ dashes not followed by MODULE.
    Separator,
    /// `====` row of 4+ equals.
    ModuleEnd,

    Ident(Sym),
    Number(Sym),
    Str(Sym),
    Kw(Kw),

    /// Operator symbol, canonical spelling (see `super::lexer::canon`).
    /// Fixity/precedence resolution happens in the parser.
    Op(&'static str),

    /// `/\` or `\/` — same canonical spellings as `Op`, but the parser
    /// decides junction-bullet vs infix from column context. The lexer emits
    /// `Op` for these; this variant is not produced (kept out on purpose).

    // Punctuation & structure
    Comma,
    Colon,
    ColonColon,
    Dot,
    Underscore, // _
    DefEq,      // == or ≜
    LParen,
    RParen,
    LBracket,          // [
    RBracket,          // ]
    RBracketUnder,     // ]_
    LBrace,            // {
    RBrace,            // }
    LAngleAngle,       // << or ⟨
    RAngleAngle,       // >> or ⟩
    RAngleAngleUnder,  // >>_ or ⟩_
    Bang,              // !
    Arrow,             // -> or →
    LeftArrow,         // <- or ←
    MapsTo,            // |-> or ↦
    Prime,             // '
    Exists,            // \E, \exists, ∃
    Forall,            // \A, \forall, ∀
    TExists,           // \EE
    TForall,           // \AA
    WeakFair,          // WF_
    StrongFair,        // SF_
    /// Proof step lexeme like `<1>a` / `<*>` — recognized so proof syntax can
    /// be rejected with a clean "unsupported" diagnostic.
    StepLexeme,

    Eof,
}

#[derive(Clone, Copy, Debug)]
pub struct Token {
    pub tok: Tok,
    pub span: Span,
}

impl Token {
    /// Start column (1-based, codepoints) — the input to junction-list logic.
    pub fn col(&self) -> u32 {
        self.span.start.col
    }
}
