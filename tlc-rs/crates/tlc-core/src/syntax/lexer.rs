//! Hand-written lexer for TLA+.
//!
//! Grounded in the token definitions of SANY's `javacc/tla+.jj` (commit
//! 30cc36013). Key behaviors carried over:
//! - Columns are 1-based Unicode codepoint counts (junction alignment).
//! - `---- MODULE` folds into one token; bare `----` (4+) is a separator;
//!   `====` (4+) ends a module.
//! - `]_` and `>>_` are single tokens (subscript brackets of `[A]_v`).
//! - `\o17`-style number literals beat the `\o` operator (maximal munch).
//! - A word starting `WF_`/`SF_` splits: fairness token + rest re-lexed.
//! - Operator synonyms normalize to one canonical spelling at lex time.
//! - `(*` comments nest; `\*` runs to end of line.

use crate::diag::Diag;
use crate::intern::Interner;
use crate::loc::{FileId, Pos, Span};
use crate::syntax::token::{Kw, Tok, Token};

pub struct Lexer<'a> {
    chars: Vec<char>,
    i: usize,
    line: u32,
    col: u32,
    file: FileId,
    interner: &'a mut Interner,
}

pub struct LexOutput {
    pub tokens: Vec<Token>,
    pub diags: Vec<Diag>,
}

impl<'a> Lexer<'a> {
    pub fn new(src: &str, file: FileId, interner: &'a mut Interner) -> Self {
        Lexer { chars: src.chars().collect(), i: 0, line: 1, col: 1, file, interner }
    }

    pub fn lex(src: &str, file: FileId, interner: &mut Interner) -> LexOutput {
        let mut lx = Lexer::new(src, file, interner);
        let mut tokens = Vec::new();
        let mut diags = Vec::new();
        // Module-nesting depth: text after the outermost module's closing
        // `====` is ignored, as SANY's DEFAULT lex mode ignores everything
        // outside `---- MODULE ... ====`.
        let mut depth: u32 = 0;
        let mut seen_module = false;
        loop {
            match lx.next_token() {
                Ok(t) => {
                    match t.tok {
                        Tok::ModuleBegin => {
                            depth += 1;
                            seen_module = true;
                        }
                        Tok::ModuleEnd => depth = depth.saturating_sub(1),
                        _ => {}
                    }
                    let closed = seen_module && depth == 0 && t.tok == Tok::ModuleEnd;
                    let eof = t.tok == Tok::Eof;
                    tokens.push(t);
                    if closed {
                        tokens.push(Token { tok: Tok::Eof, span: lx.point_span() });
                        break;
                    }
                    if eof {
                        break;
                    }
                }
                Err(d) => {
                    diags.push(d);
                    // Skip one char and try to continue, so multiple lexical
                    // errors surface in a single pass.
                    if lx.i < lx.chars.len() {
                        lx.bump();
                    } else {
                        tokens.push(Token { tok: Tok::Eof, span: lx.point_span() });
                        break;
                    }
                }
            }
        }
        LexOutput { tokens, diags }
    }

    // -- cursor helpers -----------------------------------------------------

    fn peek(&self) -> Option<char> {
        self.chars.get(self.i).copied()
    }

    fn peek_at(&self, n: usize) -> Option<char> {
        self.chars.get(self.i + n).copied()
    }

    fn bump(&mut self) -> char {
        let c = self.chars[self.i];
        self.i += 1;
        if c == '\n' {
            self.line += 1;
            self.col = 1;
        } else if c == '\r' {
            // \r\n counts once, at the \n; lone \r is a newline.
            if self.peek() != Some('\n') {
                self.line += 1;
                self.col = 1;
            }
        } else {
            self.col += 1;
        }
        c
    }

    /// True if the upcoming chars equal `s` (ASCII only).
    fn looking_at(&self, s: &str) -> bool {
        s.chars().enumerate().all(|(n, c)| self.peek_at(n) == Some(c))
    }

    fn eat_str(&mut self, s: &str) {
        for _ in s.chars() {
            self.bump();
        }
    }

    fn pos(&self) -> Pos {
        Pos { line: self.line, col: self.col }
    }

    fn point_span(&self) -> Span {
        Span::point(self.file, self.pos())
    }

    fn tok_from(&self, start: Pos, tok: Tok) -> Token {
        // end is exclusive-ish: last consumed char's position + 1 == current col
        let end = Pos { line: self.line, col: self.col };
        Token { tok, span: Span { file: self.file, start, end } }
    }

