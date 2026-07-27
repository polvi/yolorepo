//! Corpus harness over the vendored tree-sitter-style parser tests in
//! `tests/corpus/` (see that directory's SOURCE.md for provenance).
//!
//! Tier 1 (active): every test source must lex without lexical errors unless
//! the test is marked `:error`. Once the parser lands, this tightens to full
//! accept/reject parity, and Tier 2 adds S-expression shape comparison.

use std::fs;
use std::path::{Path, PathBuf};

use tlc_core::intern::Interner;
use tlc_core::loc::FileId;
use tlc_core::syntax::Lexer;

#[derive(Debug)]
struct CorpusTest {
    file: String,
    name: String,
    expect_error: bool,
    source: String,
    expected_sexpr: String,
}

/// Minimal S-expression tree for Tier-2 shape comparison.
#[derive(Debug, PartialEq, Eq)]
struct SNode {
    name: String,
    children: Vec<SNode>,
}

/// Corpus tests where SANY itself is known to disagree with the corpus'
/// expected accept/reject verdict. Vendored verbatim from the Java runner
/// (`test/tla2sany/parser/TlaPlusSyntaxCorpusTests.java`, `expectFailures`),
/// each entry tagged there with its tlaplus GitHub issue. Since our
/// conformance target is SANY behavior, these are exempt from strict parity.
const SANY_KNOWN_DISAGREEMENTS: &[&str] = &[
    "Cartesian Product as Parameter",
    "Named Theorem After Submodule (GH tlaplus/tlaplus #430)",
    "Conjunct Inside Ambiguous Case (GH tlaplus/tlaplus #487)",
    "Unicode Conjunct Inside Ambiguous Case (GH tlaplus/tlaplus #487)",
    "Decimal No Leading Zero (GH tlaplus/tlaplus #596)",
    "Invalid Use of LOCAL in LET/IN",
    "Invalid Use of LOCAL in Proof",
    "Step Expression Requiring Lookahead",
    "String with comment start",
    "Nonfix Minus (GH tlaplus/tlaplus #GH884)",
    "Nonfix Submodule Excl (GH tlaplus/tlaplus #GH884)",
    "Nonfix Double Exclamation Operator (GH TSTLA #GH97, GH tlaplus/tlaplus #884)",
    "Label with Subexpression Prefix (GH tlaplus/tlaplus #885)",
    "Empty Tuple Quantification (GH tlaplus/tlaplus #888)",
    "Negative Prefix Op on RHS of Infix (GH tlaplus/tlaplus #893)",
    "Mistaken Set Filter Tuples Test",
];

/// Valid TLA+ the engine deliberately rejects in v1 (documented scope
/// exclusions — all involve `!` subexpression / instance-member references).
/// This list must only ever shrink.
const ENGINE_UNSUPPORTED: &[&str] = &[
    "Nonfix Infix Operators",
    "Nonfix Prefix Operators",
    "Nonfix Postfix Operators",
    "Nonfix Unicode Operators",
    "Number Set Definitions",
    "Unicode Number Sets",
];

fn corpus_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/corpus")
}

fn is_header_rule(line: &str) -> bool {
    let l = line.trim_end();
    l.len() >= 4 && l.ends_with("|||") && l[..l.len() - 3].chars().all(|c| c == '=')
}

fn is_separator_rule(line: &str) -> bool {
    let l = line.trim_end();
    l.len() >= 4 && l.ends_with("|||") && l[..l.len() - 3].chars().all(|c| c == '-')
}

fn parse_corpus_file(path: &Path) -> Vec<CorpusTest> {
    let text = fs::read_to_string(path).unwrap_or_else(|e| panic!("read {path:?}: {e}"));
    let file = path.file_name().unwrap().to_string_lossy().into_owned();
    let lines: Vec<&str> = text.lines().collect();
    let mut tests = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        if !is_header_rule(lines[i]) {
            i += 1;
            continue;
        }
        // Header block: rule, name/attr lines, rule.
        i += 1;
        let mut name = String::new();
        let mut expect_error = false;
        while i < lines.len() && !is_header_rule(lines[i]) {
            let l = lines[i].trim();
            if l == ":error" {
                expect_error = true;
            } else if !l.is_empty() && name.is_empty() {
                name = l.to_string();
            }
            i += 1;
        }
        i += 1; // closing header rule

        // Source until separator rule.
        let mut source = String::new();
        while i < lines.len() && !is_separator_rule(lines[i]) {
            source.push_str(lines[i]);
            source.push('\n');
            i += 1;
        }
        i += 1; // separator rule

        // Expected S-expression until next header rule or EOF.
        let mut expected = String::new();
        while i < lines.len() && !is_header_rule(lines[i]) {
            expected.push_str(lines[i]);
            expected.push('\n');
            i += 1;
        }
        tests.push(CorpusTest {
            file: file.clone(),
            name,
            expect_error,
            source,
            expected_sexpr: expected.trim().to_string(),
        });
    }
    tests
}

fn load_all() -> Vec<CorpusTest> {
    let dir = corpus_dir();
    let mut all = Vec::new();
    let mut paths: Vec<PathBuf> = Vec::new();
    for sub in [dir.clone(), dir.join("unicode")] {
        for entry in fs::read_dir(&sub).unwrap_or_else(|e| panic!("read_dir {sub:?}: {e}")) {
            let p = entry.unwrap().path();
            if p.extension().is_some_and(|e| e == "txt") {
                paths.push(p);
            }
        }
    }
    paths.sort();
    for p in paths {
        all.extend(parse_corpus_file(&p));
    }
    all
}

