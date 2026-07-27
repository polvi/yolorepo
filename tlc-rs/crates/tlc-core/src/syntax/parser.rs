//! Recursive-descent parser for TLA+ with precedence-range climbing and
//! column-aligned junction lists.
//!
//! Grounded in SANY's `javacc/tla+.jj` + `JunctionListContext.java` +
//! `Operators.java` (commit 30cc36013). The two load-bearing mechanisms:
//!
//! **Junction lists.** A `/\` or `\/` in operand position starts a bulleted
//! list anchored at its start column. While parsing an item, *every*
//! expression-extension decision (operand start, prefix/infix/postfix op,
//! `.` access, `[` application, `::` label) is gated on the next token lying
//! strictly right of the bullet column (`isAboveCurrent`). A bullet of the
//! same kind at exactly the anchor column continues the list; anything else
//! at or left of the anchor ends it. Structural delimiters (`,`, `)`, THEN,
//! …) are consumed ungated, matching the JavaCC grammar where only
//! expression-level LOOKAHEADs carry the column predicate.
//!
//! **Precedence ranges.** Each operator spans [lo, hi]. For adjacent ops L
//! then O: O binds tighter iff `O.lo > L.hi`; L resolves first iff
//! `L.lo > O.hi`; the same left-associative operator groups left; anything
//! else is a parse error ("incomparable precedence").
//!
//! Proof syntax (THEOREM proofs, ASSUME/PROVE, step lexemes, subexpression
//! `!` references) parses to a clean `Unsupported` diagnostic — out of scope
//! for the safety-subset engine.

use crate::diag::Diag;
use crate::intern::{Interner, Sym};
use crate::loc::{FileId, Span};
use crate::syntax::ast::*;
use crate::syntax::lexer::Lexer;
use crate::syntax::ops::{self, Assoc, Fixity, OpInfo};
use crate::syntax::token::{Kw, Tok, Token};

pub struct Parser<'a> {
    toks: Vec<Token>,
    pos: usize,
    arena: ExprArena,
    interner: &'a mut Interner,
    /// Stack of enclosing junction lists: (kind, anchor column).
    junction: Vec<(JunctionKind, u32)>,
}

type PResult<T> = Result<T, Diag>;

pub fn parse_source(src: &str, file: FileId, interner: &mut Interner) -> Result<SourceFile, Diag> {
    let lexed = Lexer::lex(src, file, interner);
    if let Some(d) = lexed.diags.into_iter().next() {
        return Err(d);
    }
    let mut p = Parser { toks: lexed.tokens, pos: 0, arena: ExprArena::default(), interner, junction: Vec::new() };
    // Skip any leading garbage before the module header, as SANY does
    // (everything before `---- MODULE` is ignored by the DEFAULT lex mode).
    while !matches!(p.peek(), Tok::ModuleBegin | Tok::Eof) {
        p.pos += 1;
    }
    let module = p.parse_module()?;
    Ok(SourceFile { module, arena: p.arena })
}

impl<'a> Parser<'a> {
    // ---- token access ----------------------------------------------------

    fn tok(&self) -> Token {
        self.toks[self.pos.min(self.toks.len() - 1)]
    }

    fn peek(&self) -> Tok {
        self.tok().tok
    }

    fn peek_at(&self, n: usize) -> Tok {
        self.toks[(self.pos + n).min(self.toks.len() - 1)].tok
    }

    fn span(&self) -> Span {
        self.tok().span
    }

    fn bump(&mut self) -> Token {
        let t = self.tok();
        if self.pos < self.toks.len() - 1 {
            self.pos += 1;
        }
        t
    }

    fn err(&self, code: &'static str, msg: impl Into<String>) -> Diag {
        Diag::syntax(code, msg, self.span())
    }

    fn unsupported(&self, msg: impl Into<String>) -> Diag {
        Diag::unsupported("U0001", msg, self.span())
    }

    fn expect_tok(&mut self, want: Tok, what: &str) -> PResult<Token> {
        if self.peek() == want {
            Ok(self.bump())
        } else {
            Err(self.err("P0100", format!("expected {what}, found {:?}", self.peek())))
        }
    }

    fn expect_ident(&mut self, what: &str) -> PResult<(Sym, Span)> {
        match self.peek() {
            Tok::Ident(s) => {
                let t = self.bump();
                Ok((s, t.span))
            }
            _ => Err(self.err("P0101", format!("expected {what}, found {:?}", self.peek()))),
        }
    }

    /// Junction gate (`isAboveCurrent`): may the next token extend the
    /// current expression?
    fn gate(&self) -> bool {
        match self.junction.last() {
            None => true,
            Some((_, col)) => self.tok().col() > *col,
        }
    }

    fn junction_kind_of(name: &str) -> Option<JunctionKind> {
        match name {
            "\\land" => Some(JunctionKind::Conj),
            "\\lor" => Some(JunctionKind::Disj),
            _ => None,
        }
    }

    // ---- module structure ------------------------------------------------

    fn parse_module(&mut self) -> PResult<Module> {
        let start = self.span();
        self.expect_tok(Tok::ModuleBegin, "`---- MODULE`")?;
        let (name, _) = self.expect_ident("module name")?;
        self.expect_tok(Tok::Separator, "`----` after module name")?;

        let mut extends = Vec::new();
        if self.peek() == Tok::Kw(Kw::Extends) {
            self.bump();
            loop {
                extends.push(self.expect_ident("module name in EXTENDS")?);
                if self.peek() == Tok::Comma {
                    self.bump();
                } else {
                    break;
                }
            }
        }

        let mut units = Vec::new();
        loop {
            match self.peek() {
                Tok::ModuleEnd => {
                    self.bump();
                    break;
                }
                Tok::Eof => {
                    return Err(self.err("P0102", "unexpected end of file: missing `====`"));
                }
                Tok::Separator => {
                    self.bump();
                    units.push(Unit::Separator);
                }
                _ => units.push(self.parse_unit()?),
            }
        }
        let span = start.merge(self.toks[self.pos.saturating_sub(1)].span);
        Ok(Module { name, span, extends, units })
    }