    // -- whitespace & comments ---------------------------------------------

    fn skip_trivia(&mut self) -> Result<(), Diag> {
        loop {
            match self.peek() {
                Some(c) if c == ' ' || c == '\t' || c == '\n' || c == '\r' => {
                    self.bump();
                }
                Some('(') if self.peek_at(1) == Some('*') => {
                    let start = self.pos();
                    self.bump();
                    self.bump();
                    let mut depth = 1usize;
                    loop {
                        if self.looking_at("(*") {
                            self.bump();
                            self.bump();
                            depth += 1;
                        } else if self.looking_at("*)") {
                            self.bump();
                            self.bump();
                            depth -= 1;
                            if depth == 0 {
                                break;
                            }
                        } else if self.peek().is_some() {
                            self.bump();
                        } else {
                            return Err(Diag::syntax(
                                "P0002",
                                "unterminated block comment",
                                Span { file: self.file, start, end: self.pos() },
                            ));
                        }
                    }
                }
                Some('\\') if self.peek_at(1) == Some('*') => {
                    while let Some(c) = self.peek() {
                        if c == '\n' || c == '\r' {
                            break;
                        }
                        self.bump();
                    }
                }
                _ => return Ok(()),
            }
        }
    }

    // -- main dispatch ------------------------------------------------------