fn parse_sexpr(s: &str) -> Result<SNode, String> {
    let mut chars = s.chars().peekable();
    fn skip_ws(chars: &mut std::iter::Peekable<std::str::Chars>) {
        while chars.peek().is_some_and(|c| c.is_whitespace()) {
            chars.next();
        }
    }
    fn node(chars: &mut std::iter::Peekable<std::str::Chars>) -> Result<SNode, String> {
        skip_ws(chars);
        if chars.next() != Some('(') {
            return Err("expected (".into());
        }
        skip_ws(chars);
        let mut name = String::new();
        while chars.peek().is_some_and(|c| !c.is_whitespace() && *c != '(' && *c != ')') {
            name.push(chars.next().unwrap());
        }
        let mut children = Vec::new();
        loop {
            skip_ws(chars);
            match chars.peek() {
                Some('(') => children.push(node(chars)?),
                Some(')') => {
                    chars.next();
                    return Ok(SNode { name, children });
                }
                Some(_) => {
                    // field labels like `name:` — consume the word
                    while chars.peek().is_some_and(|c| !c.is_whitespace() && *c != '(' && *c != ')')
                    {
                        chars.next();
                    }
                }
                None => return Err(format!("unterminated s-expression in node {name}")),
            }
        }
    }
    let n = node(&mut chars)?;
    skip_ws(&mut chars);
    if chars.next().is_some() {
        return Err("trailing content after s-expression".into());
    }
    Ok(n)
}

#[test]
fn corpus_loads_expected_test_count() {
    let all = load_all();
    assert!(
        all.len() >= 180,
        "expected ~182 corpus tests, found {} — corpus loader or vendored files broken",
        all.len()
    );
    let errors = all.iter().filter(|t| t.expect_error).count();
    assert!(errors >= 15, "expected ~18 :error tests, found {errors}");
}

#[test]
fn corpus_expected_trees_parse_as_sexprs() {
    let mut bad = Vec::new();
    for t in load_all() {
        if t.expect_error {
            continue; // error tests have no expected tree
        }
        if t.expected_sexpr.is_empty() {
            bad.push(format!("{}::{} has empty expected tree", t.file, t.name));
            continue;
        }
        if let Err(e) = parse_sexpr(&t.expected_sexpr) {
            bad.push(format!("{}::{}: {e}", t.file, t.name));
        }
    }
    assert!(bad.is_empty(), "unparseable expected trees:\n{}", bad.join("\n"));
}

/// Corpus files that are entirely proof syntax — out of scope for the
/// safety-subset engine (they parse to clean Unsupported rejections, which
/// the corpus counts as failures since SANY accepts them).
const SKIPPED_FILES: &[&str] = &[
    "proofs.txt",
    "proofs-unicode.txt",
    "assume-prove.txt",
    "use_or_hide.txt",
    "step_expressions.txt",
    "subexpressions.txt",
    "subexpressions-unicode.txt",
];

/// Tier 1: accept/reject parity with the corpus (modulo SANY's own known
/// disagreements and the out-of-scope proof-syntax files).
#[test]
fn corpus_tier1_accept_reject() {
    let mut failures = Vec::new();
    let mut skipped_tests = 0usize;
    let mut total = 0usize;
    for t in load_all() {
        if SKIPPED_FILES.contains(&t.file.as_str())
            || SANY_KNOWN_DISAGREEMENTS.contains(&t.name.as_str())
            || ENGINE_UNSUPPORTED.contains(&t.name.as_str())
        {
            skipped_tests += 1;
            continue;
        }
        total += 1;
        let mut interner = Interner::new();
        let result = tlc_core::syntax::parse_source(&t.source, FileId(0), &mut interner);
        match (t.expect_error, result) {
            (false, Ok(_)) | (true, Err(_)) => {}
            (false, Err(d)) => {
                failures.push(format!("{}::{}: expected accept, got: {d}", t.file, t.name));
            }
            (true, Ok(_)) => {
                failures.push(format!("{}::{}: expected reject, but parsed", t.file, t.name));
            }
        }
    }
    eprintln!("tier1: {} checked, {} skipped", total, skipped_tests);
    assert!(
        failures.is_empty(),
        "{} corpus tier-1 failures:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

/// Lexer-only smoke retained from M0.
#[test]
fn corpus_sources_lex_cleanly() {
    let mut failures = Vec::new();
    for t in load_all() {
        if t.expect_error || SANY_KNOWN_DISAGREEMENTS.contains(&t.name.as_str()) {
            continue;
        }
        let mut interner = Interner::new();
        let out = Lexer::lex(&t.source, FileId(0), &mut interner);
        if !out.diags.is_empty() {
            failures.push(format!(
                "{}::{}: {}",
                t.file,
                t.name,
                out.diags
                    .iter()
                    .map(|d| d.to_string())
                    .collect::<Vec<_>>()
                    .join("; ")
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "{} corpus tests failed to lex:\n{}",
        failures.len(),
        failures.join("\n")
    );
}