    fn parse_unit(&mut self) -> PResult<Unit> {
        match self.peek() {
            Tok::Kw(Kw::Variable) => {
                self.bump();
                let mut vars = Vec::new();
                loop {
                    vars.push(self.expect_ident("variable name")?);
                    if self.peek() == Tok::Comma {
                        self.bump();
                    } else {
                        break;
                    }
                }
                Ok(Unit::Variables(vars))
            }
            Tok::Kw(Kw::Constant) => {
                self.bump();
                Ok(Unit::Constants(self.parse_op_decls()?))
            }
            Tok::Kw(Kw::Recursive) => {
                self.bump();
                Ok(Unit::Recursive(self.parse_op_decls()?))
            }
            Tok::Kw(Kw::Local) => {
                self.bump();
                match self.parse_unit()? {
                    Unit::OpDef { def, .. } => Ok(Unit::OpDef { local: true, def }),
                    Unit::FnDef { def, .. } => Ok(Unit::FnDef { local: true, def }),
                    Unit::Instance { decl, .. } => Ok(Unit::Instance { local: true, decl }),
                    _ => Err(self.err("P0103", "LOCAL must precede a definition or INSTANCE")),
                }
            }
            Tok::Kw(Kw::Instance) => {
                let decl = self.parse_instance(None)?;
                Ok(Unit::Instance { local: false, decl })
            }
            Tok::Kw(Kw::Assume) | Tok::Kw(Kw::Assumption) => {
                self.bump();
                // ASSUME/PROVE proof construct is out of scope; plain named or
                // unnamed assumption is fine.
                let name = if matches!(self.peek(), Tok::Ident(_)) && self.peek_at(1) == Tok::DefEq
                {
                    let (s, sp) = self.expect_ident("assumption name")?;
                    self.bump(); // ==
                    Some((s, sp))
                } else {
                    None
                };
                let expr = self.parse_expr()?;
                if self.peek() == Tok::Kw(Kw::Prove) {
                    return Err(self.unsupported("ASSUME/PROVE constructs are not supported"));
                }
                Ok(Unit::Assume { name, expr })
            }
            Tok::Kw(Kw::Theorem) | Tok::Kw(Kw::Proposition) => {
                self.bump();
                let name = if matches!(self.peek(), Tok::Ident(_)) && self.peek_at(1) == Tok::DefEq
                {
                    let (s, sp) = self.expect_ident("theorem name")?;
                    self.bump();
                    Some((s, sp))
                } else {
                    None
                };
                if self.peek() == Tok::Kw(Kw::Assume) {
                    return Err(self.unsupported("ASSUME/PROVE theorems are not supported"));
                }
                let expr = self.parse_expr()?;
                if self.at_proof_start() {
                    return Err(self.unsupported("theorem proofs are not supported"));
                }
                Ok(Unit::Theorem { name, expr, had_proof: false })
            }
            Tok::ModuleBegin => Ok(Unit::Submodule(self.parse_module()?)),
            Tok::StepLexeme => Err(self.unsupported("proof steps are not supported")),
            Tok::Kw(Kw::Use) | Tok::Kw(Kw::Hide) => {
                Err(self.unsupported("USE/HIDE statements are not supported"))
            }
            _ => self.parse_definition(),
        }
    }

    fn at_proof_start(&self) -> bool {
        matches!(
            self.peek(),
            Tok::Kw(Kw::By)
                | Tok::Kw(Kw::Proof)
                | Tok::Kw(Kw::Obvious)
                | Tok::Kw(Kw::Omitted)
                | Tok::StepLexeme
        )
    }

    /// CONSTANT / RECURSIVE declaration list: `c`, `f(_, _)`, `_ \prec _`,
    /// `- _`, `_ ^+`.
    fn parse_op_decls(&mut self) -> PResult<Vec<OpDecl>> {
        let mut decls = Vec::new();
        loop {
            decls.push(self.parse_op_decl()?);
            if self.peek() == Tok::Comma {
                self.bump();
            } else {
                break;
            }
        }
        Ok(decls)
    }

    fn parse_op_decl(&mut self) -> PResult<OpDecl> {
        match self.peek() {
            Tok::Ident(name) => {
                let t = self.bump();
                if self.peek() == Tok::LParen {
                    self.bump();
                    let mut arity = 0u32;
                    loop {
                        self.expect_tok(Tok::Underscore, "`_` in operator declaration")?;
                        arity += 1;
                        if self.peek() == Tok::Comma {
                            self.bump();
                        } else {
                            break;
                        }
                    }
                    self.expect_tok(Tok::RParen, "`)`")?;
                    Ok(OpDecl { name, span: t.span, arity })
                } else {
                    Ok(OpDecl { name, span: t.span, arity: 0 })
                }
            }
            Tok::Underscore => {
                // `_ op _` (infix) or `_ op` / `_'` (postfix)
                let t = self.bump();
                match self.peek() {
                    Tok::Op(op) => {
                        self.bump();
                        let name = self.interner.intern(op);
                        if self.peek() == Tok::Underscore {
                            self.bump();
                            Ok(OpDecl { name, span: t.span, arity: 2 })
                        } else {
                            Ok(OpDecl { name, span: t.span, arity: 1 })
                        }
                    }
                    Tok::Prime => {
                        self.bump();
                        let name = self.interner.intern("'");
                        Ok(OpDecl { name, span: t.span, arity: 1 })
                    }
                    _ => Err(self.err("P0104", "expected operator symbol after `_`")),
                }
            }
            Tok::Op(op) => {
                // `op _` (prefix declaration)
                let t = self.bump();
                self.expect_tok(Tok::Underscore, "`_` after prefix operator")?;
                let name = self.interner.intern(op);
                Ok(OpDecl { name, span: t.span, arity: 1 })
            }
            _ => Err(self.err("P0105", "expected declaration name")),
        }
    }