    pub fn next_token(&mut self) -> Result<Token, Diag> {
        self.skip_trivia()?;
        let start = self.pos();
        let Some(c) = self.peek() else {
            return Ok(Token { tok: Tok::Eof, span: self.point_span() });
        };

        // Number-set glyphs lex as identifiers named by the glyph itself,
        // exactly as SANY folds NUMBER_SET into IDENTIFIER.
        if c == 'ℕ' || c == 'ℤ' || c == 'ℝ' {
            self.bump();
            let sym = self.interner.intern(&c.to_string());
            return Ok(self.tok_from(start, Tok::Ident(sym)));
        }

        // Single-codepoint unicode operators & symbols.
        if let Some(tok) = unicode_tok(c) {
            self.bump();
            // ⟩_ and ⟩ distinction.
            if tok == Tok::RAngleAngle && self.peek() == Some('_') {
                self.bump();
                return Ok(self.tok_from(start, Tok::RAngleAngleUnder));
            }
            return Ok(self.tok_from(start, tok));
        }

        match c {
            '-' => self.lex_dash(start),
            '=' => self.lex_equals(start),
            '<' => self.lex_langle(start),
            '>' => {
                if self.looking_at(">>_") {
                    self.eat_str(">>_");
                    Ok(self.tok_from(start, Tok::RAngleAngleUnder))
                } else if self.looking_at(">>") {
                    self.eat_str(">>");
                    Ok(self.tok_from(start, Tok::RAngleAngle))
                } else if self.looking_at(">=") {
                    self.eat_str(">=");
                    Ok(self.tok_from(start, Tok::Op("\\geq")))
                } else {
                    self.bump();
                    Ok(self.tok_from(start, Tok::Op(">")))
                }
            }
            '\\' => self.lex_backslash(start),
            '/' => {
                for (s, canon) in [("//", "//"), ("/\\", "\\land"), ("/=", "/="), ("/", "/")] {
                    if self.looking_at(s) {
                        self.eat_str(s);
                        return Ok(self.tok_from(start, Tok::Op(canon)));
                    }
                }
                unreachable!()
            }
            '(' => {
                for (s, canon) in [
                    ("(+)", "\\oplus"),
                    ("(-)", "\\ominus"),
                    ("(.)", "\\odot"),
                    ("(/)", "\\oslash"),
                    ("(\\X)", "\\otimes"),
                ] {
                    if self.looking_at(s) {
                        self.eat_str(s);
                        return Ok(self.tok_from(start, Tok::Op(canon)));
                    }
                }
                self.bump();
                Ok(self.tok_from(start, Tok::LParen))
            }
            ')' => {
                self.bump();
                Ok(self.tok_from(start, Tok::RParen))
            }
            '[' => {
                if self.looking_at("[]") {
                    self.eat_str("[]");
                    Ok(self.tok_from(start, Tok::Op("[]")))
                } else {
                    self.bump();
                    Ok(self.tok_from(start, Tok::LBracket))
                }
            }
            ']' => {
                if self.looking_at("]_") {
                    self.eat_str("]_");
                    Ok(self.tok_from(start, Tok::RBracketUnder))
                } else {
                    self.bump();
                    Ok(self.tok_from(start, Tok::RBracket))
                }
            }
            '{' => {
                self.bump();
                Ok(self.tok_from(start, Tok::LBrace))
            }
            '}' => {
                self.bump();
                Ok(self.tok_from(start, Tok::RBrace))
            }
            ',' => {
                self.bump();
                Ok(self.tok_from(start, Tok::Comma))
            }
            ':' => {
                if self.looking_at("::=") {
                    self.eat_str("::=");
                    Ok(self.tok_from(start, Tok::Op("::=")))
                } else if self.looking_at("::") {
                    self.eat_str("::");
                    Ok(self.tok_from(start, Tok::ColonColon))
                } else if self.looking_at(":>") {
                    self.eat_str(":>");
                    Ok(self.tok_from(start, Tok::Op(":>")))
                } else if self.looking_at(":=") {
                    self.eat_str(":=");
                    Ok(self.tok_from(start, Tok::Op(":=")))
                } else {
                    self.bump();
                    Ok(self.tok_from(start, Tok::Colon))
                }
            }
            '.' => {
                if self.looking_at("...") {
                    self.eat_str("...");
                    Ok(self.tok_from(start, Tok::Op("...")))
                } else if self.looking_at("..") {
                    self.eat_str("..");
                    Ok(self.tok_from(start, Tok::Op("..")))
                } else {
                    self.bump();
                    Ok(self.tok_from(start, Tok::Dot))
                }
            }
            '|' => {
                for (s, tok) in [
                    ("|->", Tok::MapsTo),
                    ("||", Tok::Op("||")),
                    ("|-", Tok::Op("|-")),
                    ("|=", Tok::Op("|=")),
                    ("|", Tok::Op("|")),
                ] {
                    if self.looking_at(s) {
                        self.eat_str(s);
                        return Ok(self.tok_from(start, tok));
                    }
                }
                unreachable!()
            }
            '^' => {
                for (s, canon) in [("^+", "^+"), ("^*", "^*"), ("^#", "^#"), ("^^", "^^"), ("^", "^")] {
                    if self.looking_at(s) {
                        self.eat_str(s);
                        return Ok(self.tok_from(start, Tok::Op(canon)));
                    }
                }
                unreachable!()
            }
            '~' => {
                if self.looking_at("~>") {
                    self.eat_str("~>");
                    Ok(self.tok_from(start, Tok::Op("~>")))
                } else {
                    self.bump();
                    Ok(self.tok_from(start, Tok::Op("\\lnot")))
                }
            }
            '\'' => {
                self.bump();
                Ok(self.tok_from(start, Tok::Prime))
            }
            '!' => {
                if self.looking_at("!!") {
                    self.eat_str("!!");
                    Ok(self.tok_from(start, Tok::Op("!!")))
                } else {
                    self.bump();
                    Ok(self.tok_from(start, Tok::Bang))
                }
            }
            '#' => {
                if self.looking_at("##") {
                    self.eat_str("##");
                    Ok(self.tok_from(start, Tok::Op("##")))
                } else {
                    self.bump();
                    Ok(self.tok_from(start, Tok::Op("/=")))
                }
            }
            '*' => {
                if self.looking_at("**") {
                    self.eat_str("**");
                    Ok(self.tok_from(start, Tok::Op("**")))
                } else {
                    self.bump();
                    Ok(self.tok_from(start, Tok::Op("*")))
                }
            }
            '+' => {
                if self.looking_at("++") {
                    self.eat_str("++");
                    Ok(self.tok_from(start, Tok::Op("++")))
                } else {
                    self.bump();
                    Ok(self.tok_from(start, Tok::Op("+")))
                }
            }
            '&' => {
                if self.looking_at("&&") {
                    self.eat_str("&&");
                    Ok(self.tok_from(start, Tok::Op("&&")))
                } else {
                    self.bump();
                    Ok(self.tok_from(start, Tok::Op("&")))
                }
            }
            '$' => {
                if self.looking_at("$$") {
                    self.eat_str("$$");
                    Ok(self.tok_from(start, Tok::Op("$$")))
                } else {
                    self.bump();
                    Ok(self.tok_from(start, Tok::Op("$")))
                }
            }
            '%' => {
                if self.looking_at("%%") {
                    self.eat_str("%%");
                    Ok(self.tok_from(start, Tok::Op("%%")))
                } else {
                    self.bump();
                    Ok(self.tok_from(start, Tok::Op("%")))
                }
            }
            '?' => {
                if self.looking_at("??") {
                    self.eat_str("??");
                    Ok(self.tok_from(start, Tok::Op("??")))
                } else {
                    Err(Diag::syntax("P0003", "unexpected character `?`", self.point_span()))
                }
            }
            '@' => {
                if self.looking_at("@@") {
                    self.eat_str("@@");
                    Ok(self.tok_from(start, Tok::Op("@@")))
                } else {
                    self.bump();
                    let sym = self.interner.intern("@");
                    Ok(self.tok_from(start, Tok::Ident(sym)))
                }
            }
            '"' => self.lex_string(start),
            c if c.is_ascii_alphanumeric() || c == '_' => self.lex_word(start),
            other => Err(Diag::syntax(
                "P0004",
                format!("unexpected character `{other}`"),
                self.point_span(),
            )),
        }
    }

