//! tlc-diff: differential-testing harness.
//!
//! Runs Java TLC (`-tool -workers 1 -fp 0`) as the correctness oracle and —
//! once the Rust checker lands — compares tlc-rs against it per case.
//!
//! Usage:
//!   tlc-diff oracle <Spec.tla> [Spec.cfg]     run + print parsed oracle JSON
//!   tlc-diff sweep <cases-root>               oracle every .tla/.cfg pair under root
//!
//! `TLC_JAR` selects the jar (default ~/Downloads/tla2tools.jar).

mod compare;
mod oracle;

use oracle::{default_jar, run_tlc};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Duration;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.as_slice() {
        [cmd, tla] if cmd == "oracle" => oracle_one(Path::new(tla), None),
        [cmd, tla, cfg] if cmd == "oracle" => oracle_one(Path::new(tla), Some(cfg)),
        [cmd, root] if cmd == "sweep" => sweep(Path::new(root)),
        [cmd, root] => {
            if cmd == "compare" {
                return compare::compare(Path::new(root), None, 60);
            }
            usage()
        }
        [cmd, root, filter] if cmd == "compare" => {
            compare::compare(Path::new(root), Some(filter), 60)
        }
        _ => usage(),
    }
}

fn usage() -> ExitCode {
    eprintln!(
        "usage: tlc-diff oracle <Spec.tla> [Spec.cfg] | tlc-diff sweep <cases-root> | \
         tlc-diff compare <cases-root> [filter]"
    );
    ExitCode::FAILURE
}

fn oracle_one(tla: &Path, cfg: Option<&str>) -> ExitCode {
    let jar = default_jar();
    if !jar.exists() {
        eprintln!("error: oracle jar not found at {} (set TLC_JAR)", jar.display());
        return ExitCode::FAILURE;
    }
    let dir = match tla.parent() {
        Some(d) if !d.as_os_str().is_empty() => d,
        _ => Path::new("."),
    };
    let module = tla.file_name().unwrap().to_string_lossy();
    let cfg_owned;
    let cfg = match cfg {
        Some(c) => c,
        None => {
            cfg_owned = tla.with_extension("cfg");
            match cfg_owned.file_name() {
                Some(f) => {
                    let f = f.to_string_lossy().into_owned();
                    if !dir.join(&f).exists() {
                        eprintln!("error: no cfg given and {} not found", cfg_owned.display());
                        return ExitCode::FAILURE;
                    }
                    Box::leak(f.into_boxed_str())
                }
                None => {
                    eprintln!("error: bad path");
                    return ExitCode::FAILURE;
                }
            }
        }
    };
    match run_tlc(&jar, dir, &module, cfg, Duration::from_secs(60)) {
        Ok(r) => {
            println!("{}", serde_json::to_string_pretty(&r).unwrap());
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("error running oracle: {e}");
            ExitCode::FAILURE
        }
    }
}

fn sweep(root: &Path) -> ExitCode {
    let jar = default_jar();
    if !jar.exists() {
        eprintln!("error: oracle jar not found at {} (set TLC_JAR)", jar.display());
        return ExitCode::FAILURE;
    }
    let mut cases: Vec<PathBuf> = Vec::new();
    collect_cases(root, &mut cases);
    cases.sort();
    println!("{} candidate cases", cases.len());
    let mut ok = 0usize;
    for tla in &cases {
        let dir = match tla.parent() {
            Some(d) if !d.as_os_str().is_empty() => d,
            _ => Path::new("."),
        };
        let module = tla.file_name().unwrap().to_string_lossy();
        let cfg = tla.with_extension("cfg");
        let cfg_name = cfg.file_name().unwrap().to_string_lossy();
        match run_tlc(&jar, dir, &module, &cfg_name, Duration::from_secs(60)) {
            Ok(r) => {
                println!(
                    "{}\t{:?}\tgen={:?} distinct={:?} trace={:?}",
                    tla.display(),
                    r.outcome,
                    r.states_generated,
                    r.distinct_states,
                    r.trace_len
                );
                ok += 1;
            }
            Err(e) => println!("{}\tERROR\t{e}", tla.display()),
        }
    }
    println!("oracled {ok}/{} cases", cases.len());
    ExitCode::SUCCESS
}

fn collect_cases(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for entry in rd.flatten() {
        let p = entry.path();
        if p.is_dir() {
            collect_cases(&p, out);
        } else if p.extension().is_some_and(|e| e == "tla") && p.with_extension("cfg").exists() {
            out.push(p);
        }
    }
}