    /// Operator definitions in all fixity forms, function definitions, and
    /// `I == INSTANCE M`.
    fn parse_definition(&mut self) -> PResult<Unit> {
        // Prefix-op definition: `-. x == e` / `~ x == e`
        if let Tok::Op(op) = self.peek() {
            if ops::prefix(op).is_some() {
                let t = self.bump();
                let opname = if op == "-" { "-." } else { op };
                let (p, psp) = self.expect_ident("parameter")?;
                self.expect_tok(Tok::DefEq, "`==`")?;
                let body = self.parse_expr()?;
                let name = self.interner.intern(opname);
                return Ok(Unit::OpDef {
                    local: false,
                    def: OpDef {
                        name,
                        span: t.span,
                        params: vec![Param { name: p, span: psp, arity: 0 }],
                        body,
                    },
                });
            }
            return Err(self.err("P0106", format!("unexpected operator `{op}` at start of unit")));
        }

        let (name, name_span) = self.expect_ident("definition name")?;

        // Infix definition: `a ++ b == e`; postfix: `a ^+ == e`.
        if let Tok::Op(op) = self.peek() {
            if ops::infix(op).is_some() && matches!(self.peek_at(1), Tok::Ident(_)) {
                self.bump();
                let (rhs, rsp) = self.expect_ident("right parameter")?;
                self.expect_tok(Tok::DefEq, "`==`")?;
                let body = self.parse_expr()?;
                let opname = self.interner.intern(op);
                return Ok(Unit::OpDef {
                    local: false,
                    def: OpDef {
                        name: opname,
                        span: name_span,
                        params: vec![
                            Param { name, span: name_span, arity: 0 },
                            Param { name: rhs, span: rsp, arity: 0 },
                        ],
                        body,
                    },
                });
            }
            if ops::postfix(op).is_some() && self.peek_at(1) == Tok::DefEq {
                self.bump();
                self.bump(); // ==
                let body = self.parse_expr()?;
                let opname = self.interner.intern(op);
                return Ok(Unit::OpDef {
                    local: false,
                    def: OpDef {
                        name: opname,
                        span: name_span,
                        params: vec![Param { name, span: name_span, arity: 0 }],
                        body,
                    },
                });
            }
        }
        if self.peek() == Tok::Prime && self.peek_at(1) == Tok::DefEq {
            // `x' == e` postfix-prime definition (rare, but grammatical).
            self.bump();
            self.bump();
            let body = self.parse_expr()?;
            let opname = self.interner.intern("'");
            return Ok(Unit::OpDef {
                local: false,
                def: OpDef {
                    name: opname,
                    span: name_span,
                    params: vec![Param { name, span: name_span, arity: 0 }],
                    body,
                },
            });
        }

        // Function definition: `f[x \in S] == e`
        if self.peek() == Tok::LBracket {
            self.bump();
            let bounds = self.parse_bounds()?;
            self.expect_tok(Tok::RBracket, "`]`")?;
            self.expect_tok(Tok::DefEq, "`==`")?;
            let body = self.parse_expr()?;
            return Ok(Unit::FnDef {
                local: false,
                def: FnDef { name, span: name_span, bounds, body },
            });
        }

        // Parameter list.
        let mut params = Vec::new();
        if self.peek() == Tok::LParen {
            self.bump();
            loop {
                params.push(self.parse_param()?);
                if self.peek() == Tok::Comma {
                    self.bump();
                } else {
                    break;
                }
            }
            self.expect_tok(Tok::RParen, "`)`")?;
        }

        self.expect_tok(Tok::DefEq, "`==`")?;

        if self.peek() == Tok::Kw(Kw::Instance) {
            let decl = self.parse_instance(Some((name, name_span, params)))?;
            return Ok(Unit::Instance { local: false, decl });
        }

        let body = self.parse_expr()?;
        Ok(Unit::OpDef { local: false, def: OpDef { name, span: name_span, params, body } })
    }

    /// Formal parameters share the declaration grammar: plain `x`,
    /// higher-order `g(_, _)`, and operator shapes `_+_`, `-._`, `_^+`.
    fn parse_param(&mut self) -> PResult<Param> {
        let d = self.parse_op_decl()?;
        Ok(Param { name: d.name, span: d.span, arity: d.arity })
    }

    fn parse_instance(&mut self, def_name: Option<(Sym, Span, Vec<Param>)>) -> PResult<InstanceDecl> {
        self.expect_tok(Tok::Kw(Kw::Instance), "`INSTANCE`")?;
        let (module, module_span) = self.expect_ident("module name after INSTANCE")?;
        let mut with = Vec::new();
        if self.peek() == Tok::Kw(Kw::With) {
            self.bump();
            loop {
                // `x <- e` or `+ <- e` (operator substitution)
                let (n, nsp) = match self.peek() {
                    Tok::Ident(s) => {
                        let t = self.bump();
                        (s, t.span)
                    }
                    Tok::Op(op) => {
                        let t = self.bump();
                        (self.interner.intern(op), t.span)
                    }
                    Tok::Prime => {
                        let t = self.bump();
                        (self.interner.intern("'"), t.span)
                    }
                    _ => return Err(self.err("P0108", "expected name in WITH substitution")),
                };
                self.expect_tok(Tok::LeftArrow, "`<-`")?;
                let e = self.parse_expr()?;
                with.push((n, nsp, e));
                if self.peek() == Tok::Comma {
                    self.bump();
                } else {
                    break;
                }
            }
        }
        Ok(InstanceDecl { def_name, module, module_span, with })
    }

    // ---- expressions -----------------------------------------------------

    pub fn parse_expr(&mut self) -> PResult<ExprId> {
        self.parse_expr_prec(None)
    }