    // -- compound lexers ----------------------------------------------------

    fn lex_dash(&mut self, start: Pos) -> Result<Token, Diag> {
        // 4+ dashes: module separator; `---- MODULE` folds to ModuleBegin.
        let mut n = 0;
        while self.peek_at(n) == Some('-') {
            n += 1;
        }
        if n >= 4 {
            for _ in 0..n {
                self.bump();
            }
            // Optional spaces then MODULE → ModuleBegin (same-line only).
            let mut k = 0;
            while self.peek_at(k) == Some(' ') {
                k += 1;
            }
            let is_module = "MODULE".chars().enumerate().all(|(j, c)| self.peek_at(k + j) == Some(c));
            if is_module {
                for _ in 0..k + 6 {
                    self.bump();
                }
                return Ok(self.tok_from(start, Tok::ModuleBegin));
            }
            return Ok(self.tok_from(start, Tok::Separator));
        }
        for (s, tok) in [
            ("-+->", Tok::Op("-+->")),
            ("->", Tok::Arrow),
            ("--", Tok::Op("--")),
            ("-|", Tok::Op("-|")),
            ("-.", Tok::Op("-.")),
            ("-", Tok::Op("-")),
        ] {
            if self.looking_at(s) {
                self.eat_str(s);
                return Ok(self.tok_from(start, tok));
            }
        }
        unreachable!()
    }

    fn lex_equals(&mut self, start: Pos) -> Result<Token, Diag> {
        let mut n = 0;
        while self.peek_at(n) == Some('=') {
            n += 1;
        }
        if n >= 4 {
            for _ in 0..n {
                self.bump();
            }
            return Ok(self.tok_from(start, Tok::ModuleEnd));
        }
        for (s, tok) in [
            ("==", Tok::DefEq),
            ("=>", Tok::Op("=>")),
            ("=<", Tok::Op("\\leq")),
            ("=|", Tok::Op("=|")),
            ("=", Tok::Op("=")),
        ] {
            if self.looking_at(s) {
                self.eat_str(s);
                return Ok(self.tok_from(start, tok));
            }
        }
        unreachable!()
    }

    fn lex_langle(&mut self, start: Pos) -> Result<Token, Diag> {
        for (s, tok) in [
            ("<=>", Tok::Op("\\equiv")),
            ("<=", Tok::Op("\\leq")),
            ("<<", Tok::LAngleAngle),
            ("<:", Tok::Op("<:")),
            ("<-", Tok::LeftArrow),
            ("<>", Tok::Op("<>")),
        ] {
            if self.looking_at(s) {
                self.eat_str(s);
                return Ok(self.tok_from(start, tok));
            }
        }
        // Proof step lexeme: "<" (digits | "+" | "*") ">" trailer
        let mut n = 1;
        let mut saw_level = false;
        match self.peek_at(n) {
            Some('+') | Some('*') => {
                n += 1;
                saw_level = true;
            }
            Some(d) if d.is_ascii_digit() => {
                while self.peek_at(n).is_some_and(|c| c.is_ascii_digit()) {
                    n += 1;
                }
                saw_level = true;
            }
            _ => {}
        }
        if saw_level && self.peek_at(n) == Some('>') {
            n += 1;
            while self
                .peek_at(n)
                .is_some_and(|c| c.is_ascii_alphanumeric() || c == '*' || c == '-' || c == '.')
            {
                n += 1;
            }
            for _ in 0..n {
                self.bump();
            }
            return Ok(self.tok_from(start, Tok::StepLexeme));
        }
        self.bump();
        Ok(self.tok_from(start, Tok::Op("<")))
    }

