//! tlc-rs: native CLI for the tlc-core engine.
//! `parse` covers syntax + semantic/level analysis (M2); `check` arrives
//! with the checker milestones.

use std::borrow::Cow;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use tlc_core::intern::Interner;
use tlc_core::loc::FileId;
use tlc_core::syntax::Lexer;
use tlc_core::ModuleResolver;

/// Resolves extended/instanced modules as `.tla` files next to the root
/// module (standard modules are handled by the engine before this is asked).
struct DirResolver {
    dir: PathBuf,
}

impl ModuleResolver for DirResolver {
    fn resolve(&self, name: &str) -> Option<Cow<'_, str>> {
        std::fs::read_to_string(self.dir.join(format!("{name}.tla"))).ok().map(Cow::Owned)
    }
}

/// `tlc-rs check Spec.tla [-c Spec.cfg] [--json] [--timeout SECS]`
fn run_check_cmd(rest: &[String]) -> ExitCode {
    let mut tla: Option<String> = None;
    let mut cfg: Option<String> = None;
    let mut json = false;
    let mut timeout_secs: u64 = 30;
    let mut i = 0;
    while i < rest.len() {
        match rest[i].as_str() {
            "-c" | "--config" if i + 1 < rest.len() => {
                cfg = Some(rest[i + 1].clone());
                i += 2;
            }
            "--json" => {
                json = true;
                i += 1;
            }
            "--timeout" if i + 1 < rest.len() => {
                match rest[i + 1].parse() {
                    Ok(t) => timeout_secs = t,
                    Err(_) => {
                        eprintln!("error: bad --timeout value");
                        return ExitCode::FAILURE;
                    }
                }
                i += 2;
            }
            other if tla.is_none() && !other.starts_with('-') => {
                tla = Some(other.to_string());
                i += 1;
            }
            other => {
                eprintln!("error: unexpected argument {other}");
                return ExitCode::FAILURE;
            }
        }
    }
    let Some(tla) = tla else {
        eprintln!("usage: tlc-rs check <Spec.tla> [-c Spec.cfg] [--json] [--timeout SECS]");
        return ExitCode::FAILURE;
    };
    let tla_path = PathBuf::from(&tla);
    let src = match std::fs::read_to_string(&tla_path) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("error: cannot read {tla}: {e}");
            return ExitCode::FAILURE;
        }
    };
    let cfg_path = match cfg {
        Some(c) => PathBuf::from(c),
        None => tla_path.with_extension("cfg"),
    };
    let cfg_src = match std::fs::read_to_string(&cfg_path) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("error: cannot read {}: {e}", cfg_path.display());
            return ExitCode::FAILURE;
        }
    };
    let Some(root_name) = tla_path.file_stem().map(|s| s.to_string_lossy().into_owned()) else {
        eprintln!("error: cannot derive a module name from {tla}");
        return ExitCode::FAILURE;
    };
    let resolver = DirResolver {
        dir: tla_path.parent().unwrap_or_else(|| Path::new(".")).to_path_buf(),
    };
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(timeout_secs);
    let exceeded = move || std::time::Instant::now() >= deadline;
    let budget = tlc_core::check::bfs::CheckBudget {
        deadline_exceeded: Some(&exceeded),
        memory_exceeded: None,
        max_states: None,
        // The CLI runs on the main thread (8 MiB stack on most platforms).
        eval_stack_bytes: Some(6 * 1024 * 1024),
    };
    let resp = tlc_core::check::run_check_with_resolver(
        &root_name,
        &src,
        &cfg_src,
        &resolver,
        None,
        &budget,
    );
    if json {
        println!("{}", serde_json::to_string_pretty(&resp).unwrap());
    } else {
        if let Some(h) = &resp.human_output {
            println!("{h}");
        }
        for e in &resp.errors {
            eprintln!("[{}] {}", e.code, e.message);
        }
        if let Some(d) = &resp.diagnostic {
            eprintln!(
                "stopped ({}): {} states generated, {} distinct, depth {}, queue {}",
                d.reason, d.states_generated, d.distinct_states, d.depth_reached, d.queue_depth
            );
            eprintln!("hint: {}", d.hint);
        }
        println!("status: {:?}", resp.status);
    }
    match resp.status {
        tlc_core::api::Status::Ok => ExitCode::SUCCESS,
        _ => ExitCode::FAILURE,
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("check") {
        return run_check_cmd(&args[1..]);
    }
    match args.as_slice() {
        [cmd, path] if cmd == "parse" => {
            let src = match std::fs::read_to_string(path) {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("error: cannot read {path}: {e}");
                    return ExitCode::FAILURE;
                }
            };
            let p = Path::new(path);
            let root_name = p.file_stem().map(|s| s.to_string_lossy().into_owned());
            let Some(root_name) = root_name else {
                eprintln!("error: cannot derive a module name from {path}");
                return ExitCode::FAILURE;
            };
            let resolver = DirResolver {
                dir: p.parent().unwrap_or_else(|| Path::new(".")).to_path_buf(),
            };
            let mut interner = Interner::new();
            match tlc_core::sem::analyze(&root_name, &src, &resolver, &mut interner) {
                Ok(a) => {
                    println!(
                        "parsed and checked module {root_name} ({} modules, {} definitions, {} variables)",
                        a.modules.len(),
                        a.defs.len(),
                        a.vars.len()
                    );
                    ExitCode::SUCCESS
                }
                Err(diags) => {
                    for d in &diags {
                        eprintln!("{d}");
                    }
                    ExitCode::FAILURE
                }
            }
        }
        [cmd, path] if cmd == "lex" => {
            let src = match std::fs::read_to_string(path) {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("error: cannot read {path}: {e}");
                    return ExitCode::FAILURE;
                }
            };
            let mut interner = Interner::new();
            let out = Lexer::lex(&src, FileId(0), &mut interner);
            for t in &out.tokens {
                println!("{}:{}\t{:?}", t.span.start.line, t.span.start.col, t.tok);
            }
            for d in &out.diags {
                eprintln!("{d}");
            }
            if out.diags.is_empty() { ExitCode::SUCCESS } else { ExitCode::FAILURE }
        }
        _ => {
            eprintln!("usage: tlc-rs <parse|lex|check> <file.tla> [check options]");
            ExitCode::FAILURE
        }
    }
}