    /// Precedence-range climbing. `left` is the operator awaiting its right
    /// operand (SANY's `lastOp`).
    fn parse_expr_prec(&mut self, left: Option<&'static OpInfo>) -> PResult<ExprId> {
        let mut lhs = self.parse_operand(left)?;
        loop {
            if !self.gate() {
                break;
            }
            match self.peek() {
                Tok::Op(name) => {
                    // A bullet continuing/ending an enclosing junction list is
                    // handled by the junction loop, not as an infix op — but
                    // only column/kind-matching bullets reach here with
                    // gate()==false, so a gated Op here is genuinely infix.
                    let Some(op) = ops::infix(name) else {
                        // Postfix operator symbols (`^+`, `^*`, `^#`).
                        if let Some(op) = ops::postfix(name) {
                            if !Self::postfix_applies(left, op) {
                                break;
                            }
                            let t = self.bump();
                            let span = self.arena.get(lhs).span.merge(t.span);
                            lhs = self.arena.alloc(ExprKind::Postfix(op.name, lhs), span);
                            continue;
                        }
                        // Prefix-only op in infix position (e.g. `[]`): ends
                        // the expression (CASE arm separators rely on this).
                        break;
                    };
                    match Self::resolve(left, op, name) {
                        Resolution::TakeRight => {
                            let opt = self.bump();
                            if op.fixity == Fixity::Nfix {
                                // `a \X b \X c` — collect the whole chain.
                                let mut items = vec![lhs, self.parse_expr_prec(Some(op))?];
                                while self.gate() && self.peek() == Tok::Op(name) {
                                    self.bump();
                                    items.push(self.parse_expr_prec(Some(op))?);
                                }
                                let span = self.arena.get(items[0]).span.merge(
                                    self.arena.get(*items.last().unwrap()).span,
                                );
                                lhs = self.arena.alloc(ExprKind::Times(items), span);
                            } else {
                                let rhs = self.parse_expr_prec(Some(op))?;
                                let span =
                                    self.arena.get(lhs).span.merge(self.arena.get(rhs).span);
                                let _ = opt;
                                lhs = self.arena.alloc(ExprKind::Infix(op.name, lhs, rhs), span);
                            }
                        }
                        Resolution::LeftFirst => break,
                        Resolution::Conflict => {
                            return Err(self.err(
                                "P0110",
                                format!(
                                    "operators `{}` and `{}` have incomparable precedence; use parentheses",
                                    left.map(|l| l.name).unwrap_or("?"),
                                    name
                                ),
                            ));
                        }
                    }
                }
                Tok::Prime => {
                    let op = ops::postfix("'").unwrap();
                    if !Self::postfix_applies(left, op) {
                        break;
                    }
                    let t = self.bump();
                    let span = self.arena.get(lhs).span.merge(t.span);
                    lhs = self.arena.alloc(ExprKind::Postfix("'", lhs), span);
                }
                Tok::Dot => {
                    let op = ops::infix(".").unwrap();
                    if !Self::postfix_applies(left, op) {
                        break;
                    }
                    self.bump();
                    // Record field names may collide with keywords; accept
                    // both (SANY converts field-name tokens to IDENTIFIER).
                    let (field, fsp) = self.parse_field_name()?;
                    let span = self.arena.get(lhs).span.merge(fsp);
                    lhs = self.arena.alloc(ExprKind::RecordField(lhs, field, fsp), span);
                }
                Tok::LBracket => {
                    let op = ops::postfix("[").unwrap();
                    if !Self::postfix_applies(left, op) {
                        break;
                    }
                    self.bump();
                    let mut args = vec![self.parse_expr()?];
                    while self.peek() == Tok::Comma {
                        self.bump();
                        args.push(self.parse_expr()?);
                    }
                    let close = self.expect_tok(Tok::RBracket, "`]` after function arguments")?;
                    let span = self.arena.get(lhs).span.merge(close.span);
                    lhs = self.arena.alloc(ExprKind::FnApply { f: lhs, args }, span);
                }
                _ => break,
            }
        }
        Ok(lhs)
    }

    fn resolve(left: Option<&'static OpInfo>, op: &'static OpInfo, name: &str) -> Resolution {
        let Some(l) = left else { return Resolution::TakeRight };
        if op.lo > l.hi {
            return Resolution::TakeRight;
        }
        if l.lo > op.hi {
            return Resolution::LeftFirst;
        }
        if l.name == name {
            return match l.assoc {
                Assoc::Left => Resolution::LeftFirst,
                Assoc::None => Resolution::Conflict,
            };
        }
        Resolution::Conflict
    }

    /// Postfix-ish op (', ^+, `[`, `.`) applies iff it binds tighter than the
    /// pending left operator.
    fn postfix_applies(left: Option<&'static OpInfo>, op: &'static OpInfo) -> bool {
        match left {
            None => true,
            Some(l) => op.lo > l.hi,
        }
    }

    fn parse_field_name(&mut self) -> PResult<(Sym, Span)> {
        match self.peek() {
            Tok::Ident(s) => {
                let t = self.bump();
                Ok((s, t.span))
            }
            Tok::Kw(_) => {
                // Reconstruct the keyword's source text as a field name is
                // rare; reject with a targeted message for now.
                Err(self.err("P0111", "keyword used as record field name is not supported"))
            }
            _ => Err(self.err("P0112", "expected record field name after `.`")),
        }
    }

    // ---- operands --------------------------------------------------------

    fn parse_operand(&mut self, left: Option<&'static OpInfo>) -> PResult<ExprId> {
        if !self.gate() {
            return Err(self.err(
                "P0113",
                "expected expression, but the next token is at or left of the enclosing junction bullet",
            ));
        }
        let t = self.tok();
        match t.tok {
            // Junction list.
            Tok::Op(name) if Self::junction_kind_of(name).is_some() => self.parse_junction(),

            // Prefix operators (including `-` via its `-.` mixfix entry).
            Tok::Op(name) => {
                // Nonfix application of an infix/postfix symbol: `\o (1, 2)`.
                // Prefix-capable ops keep prefix meaning (`- (x)` is negation).
                if ops::prefix(name).is_none() && self.peek_at(1) == Tok::LParen {
                    self.bump();
                    self.bump(); // (
                    let mut args = Vec::new();
                    loop {
                        args.push(self.parse_arg()?);
                        if self.peek() == Tok::Comma {
                            self.bump();
                        } else {
                            break;
                        }
                    }
                    let close = self.expect_tok(Tok::RParen, "`)`")?;
                    let sym = self.interner.intern(name);
                    let span = t.span.merge(close.span);
                    return Ok(self.arena.alloc(ExprKind::Apply(sym, t.span, args), span));
                }
                if let Some(op) = ops::prefix(name) {
                    self.bump();
                    let operand = self.parse_expr_prec(Some(op))?;
                    let span = t.span.merge(self.arena.get(operand).span);
                    Ok(self.arena.alloc(ExprKind::Prefix(op.name, operand), span))
                } else {
                    Err(self.err("P0114", format!("unexpected operator `{name}`")))
                }
            }

            Tok::Number(s) => {
                self.bump();
                Ok(self.arena.alloc(ExprKind::Num(s), t.span))
            }
            Tok::Str(s) => {
                self.bump();
                Ok(self.arena.alloc(ExprKind::Str(s), t.span))
            }

            Tok::Ident(s) => self.parse_ident_operand(s, left),

            Tok::LParen => {
                self.bump();
                let inner = self.parse_expr()?;
                let close = self.expect_tok(Tok::RParen, "`)`")?;
                let span = t.span.merge(close.span);
                Ok(self.arena.alloc(ExprKind::Paren(inner), span))
            }

            Tok::LBrace => self.parse_brace(),
            Tok::LBracket => self.parse_bracket(),
            Tok::LAngleAngle => self.parse_tuple(),

            Tok::Kw(Kw::If) => {
                self.bump();
                let cond = self.parse_expr()?;
                self.expect_tok(Tok::Kw(Kw::Then), "`THEN`")?;
                let then = self.parse_expr()?;
                self.expect_tok(Tok::Kw(Kw::Else), "`ELSE`")?;
                let els = self.parse_expr()?;
                let span = t.span.merge(self.arena.get(els).span);
                Ok(self.arena.alloc(ExprKind::If { cond, then, els }, span))
            }

            Tok::Kw(Kw::Case) => self.parse_case(),
            Tok::Kw(Kw::Let) => self.parse_let(),
            Tok::Kw(Kw::Choose) => self.parse_choose(),
            Tok::Kw(Kw::Lambda) => self.parse_lambda(),

            Tok::Exists | Tok::Forall => self.parse_quant(),
            Tok::TExists | Tok::TForall => self.parse_temporal_quant(),

            Tok::WeakFair | Tok::StrongFair => {
                let kind = if t.tok == Tok::WeakFair { FairnessKind::Weak } else { FairnessKind::Strong };
                self.bump();
                let subscript = self.parse_subscript_operand()?;
                self.expect_tok(Tok::LParen, "`(` after fairness subscript")?;
                let action = self.parse_expr()?;
                let close = self.expect_tok(Tok::RParen, "`)`")?;
                let span = t.span.merge(close.span);
                Ok(self.arena.alloc(ExprKind::Fairness { kind, subscript, action }, span))
            }

            Tok::StepLexeme => Err(self.unsupported("proof step references are not supported")),
            Tok::Bang => Err(self.unsupported("subexpression `!` references are not supported")),

            other => Err(self.err("P0115", format!("expected expression, found {other:?}"))),
        }
    }

