//! `.cfg` model-configuration parser, ported from
//! `tlc2/tool/impl/ModelConfig.java`.
//!
//! The cfg file is tokenized with the TLA+ lexer (as Java uses the TLA+
//! token manager). Sections start at a keyword and run until the next
//! keyword. Constant entries are `name = <value>` or `name <- Operator`;
//! values are numbers, strings, TRUE/FALSE, `{…}` sets, and bare
//! identifiers, which become *model values* (`CONSTANT NoUser = NoUser`).

use crate::diag::{Category, Diag};
use crate::intern::{Interner, Sym};
use crate::loc::{FileId, Span};
use crate::syntax::lexer::Lexer;
use crate::syntax::token::{Kw, Tok, Token};

#[derive(Debug, Clone)]
pub enum CfgValue {
    Int(i64),
    Str(Sym),
    Bool(bool),
    Set(Vec<CfgValue>),
    /// Bare identifier — a model value.
    Model(Sym),
}

#[derive(Debug)]
pub enum ConstantBinding {
    /// `name = value`
    Assign { name: Sym, span: Span, value: CfgValue },
    /// `name <- Operator`
    Subst { name: Sym, span: Span, op: Sym },
    /// `name(a1, ..., an) = value` — one line of a parameterized constant
    /// assignment (Java `ModelConfig` supports these; several lines with the
    /// same name form the operator's table).
    AssignFn { name: Sym, span: Span, args: Vec<CfgValue>, value: CfgValue },
}

#[derive(Debug, Default)]
pub struct Config {
    pub spec: Option<(Sym, Span)>,
    pub init: Option<(Sym, Span)>,
    pub next: Option<(Sym, Span)>,
    pub invariants: Vec<(Sym, Span)>,
    pub properties: Vec<(Sym, Span)>,
    pub constraints: Vec<(Sym, Span)>,
    pub action_constraints: Vec<(Sym, Span)>,
    pub constants: Vec<ConstantBinding>,
    pub check_deadlock: Option<bool>,
}

fn cfg_err(code: &'static str, msg: impl Into<String>, span: Span) -> Diag {
    Diag::new(Category::Config, code, msg).with_span(span)
}

/// Section keywords. `CONSTANT`/`CONSTANTS` arrive as `Kw(Constant)` from the
/// lexer; the rest are plain identifiers.
const KEYWORDS: &[&str] = &[
    "SPECIFICATION",
    "INIT",
    "NEXT",
    "INVARIANT",
    "INVARIANTS",
    "PROPERTY",
    "PROPERTIES",
    "CONSTRAINT",
    "CONSTRAINTS",
    "ACTION_CONSTRAINT",
    "ACTION_CONSTRAINTS",
    "CHECK_DEADLOCK",
    "SYMMETRY",
    "VIEW",
    "ALIAS",
    "POSTCONDITION",
    "POSTCONDITIONS",
    "PERIODIC",
    "RL_REWARD",
];

struct CfgParser<'a> {
    toks: Vec<Token>,
    pos: usize,
    interner: &'a mut Interner,
}

impl<'a> CfgParser<'a> {
    fn tok(&self) -> Token {
        self.toks[self.pos.min(self.toks.len() - 1)]
    }

    fn bump(&mut self) -> Token {
        let t = self.tok();
        if self.pos < self.toks.len() - 1 {
            self.pos += 1;
        }
        t
    }

    fn word(&self, t: &Token) -> Option<String> {
        match t.tok {
            Tok::Ident(s) => Some(self.interner.str(s).to_string()),
            Tok::Kw(Kw::Constant) => Some("CONSTANT".to_string()),
            _ => None,
        }
    }

    fn at_keyword(&self) -> Option<String> {
        let t = self.tok();
        let w = self.word(&t)?;
        if KEYWORDS.contains(&w.as_str()) || w == "CONSTANT" {
            Some(w)
        } else {
            None
        }
    }

    fn expect_name(&mut self, what: &str) -> Result<(Sym, Span), Diag> {
        let t = self.tok();
        match t.tok {
            Tok::Ident(s) => {
                self.bump();
                Ok((s, t.span))
            }
            // Operator symbols are legal names in CONSTANT sections
            // (`++ <- PlusPlus`, `\o <- +` — ModelConfig accepts them).
            Tok::Op(op) => {
                self.bump();
                Ok((self.interner.intern(op), t.span))
            }
            _ => Err(cfg_err("C0002", format!("expected {what}"), t.span)),
        }
    }