    fn lex_backslash(&mut self, start: Pos) -> Result<Token, Diag> {
        debug_assert_eq!(self.peek(), Some('\\'));
        match self.peek_at(1) {
            Some('/') => {
                self.eat_str("\\/");
                return Ok(self.tok_from(start, Tok::Op("\\lor")));
            }
            Some(c) if c.is_ascii_alphabetic() => {}
            _ => {
                self.bump();
                return Ok(self.tok_from(start, Tok::Op("\\")));
            }
        }
        // Collect the alphanumeric word following the backslash.
        let mut n = 1;
        while self.peek_at(n).is_some_and(|c| c.is_ascii_alphanumeric()) {
            n += 1;
        }
        let word: String = (1..n).map(|k| self.peek_at(k).unwrap()).collect();

        // Number literals \b01, \o17, \hFF (maximal munch beats \o operator).
        let is_num = matches!(word.as_bytes().first(), Some(b'b') | Some(b'B'))
            && word[1..].bytes().all(|b| b == b'0' || b == b'1')
            && word.len() > 1
            || matches!(word.as_bytes().first(), Some(b'o') | Some(b'O'))
                && word[1..].bytes().all(|b| (b'0'..=b'7').contains(&b))
                && word.len() > 1
            || matches!(word.as_bytes().first(), Some(b'h') | Some(b'H'))
                && word[1..].bytes().all(|b| b.is_ascii_hexdigit())
                && word.len() > 1;
        if is_num {
            let raw: String = std::iter::once('\\').chain(word.chars()).collect();
            for _ in 0..n {
                self.bump();
            }
            let sym = self.interner.intern(&raw);
            return Ok(self.tok_from(start, Tok::Number(sym)));
        }

        let tok = match word.as_str() {
            "E" | "exists" => Some(Tok::Exists),
            "A" | "forall" => Some(Tok::Forall),
            "EE" => Some(Tok::TExists),
            "AA" => Some(Tok::TForall),
            "in" => Some(Tok::Op("\\in")),
            "notin" => Some(Tok::Op("\\notin")),
            "land" => Some(Tok::Op("\\land")),
            "lor" => Some(Tok::Op("\\lor")),
            "lnot" | "neg" => Some(Tok::Op("\\lnot")),
            "leq" => Some(Tok::Op("\\leq")),
            "geq" => Some(Tok::Op("\\geq")),
            "equiv" => Some(Tok::Op("\\equiv")),
            "intersect" | "cap" => Some(Tok::Op("\\intersect")),
            "union" | "cup" => Some(Tok::Op("\\union")),
            "circ" => Some(Tok::Op("\\o")),
            "times" | "X" => Some(Tok::Op("\\times")),
            w => BACKSLASH_OPS.iter().find(|&&op| op == w).map(|_| ()).map(|_| {
                // Canonical spelling is the backslash form itself.
                Tok::Op(backslash_static(w))
            }),
        };
        match tok {
            Some(t) => {
                for _ in 0..n {
                    self.bump();
                }
                Ok(self.tok_from(start, t))
            }
            None => Err(Diag::syntax(
                "P0005",
                format!("unknown operator `\\{word}`"),
                Span { file: self.file, start, end: self.pos() },
            )),
        }
    }

    fn lex_string(&mut self, start: Pos) -> Result<Token, Diag> {
        self.bump(); // opening quote
        let mut out = String::new();
        loop {
            match self.peek() {
                None | Some('\n') | Some('\r') => {
                    return Err(Diag::syntax(
                        "P0006",
                        "unterminated string literal",
                        Span { file: self.file, start, end: self.pos() },
                    ));
                }
                Some('"') => {
                    self.bump();
                    let sym = self.interner.intern(&out);
                    return Ok(self.tok_from(start, Tok::Str(sym)));
                }
                Some('\\') => {
                    self.bump();
                    match self.peek() {
                        Some('n') => out.push('\n'),
                        Some('t') => out.push('\t'),
                        Some('r') => out.push('\r'),
                        Some('f') => out.push('\u{0c}'),
                        Some('\\') => out.push('\\'),
                        Some('"') => out.push('"'),
                        other => {
                            return Err(Diag::syntax(
                                "P0007",
                                format!(
                                    "invalid string escape `\\{}`",
                                    other.map(String::from).unwrap_or_default()
                                ),
                                self.point_span(),
                            ));
                        }
                    }
                    self.bump();
                }
                Some(c) => {
                    out.push(c);
                    self.bump();
                }
            }
        }
    }