    /// Identifier-led operand: reference, application, label, or (rejected)
    /// `!` subexpression access. Labels (`lbl :: e`, `lbl(a, b) :: e`) are
    /// only legal where the labeled expression isn't an operand of an
    /// operator (SANY rejects `a * lab :: b`), hence the `left` gate.
    fn parse_ident_operand(&mut self, s: Sym, left: Option<&'static OpInfo>) -> PResult<ExprId> {
        let t = self.bump();
        match self.peek() {
            Tok::LParen if self.gate() => {
                self.bump();
                let mut args = Vec::new();
                loop {
                    args.push(self.parse_arg()?);
                    if self.peek() == Tok::Comma {
                        self.bump();
                    } else {
                        break;
                    }
                }
                let close = self.expect_tok(Tok::RParen, "`)` after arguments")?;
                let span = t.span.merge(close.span);
                if self.peek() == Tok::ColonColon && self.gate() {
                    // `lbl(a, b) :: e` — args must be plain names.
                    self.bump();
                    let mut names = Vec::new();
                    for a in &args {
                        match self.arena.get(*a).kind {
                            ExprKind::Ident(n) => names.push((n, self.arena.get(*a).span)),
                            _ => {
                                return Err(self.err(
                                    "P0123",
                                    "label parameters must be plain identifiers",
                                ));
                            }
                        }
                    }
                    let body = self.parse_label_body(left)?;
                    let lspan = t.span.merge(self.arena.get(body).span);
                    return Ok(self
                        .arena
                        .alloc(ExprKind::Label { name: s, args: names, body }, lspan));
                }
                if self.gate() && self.peek() == Tok::Bang {
                    return Err(
                        self.unsupported("instance member access `I!op` is not supported")
                    );
                }
                Ok(self.arena.alloc(ExprKind::Apply(s, t.span, args), span))
            }
            Tok::ColonColon if self.gate() => {
                self.bump();
                let body = self.parse_label_body(left)?;
                let span = t.span.merge(self.arena.get(body).span);
                Ok(self.arena.alloc(ExprKind::Label { name: s, args: Vec::new(), body }, span))
            }
            Tok::Bang if self.gate() => {
                Err(self.unsupported("instance member access `I!op` is not supported"))
            }
            _ => Ok(self.arena.alloc(ExprKind::Ident(s), t.span)),
        }
    }

    /// A label is precedence-transparent: its body parses under the pending
    /// left operator, and if an operator afterwards would have truncated the
    /// body (`a * lab :: b + c`), the label interferes with precedence and
    /// SANY rejects it.
    fn parse_label_body(&mut self, left: Option<&'static OpInfo>) -> PResult<ExprId> {
        let body = self.parse_expr_prec(left)?;
        if left.is_some() && self.gate() {
            let truncated = match self.peek() {
                Tok::Op(name) => ops::infix(name).is_some() || ops::postfix(name).is_some(),
                Tok::Prime | Tok::Dot | Tok::LBracket => true,
                _ => false,
            };
            if truncated {
                return Err(self.err(
                    "P0125",
                    "label interferes with operator precedence; parenthesize the labeled expression",
                ));
            }
        }
        Ok(body)
    }

    /// Argument position: a full expression, or a bare operator symbol used
    /// as an operator reference (`SortSeq(s, <)`, `f(^+, ')`).
    fn parse_arg(&mut self) -> PResult<ExprId> {
        if let Tok::Op(name) = self.peek() {
            if matches!(self.peek_at(1), Tok::Comma | Tok::RParen) {
                let t = self.bump();
                let sym = self.interner.intern(name);
                return Ok(self.arena.alloc(ExprKind::Ident(sym), t.span));
            }
        }
        if self.peek() == Tok::Prime && matches!(self.peek_at(1), Tok::Comma | Tok::RParen) {
            let t = self.bump();
            let sym = self.interner.intern("'");
            return Ok(self.arena.alloc(ExprKind::Ident(sym), t.span));
        }
        self.parse_expr()
    }

