//! Operator precedence table, transcribed exactly from SANY's
//! `tla2sany/parser/Operators.java` (CanonicalOperators). Synonyms are
//! resolved by the lexer, so only canonical spellings appear here.
//!
//! TLA+ operators carry precedence *ranges* [lo, hi]. Two adjacent operators
//! resolve only if their ranges are disjoint (or they're the same
//! left-associative operator); overlap is a parse error ("incomparable
//! precedence").

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Assoc {
    None,
    Left,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Fixity {
    Prefix,
    Postfix,
    Infix,
    /// `a \X b \X c` — flattening n-ary product.
    Nfix,
}

#[derive(Clone, Copy, Debug)]
pub struct OpInfo {
    pub name: &'static str,
    pub lo: u16,
    pub hi: u16,
    pub assoc: Assoc,
    pub fixity: Fixity,
}

macro_rules! op {
    ($name:literal, $lo:literal, $hi:literal, $assoc:ident, $fix:ident) => {
        OpInfo { name: $name, lo: $lo, hi: $hi, assoc: Assoc::$assoc, fixity: Fixity::$fix }
    };
}

/// Every canonical operator, in `Operators.java` order. `[` (function
/// application) and `.` (record access) are handled structurally by the
/// parser but keep their precedences here for climbing decisions.
pub const OPERATORS: &[OpInfo] = &[
    op!("[", 160, 160, Left, Postfix),
    op!(".", 170, 170, Left, Infix),
    op!("'", 150, 150, None, Postfix),
    op!("^", 140, 140, None, Infix),
    op!("/", 130, 130, None, Infix),
    op!("*", 130, 130, Left, Infix),
    op!("-", 110, 110, Left, Infix),
    op!("-.", 120, 120, None, Prefix),
    op!("+", 100, 100, Left, Infix),
    op!("=", 50, 50, None, Infix),
    op!("\\lnot", 40, 40, Left, Prefix),
    op!("\\land", 30, 30, Left, Infix),
    op!("\\lor", 30, 30, Left, Infix),
    op!("~>", 20, 20, None, Infix),
    op!("=>", 10, 10, None, Infix),
    op!("[]", 40, 150, None, Prefix),
    op!("<>", 40, 150, None, Prefix),
    op!("ENABLED", 40, 150, None, Prefix),
    op!("UNCHANGED", 40, 150, None, Prefix),
    op!("SUBSET", 100, 130, None, Prefix),
    op!("UNION", 100, 130, None, Prefix),
    op!("DOMAIN", 100, 130, None, Prefix),
    op!("^+", 150, 150, None, Postfix),
    op!("^*", 150, 150, None, Postfix),
    op!("^#", 150, 150, None, Postfix),
    op!("\\cdot", 50, 140, Left, Infix),
    op!("\\equiv", 20, 20, None, Infix),
    op!("-+->", 20, 20, None, Infix),
    op!("/=", 50, 50, None, Infix),
    op!("\\subseteq", 50, 50, None, Infix),
    op!("\\in", 50, 50, None, Infix),
    op!("\\notin", 50, 50, None, Infix),
    op!("<", 50, 50, None, Infix),
    op!("\\leq", 50, 50, None, Infix),
    op!(">", 50, 50, None, Infix),
    op!("\\geq", 50, 50, None, Infix),
    op!("\\times", 100, 130, Left, Nfix),
    op!("\\", 80, 80, None, Infix),
    op!("\\intersect", 80, 80, Left, Infix),
    op!("\\union", 80, 80, Left, Infix),
    op!("...", 90, 90, None, Infix),
    op!("..", 90, 90, None, Infix),
    op!("|", 100, 110, Left, Infix),
    op!("||", 100, 110, Left, Infix),
    op!("&&", 130, 130, Left, Infix),
    op!("&", 130, 130, Left, Infix),
    op!("$$", 90, 130, Left, Infix),
    op!("$", 90, 130, Left, Infix),
    op!("??", 90, 130, Left, Infix),
    op!("%%", 100, 110, Left, Infix),
    op!("%", 100, 110, None, Infix),
    op!("##", 90, 130, Left, Infix),
    op!("++", 100, 100, Left, Infix),
    op!("--", 110, 110, Left, Infix),
    op!("**", 130, 130, Left, Infix),
    op!("//", 130, 130, None, Infix),
    op!("^^", 140, 140, None, Infix),
    op!("@@", 60, 60, Left, Infix),
    op!("!!", 90, 130, None, Infix),
    op!("|-", 50, 50, None, Infix),
    op!("|=", 50, 50, None, Infix),
    op!("-|", 50, 50, None, Infix),
    op!("=|", 50, 50, None, Infix),
    op!("<:", 70, 70, None, Infix),
    op!(":>", 70, 70, None, Infix),
    op!(":=", 50, 50, None, Infix),
    op!("::=", 50, 50, None, Infix),
    op!("\\oplus", 100, 100, Left, Infix),
    op!("\\ominus", 110, 110, Left, Infix),
    op!("\\odot", 130, 130, Left, Infix),
    op!("\\oslash", 130, 130, None, Infix),
    op!("\\otimes", 130, 130, Left, Infix),
    op!("\\uplus", 90, 130, Left, Infix),
    op!("\\sqcap", 90, 130, Left, Infix),
    op!("\\sqcup", 90, 130, Left, Infix),
    op!("\\div", 130, 130, None, Infix),
    op!("\\wr", 90, 140, None, Infix),
    op!("\\star", 130, 130, Left, Infix),
    op!("\\o", 130, 130, Left, Infix),
    op!("\\bigcirc", 130, 130, Left, Infix),
    op!("\\bullet", 130, 130, Left, Infix),
    op!("\\prec", 50, 50, None, Infix),
    op!("\\succ", 50, 50, None, Infix),
    op!("\\preceq", 50, 50, None, Infix),
    op!("\\succeq", 50, 50, None, Infix),
    op!("\\sim", 50, 50, None, Infix),
    op!("\\simeq", 50, 50, None, Infix),
    op!("\\ll", 50, 50, None, Infix),
    op!("\\gg", 50, 50, None, Infix),
    op!("\\asymp", 50, 50, None, Infix),
    op!("\\subset", 50, 50, None, Infix),
    op!("\\supset", 50, 50, None, Infix),
    op!("\\supseteq", 50, 50, None, Infix),
    op!("\\approx", 50, 50, None, Infix),
    op!("\\cong", 50, 50, None, Infix),
    op!("\\sqsubset", 50, 50, None, Infix),
    op!("\\sqsubseteq", 50, 50, None, Infix),
    op!("\\sqsupset", 50, 50, None, Infix),
    op!("\\sqsupseteq", 50, 50, None, Infix),
    op!("\\doteq", 50, 50, None, Infix),
    op!("\\propto", 50, 50, None, Infix),
];

pub fn lookup(name: &str) -> Option<&'static OpInfo> {
    OPERATORS.iter().find(|o| o.name == name)
}