    fn lex_word(&mut self, start: Pos) -> Result<Token, Diag> {
        let mut n = 0;
        while self.peek_at(n).is_some_and(|c| c.is_ascii_alphanumeric() || c == '_') {
            n += 1;
        }
        let word: String = (0..n).map(|k| self.peek_at(k).unwrap()).collect();

        // WF_/SF_ split: `WF_vars` lexes as WF_ token + `vars` identifier.
        if word.starts_with("WF_") || word.starts_with("SF_") {
            let fair = if word.starts_with("WF_") { Tok::WeakFair } else { Tok::StrongFair };
            self.bump();
            self.bump();
            self.bump();
            return Ok(self.tok_from(start, fair));
        }

        if word.bytes().all(|b| b.is_ascii_digit()) {
            for _ in 0..n {
                self.bump();
            }
            // Real literal `123.456` — but not `1..2` (range) or `1.` alone.
            let mut full = word;
            if self.peek() == Some('.') && self.peek_at(1).is_some_and(|c| c.is_ascii_digit()) {
                self.bump();
                full.push('.');
                while self.peek().is_some_and(|c| c.is_ascii_digit()) {
                    full.push(self.bump());
                }
            }
            let sym = self.interner.intern(&full);
            return Ok(self.tok_from(start, Tok::Number(sym)));
        }

        if word.bytes().any(|b| b.is_ascii_alphabetic()) {
            for _ in 0..n {
                self.bump();
            }
            // These five words are operator tokens in SANY, not keywords.
            if let Some(op) = ["SUBSET", "UNION", "DOMAIN", "ENABLED", "UNCHANGED"]
                .iter()
                .find(|&&w| w == word)
            {
                return Ok(self.tok_from(start, Tok::Op(op)));
            }
            if let Some(kw) = Kw::from_word(&word) {
                return Ok(self.tok_from(start, Tok::Kw(kw)));
            }
            let sym = self.interner.intern(&word);
            return Ok(self.tok_from(start, Tok::Ident(sym)));
        }

        // Only digits and underscores, starting with `_` or mixing them:
        // emit the leading run as its own token and re-lex the rest.
        if word.starts_with('_') {
            self.bump();
            Ok(self.tok_from(start, Tok::Underscore))
        } else {
            let mut d = 0;
            while self.peek_at(d).is_some_and(|c| c.is_ascii_digit()) {
                d += 1;
            }
            let digits: String = (0..d).map(|k| self.peek_at(k).unwrap()).collect();
            for _ in 0..d {
                self.bump();
            }
            let sym = self.interner.intern(&digits);
            Ok(self.tok_from(start, Tok::Number(sym)))
        }
    }
}

/// Backslash operators whose canonical spelling is the backslash form itself.
const BACKSLASH_OPS: &[&str] = &[
    "approx", "asymp", "bigcirc", "bullet", "cdot", "cong", "div", "doteq",
    "gg", "ll", "o", "odot", "ominus", "oplus", "oslash", "otimes", "prec", "preceq",
    "propto", "sim", "simeq", "sqcap", "sqcup", "sqsubset", "sqsubseteq", "sqsupset",
    "sqsupseteq", "star", "subset", "subseteq", "succ", "succeq", "supset", "supseteq",
    "uplus", "wr",
];

/// Map a matched backslash-op word to its canonical `&'static str` spelling.
fn backslash_static(w: &str) -> &'static str {
    match w {
        "approx" => "\\approx",
        "asymp" => "\\asymp",
        "bigcirc" => "\\bigcirc",
        "bullet" => "\\bullet",
        "cdot" => "\\cdot",
        "cong" => "\\cong",
        "div" => "\\div",
        "doteq" => "\\doteq",
        "gg" => "\\gg",
        "ll" => "\\ll",
        "o" => "\\o",
        "odot" => "\\odot",
        "ominus" => "\\ominus",
        "oplus" => "\\oplus",
        "oslash" => "\\oslash",
        "otimes" => "\\otimes",
        "prec" => "\\prec",
        "preceq" => "\\preceq",
        "propto" => "\\propto",
        "sim" => "\\sim",
        "simeq" => "\\simeq",
        "sqcap" => "\\sqcap",
        "sqcup" => "\\sqcup",
        "sqsubset" => "\\sqsubset",
        "sqsubseteq" => "\\sqsubseteq",
        "sqsupset" => "\\sqsupset",
        "sqsupseteq" => "\\sqsupseteq",
        "star" => "\\star",
        "subset" => "\\subset",
        "subseteq" => "\\subseteq",
        "succ" => "\\succ",
        "succeq" => "\\succeq",
        "supset" => "\\supset",
        "supseteq" => "\\supseteq",
        "uplus" => "\\uplus",
        "wr" => "\\wr",
        _ => unreachable!("not a backslash op: {w}"),
    }
}