    /// Restricted operand used as `_v` subscripts of `[A]_v`, `<<A>>_v`,
    /// `WF_v`, `SF_v`: identifier, parenthesized expression, or tuple, with
    /// `[index]`/`.field` continuations — but crucially no `(args)`
    /// application, so `WF_vars(A)` reads subscript `vars`, action `A`.
    fn parse_subscript_operand(&mut self) -> PResult<ExprId> {
        let t = self.tok();
        let prim = match t.tok {
            Tok::Ident(s) => {
                self.bump();
                self.arena.alloc(ExprKind::Ident(s), t.span)
            }
            Tok::LParen => {
                self.bump();
                let inner = self.parse_expr()?;
                let close = self.expect_tok(Tok::RParen, "`)`")?;
                self.arena.alloc(ExprKind::Paren(inner), t.span.merge(close.span))
            }
            Tok::LAngleAngle => self.parse_tuple()?,
            other => {
                return Err(self.err("P0122", format!("expected subscript, found {other:?}")));
            }
        };
        Ok(prim).and_then(|mut lhs| {
            loop {
                if !self.gate() {
                    break;
                }
                match self.peek() {
                    Tok::LBracket => {
                        self.bump();
                        let mut args = vec![self.parse_expr()?];
                        while self.peek() == Tok::Comma {
                            self.bump();
                            args.push(self.parse_expr()?);
                        }
                        let close = self.expect_tok(Tok::RBracket, "`]`")?;
                        let span = self.arena.get(lhs).span.merge(close.span);
                        lhs = self.arena.alloc(ExprKind::FnApply { f: lhs, args }, span);
                    }
                    Tok::Dot => {
                        self.bump();
                        let (field, fsp) = self.parse_field_name()?;
                        let span = self.arena.get(lhs).span.merge(fsp);
                        lhs = self.arena.alloc(ExprKind::RecordField(lhs, field, fsp), span);
                    }
                    _ => break,
                }
            }
            Ok(lhs)
        })
    }

    fn parse_junction(&mut self) -> PResult<ExprId> {
        let first = self.tok();
        let Tok::Op(name) = first.tok else { unreachable!() };
        let kind = Self::junction_kind_of(name).unwrap();
        let col = first.col();
        let bullet: Tok = first.tok;
        self.junction.push((kind, col));
        let mut items = Vec::new();
        let result = (|| -> PResult<()> {
            loop {
                self.bump(); // bullet
                let item_start = self.pos;
                items.push(self.parse_expr()?);
                // SANY additionally post-validates that every token of the
                // item lies strictly right of the bullet column — this is
                // what rejects a closing `)` dedented past the bullet
                // (tla+.jj:526). Delimiters aren't gated during parsing, so
                // enforce it here over the consumed token range.
                for k in item_start..self.pos {
                    let tk = self.toks[k];
                    if tk.col() <= col {
                        return Err(Diag::syntax(
                            "P0124",
                            "token lies at or left of the enclosing junction bullet",
                            tk.span,
                        ));
                    }
                }
                // Same-kind bullet at exactly the anchor column continues.
                let t = self.tok();
                if t.tok == bullet && t.col() == col {
                    continue;
                }
                return Ok(());
            }
        })();
        self.junction.pop();
        result?;
        let span = first.span.merge(self.arena.get(*items.last().unwrap()).span);
        Ok(self.arena.alloc(ExprKind::Junction(kind, items), span))
    }

    fn parse_quant(&mut self) -> PResult<ExprId> {
        let t = self.bump();
        let kind = if t.tok == Tok::Exists { QuantKind::Exists } else { QuantKind::Forall };
        // Bounded: `\E x, y \in S, <<a, b>> \in T : e`
        // Unbounded: `\E x, y : e`
        let snapshot = self.pos;
        match self.parse_bounds() {
            Ok(bounds) if self.peek() == Tok::Colon => {
                self.bump();
                let body = self.parse_expr()?;
                let span = t.span.merge(self.arena.get(body).span);
                Ok(self.arena.alloc(ExprKind::Quant { kind, bounds, body }, span))
            }
            _ => {
                self.pos = snapshot;
                let mut vars = Vec::new();
                loop {
                    vars.push(self.expect_ident("bound variable")?);
                    if self.peek() == Tok::Comma {
                        self.bump();
                    } else {
                        break;
                    }
                }
                self.expect_tok(Tok::Colon, "`:` after quantifier variables")?;
                let body = self.parse_expr()?;
                let span = t.span.merge(self.arena.get(body).span);
                Ok(self.arena.alloc(ExprKind::UnboundedQuant { kind, vars, body }, span))
            }
        }
    }

    fn parse_temporal_quant(&mut self) -> PResult<ExprId> {
        let t = self.bump();
        let exists = t.tok == Tok::TExists;
        let mut vars = Vec::new();
        loop {
            vars.push(self.expect_ident("bound variable")?);
            if self.peek() == Tok::Comma {
                self.bump();
            } else {
                break;
            }
        }
        self.expect_tok(Tok::Colon, "`:`")?;
        let body = self.parse_expr()?;
        let span = t.span.merge(self.arena.get(body).span);
        Ok(self.arena.alloc(ExprKind::TemporalQuant { exists, vars, body }, span))
    }

    fn parse_choose(&mut self) -> PResult<ExprId> {
        let t = self.bump();
        let (var, tuple_vars) = if self.peek() == Tok::LAngleAngle {
            self.bump();
            let mut vs = Vec::new();
            loop {
                vs.push(self.expect_ident("bound variable in tuple")?);
                if self.peek() == Tok::Comma {
                    self.bump();
                } else {
                    break;
                }
            }
            self.expect_tok(Tok::RAngleAngle, "`>>`")?;
            (vs[0], vs)
        } else {
            let v = self.expect_ident("CHOOSE variable")?;
            (v, Vec::new())
        };
        let domain = if self.peek() == Tok::Op("\\in") {
            self.bump();
            Some(self.parse_expr_prec(ops::infix("\\in"))?)
        } else {
            None
        };
        self.expect_tok(Tok::Colon, "`:` in CHOOSE")?;
        let body = self.parse_expr()?;
        let span = t.span.merge(self.arena.get(body).span);
        Ok(self.arena.alloc(ExprKind::Choose { var, tuple_vars, domain, body }, span))
    }

    fn parse_lambda(&mut self) -> PResult<ExprId> {
        let t = self.bump();
        let mut params = Vec::new();
        loop {
            params.push(self.expect_ident("LAMBDA parameter")?);
            if self.peek() == Tok::Comma {
                self.bump();
            } else {
                break;
            }
        }
        self.expect_tok(Tok::Colon, "`:` after LAMBDA parameters")?;
        let body = self.parse_expr()?;
        let span = t.span.merge(self.arena.get(body).span);
        Ok(self.arena.alloc(ExprKind::Lambda { params, body }, span))
    }