/// Infix (or nfix) entry for a canonical spelling.
pub fn infix(name: &str) -> Option<&'static OpInfo> {
    OPERATORS
        .iter()
        .find(|o| o.name == name && matches!(o.fixity, Fixity::Infix | Fixity::Nfix))
}

/// Prefix entry. Note `-` in prefix position resolves to the `-.` entry
/// (SANY's `getMixfix`).
pub fn prefix(name: &str) -> Option<&'static OpInfo> {
    let name = if name == "-" { "-." } else { name };
    OPERATORS.iter().find(|o| o.name == name && o.fixity == Fixity::Prefix)
}

pub fn postfix(name: &str) -> Option<&'static OpInfo> {
    OPERATORS.iter().find(|o| o.name == name && o.fixity == Fixity::Postfix)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn table_sanity() {
        // Spot checks against Operators.java.
        let minus = infix("-").unwrap();
        assert_eq!((minus.lo, minus.hi), (110, 110));
        let plus = infix("+").unwrap();
        assert_eq!((plus.lo, plus.hi), (100, 100));
        // Binary minus binds tighter than plus in TLA+ (unusual but correct).
        assert!(minus.lo > plus.hi);
        let box_op = prefix("[]").unwrap();
        assert_eq!((box_op.lo, box_op.hi), (40, 150));
        let neg = prefix("-").unwrap(); // resolves via -.
        assert_eq!((neg.lo, neg.hi), (120, 120));
        let cdot = infix("\\cdot").unwrap();
        assert_eq!((cdot.lo, cdot.hi), (50, 140));
    }
}
