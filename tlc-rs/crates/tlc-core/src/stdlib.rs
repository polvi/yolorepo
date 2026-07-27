//! Standard modules bundled into the engine, copied verbatim from
//! tlaplus `src/tla2sany/StandardModules/` (commit 30cc36013).
//!
//! These are parsed like user modules; performance-critical operators are
//! overridden by native implementations in `eval::modules`.

pub const STANDARD_MODULES: &[(&str, &str)] = &[
    ("Naturals", include_str!("../stdlib/Naturals.tla")),
    ("Integers", include_str!("../stdlib/Integers.tla")),
    ("Sequences", include_str!("../stdlib/Sequences.tla")),
    ("FiniteSets", include_str!("../stdlib/FiniteSets.tla")),
    ("TLC", include_str!("../stdlib/TLC.tla")),
    ("Bags", include_str!("../stdlib/Bags.tla")),
];

pub fn standard_module(name: &str) -> Option<&'static str> {
    STANDARD_MODULES
        .iter()
        .find(|(n, _)| *n == name)
        .map(|(_, src)| *src)
}