    fn parse_case(&mut self) -> PResult<ExprId> {
        let t = self.bump();
        let mut arms = Vec::new();
        loop {
            let guard = if self.peek() == Tok::Kw(Kw::Other) {
                self.bump();
                None
            } else {
                Some(self.parse_expr()?)
            };
            self.expect_tok(Tok::Arrow, "`->` in CASE arm")?;
            let body = self.parse_expr()?;
            let is_other = guard.is_none();
            arms.push((guard, body));
            // `[]` separates arms; it can't continue the body expression
            // because `[]` has no infix entry. An OTHER arm ends the CASE
            // (SANY grammar) — a following `[]` belongs to an outer CASE.
            if !is_other && self.gate() && self.peek() == Tok::Op("[]") {
                self.bump();
            } else {
                break;
            }
        }
        let last = arms.last().unwrap().1;
        let span = t.span.merge(self.arena.get(last).span);
        Ok(self.arena.alloc(ExprKind::Case(arms), span))
    }

    fn parse_let(&mut self) -> PResult<ExprId> {
        let t = self.bump();
        let mut defs = Vec::new();
        loop {
            match self.peek() {
                Tok::Kw(Kw::LetIn) => {
                    self.bump();
                    break;
                }
                Tok::Kw(Kw::Recursive) => {
                    self.bump();
                    defs.push(Unit::Recursive(self.parse_op_decls()?));
                }
                Tok::Kw(Kw::Local) => {
                    return Err(self.err("P0116", "LOCAL is not allowed inside LET"));
                }
                _ => defs.push(self.parse_definition()?),
            }
        }
        let body = self.parse_expr()?;
        let span = t.span.merge(self.arena.get(body).span);
        Ok(self.arena.alloc(ExprKind::Let { defs, body }, span))
    }

    /// `{ ... }`: enum, filter, or map.
    fn parse_brace(&mut self) -> PResult<ExprId> {
        let t = self.bump();
        if self.peek() == Tok::RBrace {
            let close = self.bump();
            return Ok(self.arena.alloc(ExprKind::SetEnum(Vec::new()), t.span.merge(close.span)));
        }
        // Try filter shape first: `bound : pred` where bound is
        // `x \in S` or `<<x, y>> \in S` (SANY's fixed lookahead).
        let snapshot = self.pos;
        let arena_snapshot = self.arena.exprs.len();
        if let Ok(bound) = self.parse_single_bound() {
            if self.peek() == Tok::Colon {
                self.bump();
                let pred = self.parse_expr()?;
                let close = self.expect_tok(Tok::RBrace, "`}`")?;
                return Ok(self
                    .arena
                    .alloc(ExprKind::SetFilter { bound, pred }, t.span.merge(close.span)));
            }
        }
        self.pos = snapshot;
        self.arena.exprs.truncate(arena_snapshot);

        let first = self.parse_expr()?;
        match self.peek() {
            Tok::Colon => {
                // `{e : x \in S, ...}`
                self.bump();
                let bounds = self.parse_bounds()?;
                let close = self.expect_tok(Tok::RBrace, "`}`")?;
                Ok(self
                    .arena
                    .alloc(ExprKind::SetMap { expr: first, bounds }, t.span.merge(close.span)))
            }
            _ => {
                let mut items = vec![first];
                while self.peek() == Tok::Comma {
                    self.bump();
                    items.push(self.parse_expr()?);
                }
                let close = self.expect_tok(Tok::RBrace, "`}`")?;
                Ok(self.arena.alloc(ExprKind::SetEnum(items), t.span.merge(close.span)))
            }
        }
    }

    /// A single binder `x \in S` / `x, y \in S` / `<<x, y>> \in S`.
    fn parse_single_bound(&mut self) -> PResult<Bound> {
        if self.peek() == Tok::LAngleAngle {
            self.bump();
            let mut vars = Vec::new();
            loop {
                vars.push(self.expect_ident("bound variable")?);
                if self.peek() == Tok::Comma {
                    self.bump();
                } else {
                    break;
                }
            }
            self.expect_tok(Tok::RAngleAngle, "`>>`")?;
            self.expect_tok(Tok::Op("\\in"), "`\\in`")?;
            let domain = self.parse_expr_prec(ops::infix("\\in"))?;
            return Ok(Bound { vars, tuple: true, domain });
        }
        let mut vars = Vec::new();
        loop {
            vars.push(self.expect_ident("bound variable")?);
            if self.peek() == Tok::Comma {
                self.bump();
            } else {
                break;
            }
        }
        self.expect_tok(Tok::Op("\\in"), "`\\in`")?;
        let domain = self.parse_expr_prec(ops::infix("\\in"))?;
        Ok(Bound { vars, tuple: false, domain })
    }

    /// Comma-separated binder groups.
    fn parse_bounds(&mut self) -> PResult<Vec<Bound>> {
        // Groups share commas with variable lists: `x, y \in S, z \in T`.
        // Parse names first; on `\in` close the group.
        let mut bounds = Vec::new();
        loop {
            bounds.push(self.parse_bound_group()?);
            if self.peek() == Tok::Comma {
                self.bump();
            } else {
                break;
            }
        }
        Ok(bounds)
    }

    fn parse_bound_group(&mut self) -> PResult<Bound> {
        if self.peek() == Tok::LAngleAngle {
            return self.parse_single_bound();
        }
        let mut vars = vec![self.expect_ident("bound variable")?];
        while self.peek() == Tok::Comma && matches!(self.peek_at(1), Tok::Ident(_)) {
            // Lookahead: only absorb `, ident` if it still belongs to this
            // group (i.e. eventually hits `\in` rather than another group's
            // tuple form). SANY resolves this by grammar shape; a two-token
            // peek suffices for the comma-name-chain.
            let save = self.pos;
            self.bump();
            let v = self.expect_ident("bound variable")?;
            if self.peek() == Tok::Op("\\in") || self.peek() == Tok::Comma {
                vars.push(v);
            } else {
                self.pos = save;
                break;
            }
        }
        self.expect_tok(Tok::Op("\\in"), "`\\in` in binder")?;
        let domain = self.parse_expr_prec(ops::infix("\\in"))?;
        Ok(Bound { vars, tuple: false, domain })
    }