/// Single-codepoint Unicode tokens (canonicalized to ASCII spellings).
fn unicode_tok(c: char) -> Option<Tok> {
    Some(match c {
        '∧' => Tok::Op("\\land"),
        '∨' => Tok::Op("\\lor"),
        '¬' => Tok::Op("\\lnot"),
        '∈' => Tok::Op("\\in"),
        '∉' => Tok::Op("\\notin"),
        '≠' => Tok::Op("/="),
        '≜' => Tok::DefEq,
        '≤' => Tok::Op("\\leq"),
        '≥' => Tok::Op("\\geq"),
        '⊂' => Tok::Op("\\subset"),
        '⊆' => Tok::Op("\\subseteq"),
        '⊃' => Tok::Op("\\supset"),
        '⊇' => Tok::Op("\\supseteq"),
        '∩' => Tok::Op("\\intersect"),
        '∪' => Tok::Op("\\union"),
        '÷' => Tok::Op("\\div"),
        '⇒' => Tok::Op("=>"),
        '⇔' => Tok::Op("\\equiv"),
        '≡' => Tok::Op("\\equiv"),
        '↝' => Tok::Op("~>"),
        '→' => Tok::Arrow,
        '←' => Tok::LeftArrow,
        '↦' => Tok::MapsTo,
        '□' => Tok::Op("[]"),
        '◇' => Tok::Op("<>"),
        '∃' => Tok::Exists,
        '∀' => Tok::Forall,
        '⟨' => Tok::LAngleAngle,
        '⟩' => Tok::RAngleAngle, // caller upgrades to ⟩_ when followed by _
        '∷' => Tok::ColonColon,
        '×' => Tok::Op("\\times"),
        '⁺' => Tok::Op("^+"),
        '≈' => Tok::Op("\\approx"),
        '≔' => Tok::Op(":="),
        '≍' => Tok::Op("\\asymp"),
        '◯' => Tok::Op("\\bigcirc"),
        '⩴' => Tok::Op("::="),
        '●' => Tok::Op("\\bullet"),
        '⋅' => Tok::Op("\\cdot"),
        '∘' => Tok::Op("\\o"),
        '≅' => Tok::Op("\\cong"),
        '≐' => Tok::Op("\\doteq"),
        '‥' => Tok::Op(".."),
        '…' => Tok::Op("..."),
        '‼' => Tok::Op("!!"),
        '≫' => Tok::Op("\\gg"),
        '≪' => Tok::Op("\\ll"),
        '⫤' => Tok::Op("=|"),
        '⊣' => Tok::Op("-|"),
        '⊨' => Tok::Op("|="),
        '⊢' => Tok::Op("|-"),
        '⊙' => Tok::Op("\\odot"),
        '⊖' => Tok::Op("\\ominus"),
        '⊕' => Tok::Op("\\oplus"),
        '⊘' => Tok::Op("\\oslash"),
        '⊗' => Tok::Op("\\otimes"),
        '⇸' => Tok::Op("-+->"),
        '≺' => Tok::Op("\\prec"),
        '⪯' => Tok::Op("\\preceq"),
        '∝' => Tok::Op("\\propto"),
        '⁇' => Tok::Op("??"),
        '∼' => Tok::Op("\\sim"),
        '≃' => Tok::Op("\\simeq"),
        '⊓' => Tok::Op("\\sqcap"),
        '⊔' => Tok::Op("\\sqcup"),
        '⊏' => Tok::Op("\\sqsubset"),
        '⊑' => Tok::Op("\\sqsubseteq"),
        '⊐' => Tok::Op("\\sqsupset"),
        '⊒' => Tok::Op("\\sqsupseteq"),
        '⋆' => Tok::Op("\\star"),
        '≻' => Tok::Op("\\succ"),
        '⪰' => Tok::Op("\\succeq"),
        '⊎' => Tok::Op("\\uplus"),
        '‖' => Tok::Op("||"),
        '≀' => Tok::Op("\\wr"),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lex_kinds(src: &str) -> Vec<Tok> {
        let mut interner = Interner::new();
        let out = Lexer::lex(src, FileId(0), &mut interner);
        assert!(out.diags.is_empty(), "unexpected diags: {:?}", out.diags);
        out.tokens.into_iter().map(|t| t.tok).collect()
    }

    #[test]
    fn module_frame() {
        let toks = lex_kinds("---- MODULE M ----\n====");
        assert!(matches!(toks[0], Tok::ModuleBegin));
        assert!(matches!(toks[1], Tok::Ident(_)));
        assert!(matches!(toks[2], Tok::Separator));
        assert!(matches!(toks[3], Tok::ModuleEnd));
        assert!(matches!(toks[4], Tok::Eof));
    }

    #[test]
    fn junction_bullets_and_ops() {
        let toks = lex_kinds("/\\ x = 1 \\/ y # 2");
        assert_eq!(toks[0], Tok::Op("\\land")); // /\ canonicalizes to \land
        assert_eq!(toks[2], Tok::Op("="));
        assert_eq!(toks[4], Tok::Op("\\lor")); // \/ canonicalizes to \lor
        assert_eq!(toks[6], Tok::Op("/=")); // # canonicalizes to /=
    }

    #[test]
    fn unicode_canonicalization() {
        let mut interner = Interner::new();
        let a = Lexer::lex("x ∧ y ≤ z ≜ TRUE", FileId(0), &mut interner);
        let b = Lexer::lex("x /\\ y =< z == TRUE", FileId(0), &mut interner);
        let ka: Vec<_> = a.tokens.iter().map(|t| t.tok).collect();
        let kb: Vec<_> = b.tokens.iter().map(|t| t.tok).collect();
        assert_eq!(ka, kb);
    }

    #[test]
    fn unicode_columns_count_codepoints() {
        let mut interner = Interner::new();
        let out = Lexer::lex("∧ x", FileId(0), &mut interner);
        // `x` sits at column 3 (∧=1, space=2), not byte offset 5.
        assert_eq!(out.tokens[1].span.start.col, 3);
    }

    #[test]
    fn subscript_brackets() {
        let toks = lex_kinds("[Next]_vars <<A>>_v");
        assert_eq!(toks[0], Tok::LBracket);
        assert_eq!(toks[2], Tok::RBracketUnder);
        assert_eq!(toks[4], Tok::LAngleAngle);
        assert_eq!(toks[6], Tok::RAngleAngleUnder);
    }

    #[test]
    fn fairness_split() {
        let toks = lex_kinds("WF_vars(Next)");
        assert_eq!(toks[0], Tok::WeakFair);
        assert!(matches!(toks[1], Tok::Ident(_)));
    }

    #[test]
    fn backslash_number_vs_op() {
        let toks = lex_kinds("s \\o t \\o17 \\b101 \\hFF");
        assert_eq!(toks[1], Tok::Op("\\o"));
        assert!(matches!(toks[3], Tok::Number(_)));
        assert!(matches!(toks[4], Tok::Number(_)));
        assert!(matches!(toks[5], Tok::Number(_)));
    }

    #[test]
    fn nested_comments() {
        let toks = lex_kinds("x (* outer (* inner *) still *) y \\* eol\nz");
        assert!(matches!(toks[0], Tok::Ident(_)));
        assert!(matches!(toks[1], Tok::Ident(_)));
        assert!(matches!(toks[2], Tok::Ident(_)));
        assert!(matches!(toks[3], Tok::Eof));
    }

    #[test]
    fn strings_with_escapes() {
        let mut interner = Interner::new();
        let out = Lexer::lex(r#""hello\nworld""#, FileId(0), &mut interner);
        assert!(out.diags.is_empty());
        match out.tokens[0].tok {
            Tok::Str(s) => assert_eq!(interner.str(s), "hello\nworld"),
            other => panic!("expected string, got {other:?}"),
        }
    }

    #[test]
    fn step_lexeme() {
        let toks = lex_kinds("<1>a x <*> y");
        assert_eq!(toks[0], Tok::StepLexeme);
        assert!(matches!(toks[1], Tok::Ident(_)));
        assert_eq!(toks[2], Tok::StepLexeme);
    }

    #[test]
    fn keywords_vs_idents() {
        let toks = lex_kinds("VARIABLE x EXTENDS Naturals CHOOSE TRUE");
        assert_eq!(toks[0], Tok::Kw(Kw::Variable));
        assert_eq!(toks[2], Tok::Kw(Kw::Extends));
        assert_eq!(toks[4], Tok::Kw(Kw::Choose));
        assert!(matches!(toks[5], Tok::Ident(_))); // TRUE is a builtin ident
    }
}