    /// Names until the next keyword/EOF.
    fn name_list(&mut self, out: &mut Vec<(Sym, Span)>) -> Result<(), Diag> {
        loop {
            if self.tok().tok == Tok::Eof || self.at_keyword().is_some() {
                return Ok(());
            }
            out.push(self.expect_name("a name")?);
        }
    }

    fn parse_value(&mut self) -> Result<CfgValue, Diag> {
        let t = self.bump();
        match t.tok {
            Tok::Number(s) => {
                let text = self.interner.str(s);
                text.parse::<i64>()
                    .map(CfgValue::Int)
                    .map_err(|_| cfg_err("C0003", format!("bad number `{text}`"), t.span))
            }
            Tok::Op("-") => {
                // Negative number literal.
                let nt = self.bump();
                match nt.tok {
                    Tok::Number(s) => {
                        let text = self.interner.str(s);
                        text.parse::<i64>()
                            .map(|n| CfgValue::Int(-n))
                            .map_err(|_| cfg_err("C0003", format!("bad number `{text}`"), nt.span))
                    }
                    _ => Err(cfg_err("C0004", "expected number after `-`", nt.span)),
                }
            }
            Tok::Str(s) => Ok(CfgValue::Str(s)),
            Tok::Ident(s) => {
                let w = self.interner.str(s);
                match w {
                    "TRUE" => Ok(CfgValue::Bool(true)),
                    "FALSE" => Ok(CfgValue::Bool(false)),
                    _ => Ok(CfgValue::Model(s)),
                }
            }
            Tok::LBrace => {
                let mut elems = Vec::new();
                if self.tok().tok == Tok::RBrace {
                    self.bump();
                    return Ok(CfgValue::Set(elems));
                }
                loop {
                    elems.push(self.parse_value()?);
                    let t = self.bump();
                    match t.tok {
                        Tok::Comma => continue,
                        Tok::RBrace => break,
                        _ => return Err(cfg_err("C0005", "expected `,` or `}` in set", t.span)),
                    }
                }
                Ok(CfgValue::Set(elems))
            }
            _ => Err(cfg_err("C0006", "expected a value", t.span)),
        }
    }
}

