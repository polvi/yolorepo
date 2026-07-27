//! The bundled standard modules must parse.

use tlc_core::intern::Interner;
use tlc_core::loc::FileId;
use tlc_core::stdlib::STANDARD_MODULES;

#[test]
fn standard_modules_parse() {
    let mut failures = Vec::new();
    for (i, (name, src)) in STANDARD_MODULES.iter().enumerate() {
        let mut interner = Interner::new();
        if let Err(d) = tlc_core::syntax::parse_source(src, FileId(i as u32), &mut interner) {
            failures.push(format!("{name}: {d}"));
        }
    }
    assert!(failures.is_empty(), "stdlib parse failures:\n{}", failures.join("\n"));
}