    /// `[ ... ]`: function constructor, record, record set, EXCEPT, function
    /// set, or `[A]_v`.
    fn parse_bracket(&mut self) -> PResult<ExprId> {
        let t = self.bump();

        // Function constructor: `[x \in S |-> e]`
        let snapshot = self.pos;
        let arena_snapshot = self.arena.exprs.len();
        if let Ok(bounds) = self.parse_bounds() {
            if self.peek() == Tok::MapsTo {
                self.bump();
                let body = self.parse_expr()?;
                let close = self.expect_tok(Tok::RBracket, "`]`")?;
                return Ok(self
                    .arena
                    .alloc(ExprKind::FnConstructor { bounds, body }, t.span.merge(close.span)));
            }
        }
        self.pos = snapshot;
        self.arena.exprs.truncate(arena_snapshot);

        // Record: `[a |-> e, ...]`; record set: `[a : S, ...]`.
        if let Tok::Ident(first) = self.peek() {
            if self.peek_at(1) == Tok::MapsTo {
                let mut fields = Vec::new();
                let mut name = first;
                loop {
                    let nt = self.bump();
                    self.expect_tok(Tok::MapsTo, "`|->`")?;
                    let val = self.parse_expr()?;
                    fields.push((name, nt.span, val));
                    if self.peek() == Tok::Comma {
                        self.bump();
                        match self.peek() {
                            Tok::Ident(s) => name = s,
                            _ => return Err(self.err("P0117", "expected field name")),
                        }
                    } else {
                        break;
                    }
                }
                let close = self.expect_tok(Tok::RBracket, "`]`")?;
                return Ok(self.arena.alloc(ExprKind::Record(fields), t.span.merge(close.span)));
            }
            if self.peek_at(1) == Tok::Colon {
                let mut fields = Vec::new();
                let mut name = first;
                loop {
                    let nt = self.bump();
                    self.expect_tok(Tok::Colon, "`:`")?;
                    let val = self.parse_expr()?;
                    fields.push((name, nt.span, val));
                    if self.peek() == Tok::Comma {
                        self.bump();
                        match self.peek() {
                            Tok::Ident(s) => name = s,
                            _ => return Err(self.err("P0117", "expected field name")),
                        }
                    } else {
                        break;
                    }
                }
                let close = self.expect_tok(Tok::RBracket, "`]`")?;
                return Ok(self.arena.alloc(ExprKind::RecordSet(fields), t.span.merge(close.span)));
            }
        }

        // General expression head: EXCEPT / fn-set / action subscript.
        let head = self.parse_expr()?;
        match self.peek() {
            Tok::Kw(Kw::Except) => {
                self.bump();
                let mut updates = Vec::new();
                loop {
                    self.expect_tok(Tok::Bang, "`!` in EXCEPT")?;
                    let mut path = Vec::new();
                    loop {
                        match self.peek() {
                            Tok::LBracket => {
                                self.bump();
                                let mut idx = vec![self.parse_expr()?];
                                while self.peek() == Tok::Comma {
                                    self.bump();
                                    idx.push(self.parse_expr()?);
                                }
                                self.expect_tok(Tok::RBracket, "`]`")?;
                                path.push(ExceptPathElem::Index(idx));
                            }
                            Tok::Dot => {
                                self.bump();
                                let (f, _) = self.parse_field_name()?;
                                path.push(ExceptPathElem::Field(f));
                            }
                            _ => break,
                        }
                    }
                    if path.is_empty() {
                        return Err(self.err("P0118", "expected `[index]` or `.field` after `!`"));
                    }
                    self.expect_tok(Tok::Op("="), "`=` in EXCEPT update")?;
                    let value = self.parse_expr()?;
                    updates.push(ExceptUpdate { path, value });
                    if self.peek() == Tok::Comma {
                        self.bump();
                    } else {
                        break;
                    }
                }
                let close = self.expect_tok(Tok::RBracket, "`]`")?;
                Ok(self
                    .arena
                    .alloc(ExprKind::Except { base: head, updates }, t.span.merge(close.span)))
            }
            Tok::Arrow => {
                self.bump();
                let range = self.parse_expr()?;
                let close = self.expect_tok(Tok::RBracket, "`]`")?;
                Ok(self
                    .arena
                    .alloc(ExprKind::FnSet { domain: head, range }, t.span.merge(close.span)))
            }
            Tok::RBracketUnder => {
                let close = self.bump();
                let subscript = self.parse_subscript_operand()?;
                let span = t.span.merge(self.arena.get(subscript).span);
                let _ = close;
                Ok(self.arena.alloc(
                    ExprKind::ActionSubscript {
                        kind: SubscriptKind::Square,
                        action: head,
                        subscript,
                    },
                    span,
                ))
            }
            _ => Err(self.err("P0119", "expected `EXCEPT`, `->`, or `]_` in bracket expression")),
        }
    }

    /// `<< ... >>` tuple or `<<A>>_v` action.
    fn parse_tuple(&mut self) -> PResult<ExprId> {
        let t = self.bump();
        if self.peek() == Tok::RAngleAngle {
            let close = self.bump();
            return Ok(self.arena.alloc(ExprKind::Tuple(Vec::new()), t.span.merge(close.span)));
        }
        let mut items = vec![self.parse_expr()?];
        while self.peek() == Tok::Comma {
            self.bump();
            items.push(self.parse_expr()?);
        }
        match self.peek() {
            Tok::RAngleAngle => {
                let close = self.bump();
                Ok(self.arena.alloc(ExprKind::Tuple(items), t.span.merge(close.span)))
            }
            Tok::RAngleAngleUnder => {
                if items.len() != 1 {
                    return Err(self.err("P0120", "`<<A>>_v` takes exactly one action"));
                }
                self.bump();
                let subscript = self.parse_subscript_operand()?;
                let span = t.span.merge(self.arena.get(subscript).span);
                Ok(self.arena.alloc(
                    ExprKind::ActionSubscript {
                        kind: SubscriptKind::Angle,
                        action: items[0],
                        subscript,
                    },
                    span,
                ))
            }
            _ => Err(self.err("P0121", "expected `>>` or `>>_`")),
        }
    }
}

enum Resolution {
    TakeRight,
    LeftFirst,
    Conflict,
}