pub fn parse_cfg(src: &str, file: FileId, interner: &mut Interner) -> Result<Config, Diag> {
    let lexed = Lexer::lex(src, file, interner);
    if let Some(d) = lexed.diags.into_iter().next() {
        return Err(d);
    }
    let mut p = CfgParser { toks: lexed.tokens, pos: 0, interner };
    let mut cfg = Config::default();

    loop {
        if p.tok().tok == Tok::Eof {
            break;
        }
        let t = p.tok();
        let Some(kw) = p.at_keyword() else {
            return Err(cfg_err(
                "C0001",
                format!("expected a configuration keyword, found {:?}", t.tok),
                t.span,
            ));
        };
        p.bump();
        match kw.as_str() {
            "SPECIFICATION" => {
                if cfg.spec.is_some() {
                    return Err(cfg_err("C0007", "SPECIFICATION given twice", t.span));
                }
                cfg.spec = Some(p.expect_name("specification name")?);
            }
            "INIT" => {
                if cfg.init.is_some() {
                    return Err(cfg_err("C0007", "INIT given twice", t.span));
                }
                cfg.init = Some(p.expect_name("init predicate name")?);
            }
            "NEXT" => {
                if cfg.next.is_some() {
                    return Err(cfg_err("C0007", "NEXT given twice", t.span));
                }
                cfg.next = Some(p.expect_name("next-state relation name")?);
            }
            "INVARIANT" | "INVARIANTS" => p.name_list(&mut cfg.invariants)?,
            "PROPERTY" | "PROPERTIES" => p.name_list(&mut cfg.properties)?,
            "CONSTRAINT" | "CONSTRAINTS" => p.name_list(&mut cfg.constraints)?,
            "ACTION_CONSTRAINT" | "ACTION_CONSTRAINTS" => {
                p.name_list(&mut cfg.action_constraints)?
            }
            "CHECK_DEADLOCK" => {
                let (s, sp) = p.expect_name("TRUE or FALSE")?;
                match p.interner.str(s) {
                    "TRUE" => cfg.check_deadlock = Some(true),
                    "FALSE" => cfg.check_deadlock = Some(false),
                    other => {
                        return Err(cfg_err(
                            "C0008",
                            format!("CHECK_DEADLOCK expects TRUE or FALSE, found `{other}`"),
                            sp,
                        ));
                    }
                }
            }
            "CONSTANT" | "CONSTANTS" => loop {
                if p.tok().tok == Tok::Eof || p.at_keyword().is_some() {
                    break;
                }
                let (name, span) = p.expect_name("constant name")?;
                let sep = p.bump();
                match sep.tok {
                    Tok::Op("=") => {
                        let value = p.parse_value()?;
                        cfg.constants.push(ConstantBinding::Assign { name, span, value });
                    }
                    Tok::LeftArrow => {
                        if p.tok().tok == Tok::LBracket {
                            return Err(Diag::new(
                                Category::Unsupported,
                                "U0301",
                                "module-qualified substitution `<- [Mod]` is not supported",
                            )
                            .with_span(sep.span));
                        }
                        let (op, _) = p.expect_name("operator name after `<-`")?;
                        cfg.constants.push(ConstantBinding::Subst { name, span, op });
                    }
                    Tok::LParen => {
                        let mut args = Vec::new();
                        if p.tok().tok == Tok::RParen {
                            p.bump();
                        } else {
                            loop {
                                args.push(p.parse_value()?);
                                let t2 = p.bump();
                                match t2.tok {
                                    Tok::Comma => continue,
                                    Tok::RParen => break,
                                    _ => {
                                        return Err(cfg_err(
                                            "C0011",
                                            "expected `,` or `)` in constant arguments",
                                            t2.span,
                                        ))
                                    }
                                }
                            }
                        }
                        let eq = p.bump();
                        if eq.tok != Tok::Op("=") {
                            return Err(cfg_err(
                                "C0009",
                                "expected `=` after parameterized constant arguments",
                                eq.span,
                            ));
                        }
                        let value = p.parse_value()?;
                        cfg.constants.push(ConstantBinding::AssignFn { name, span, args, value });
                    }
                    _ => {
                        return Err(cfg_err(
                            "C0009",
                            "expected `=` or `<-` in constant assignment",
                            sep.span,
                        ));
                    }
                }
            },
            "SYMMETRY" | "VIEW" | "ALIAS" | "POSTCONDITION" | "POSTCONDITIONS" | "PERIODIC"
            | "RL_REWARD" => {
                return Err(Diag::new(
                    Category::Unsupported,
                    "U0303",
                    format!("configuration keyword {kw} is not supported (safety-subset engine)"),
                )
                .with_span(t.span));
            }
            other => {
                return Err(cfg_err("C0001", format!("unhandled keyword {other}"), t.span));
            }
        }
    }

    if cfg.spec.is_some() && (cfg.init.is_some() || cfg.next.is_some()) {
        return Err(Diag::new(
            Category::Config,
            "C0010",
            "config cannot give both SPECIFICATION and INIT/NEXT",
        ));
    }
    Ok(cfg)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::loc::FileId;

    fn parse(src: &str) -> Result<Config, Diag> {
        let mut interner = Interner::new();
        parse_cfg(src, FileId(0), &mut interner)
    }

    #[test]
    fn basic_init_next() {
        let cfg = parse("INIT Init\nNEXT Next\nINVARIANT TypeOK Safe\n").unwrap();
        assert!(cfg.init.is_some() && cfg.next.is_some());
        assert_eq!(cfg.invariants.len(), 2);
    }

    #[test]
    fn spec_and_constants() {
        let cfg = parse(
            "SPECIFICATION Spec\nCONSTANTS\n  MaxAmt = 2\n  Users = {u1, u2}\n  NoUser = NoUser\n  Op <- Impl\nPROPERTY Terminal\nCHECK_DEADLOCK FALSE\n",
        )
        .unwrap();
        assert!(cfg.spec.is_some());
        assert_eq!(cfg.constants.len(), 4);
        assert_eq!(cfg.properties.len(), 1);
        assert_eq!(cfg.check_deadlock, Some(false));
        match &cfg.constants[1] {
            ConstantBinding::Assign { value: CfgValue::Set(v), .. } => assert_eq!(v.len(), 2),
            other => panic!("expected set assign, got {other:?}"),
        }
    }

    #[test]
    fn comments_allowed() {
        let cfg = parse("\\* a comment\nINIT Init (* inline *)\nNEXT Next\n").unwrap();
        assert!(cfg.init.is_some());
    }

    #[test]
    fn symmetry_rejected() {
        let d = parse("SYMMETRY Perms\n").unwrap_err();
        assert_eq!(d.code, "U0303");
    }

    #[test]
    fn spec_conflicts_with_init() {
        let d = parse("SPECIFICATION Spec\nINIT Init\n").unwrap_err();
        assert_eq!(d.code, "C0010");
    }
}
