//! Java TLC oracle: invocation and `-tool` output parsing.
//!
//! TLC's `-tool` flag frames every message as
//! `@!@!@STARTMSG <code>:<severity> @!@!@` … `@!@!@ENDMSG <code> @!@!@`.
//! We parse those frames instead of scraping prose. Relevant codes from
//! `tlc2/output/EC.java`:
//!   2110 invariant violated (behavior), 2114 deadlock, 2186 finished,
//!   2190 init states generated, 2193 success, 2199 stats,
//!   2217 trace state, 2219 SANY end (parse errors precede it).

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Ok,
    InvariantViolation,
    Deadlock,
    ParseError,
    /// TLC hit a runtime evaluation error (Assert failure, comparison error,
    /// out-of-domain application…) — a legitimate conformance class.
    EvalError,
    LivenessOrUnsupported,
    Timeout,
    OtherError,
}

#[derive(Debug, Serialize)]
pub struct OracleResult {
    pub outcome: Outcome,
    pub init_states: Option<u64>,
    pub states_generated: Option<u64>,
    pub distinct_states: Option<u64>,
    pub states_left: Option<u64>,
    pub trace_len: Option<u32>,
    pub violated_name: Option<String>,
    /// Raw trace states (the `/\ x = ...` blocks of 2217 messages).
    pub trace_states: Vec<String>,
    pub exit_code: Option<i32>,
    pub raw_codes: Vec<u32>,
}

pub struct Message {
    pub code: u32,
    pub body: String,
}

pub fn parse_tool_output(out: &str) -> Vec<Message> {
    let mut msgs = Vec::new();
    let mut cur: Option<Message> = None;
    for line in out.lines() {
        if let Some(rest) = line.strip_prefix("@!@!@STARTMSG ") {
            let code = rest
                .split(&[':', ' '][..])
                .next()
                .and_then(|c| c.parse::<u32>().ok())
                .unwrap_or(0);
            cur = Some(Message { code, body: String::new() });
        } else if line.starts_with("@!@!@ENDMSG") {
            if let Some(m) = cur.take() {
                msgs.push(m);
            }
        } else if let Some(m) = cur.as_mut() {
            m.body.push_str(line);
            m.body.push('\n');
        }
    }
    msgs
}

/// Extract all base-10 numbers from a message body, in order.
fn numbers(body: &str) -> Vec<u64> {
    let mut out = Vec::new();
    let mut cur: Option<u64> = None;
    for ch in body.chars() {
        if let Some(d) = ch.to_digit(10) {
            cur = Some(cur.unwrap_or(0) * 10 + d as u64);
        } else if let Some(n) = cur.take() {
            out.push(n);
        }
    }
    if let Some(n) = cur {
        out.push(n);
    }
    out
}

pub fn interpret(msgs: &[Message], exit_code: Option<i32>, timed_out: bool) -> OracleResult {
    let mut r = OracleResult {
        outcome: Outcome::OtherError,
        init_states: None,
        states_generated: None,
        distinct_states: None,
        states_left: None,
        trace_len: None,
        violated_name: None,
        trace_states: Vec::new(),
        exit_code,
        raw_codes: msgs.iter().map(|m| m.code).collect(),
    };
    let mut saw_success = false;
    let mut saw_violation = false;
    let mut saw_deadlock = false;
    let mut saw_parse_error = false;
    let mut saw_eval_error = false;
    let mut saw_liveness = false;
    for m in msgs {
        match m.code {
            2110 => {
                saw_violation = true;
                // "Invariant <name> is violated."
                if let Some(name) = m.body.split_whitespace().nth(1) {
                    r.violated_name = Some(name.trim_end_matches('.').to_string());
                }
            }
            2114 => saw_deadlock = true,
            2190 => {
                r.init_states = numbers(&m.body).first().copied();
            }
            2193 => saw_success = true,
            2199 => {
                let ns = numbers(&m.body);
                if ns.len() >= 3 {
                    r.states_generated = Some(ns[0]);
                    r.distinct_states = Some(ns[1]);
                    r.states_left = Some(ns[2]);
                }
            }
            2217 => {
                // Body: "<n>: <action or fairness line>\n/\ x = ..."
                r.trace_states.push(m.body.trim().to_string());
            }
            // Parse/semantic failures (SANY frame + TLC parse errors).
            2171 | 2172 | 2173 | 2174 | 2175 | 2176 | 2178 | 3002 => saw_parse_error = true,
            // GENERAL evaluation error / Assert failed.
            1000 | 2132 => saw_eval_error = true,
            // Liveness machinery involved — out of scope for comparison.
            2112 | 2116 | 2264 => saw_liveness = true,
            _ => {}
        }
    }
    if !r.trace_states.is_empty() {
        r.trace_len = Some(r.trace_states.len() as u32);
    }
    r.outcome = if timed_out {
        Outcome::Timeout
    } else if saw_violation {
        Outcome::InvariantViolation
    } else if saw_deadlock {
        Outcome::Deadlock
    } else if saw_parse_error {
        Outcome::ParseError
    } else if saw_eval_error {
        Outcome::EvalError
    } else if saw_liveness && !saw_success {
        Outcome::LivenessOrUnsupported
    } else if saw_success {
        Outcome::Ok
    } else {
        Outcome::OtherError
    };
    r
}

pub fn default_jar() -> PathBuf {
    if let Ok(p) = std::env::var("TLC_JAR") {
        return PathBuf::from(p);
    }
    let home = std::env::var("HOME").unwrap_or_default();
    PathBuf::from(home).join("Downloads/tla2tools.jar")
}

/// Run Java TLC on `<module>.tla` with `<cfg>` in `dir`. Deterministic flags:
/// single worker, fixed fingerprint function index.
pub fn run_tlc(
    jar: &Path,
    dir: &Path,
    module: &str,
    cfg: &str,
    timeout: Duration,
) -> std::io::Result<OracleResult> {
    // Unique metadir per run: TLC's default `states/<timestamp>` has
    // one-second granularity and collides on back-to-back runs.
    static RUN_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let seq = RUN_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let metadir = std::env::temp_dir().join(format!(
        "tlc-diff-{}-{}-{}",
        std::process::id(),
        seq,
        module.replace(['/', '.'], "_")
    ));
    let mut cmd = Command::new("java");
    cmd.arg("-XX:+UseParallelGC")
        .arg("-cp")
        .arg(jar)
        .arg("tlc2.TLC")
        .arg("-tool")
        .arg("-workers")
        .arg("1")
        .arg("-fp")
        .arg("0")
        .arg("-metadir")
        .arg(&metadir)
        .arg("-config")
        .arg(cfg)
        .arg(module)
        .current_dir(dir)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = cmd.spawn()?;
    let start = std::time::Instant::now();
    let mut timed_out = false;
    loop {
        match child.try_wait()? {
            Some(_) => break,
            None => {
                if start.elapsed() > timeout {
                    child.kill().ok();
                    timed_out = true;
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    }
    let out = child.wait_with_output()?;
    std::fs::remove_dir_all(&metadir).ok();
    let stdout = String::from_utf8_lossy(&out.stdout);
    let msgs = parse_tool_output(&stdout);
    Ok(interpret(&msgs, out.status.code(), timed_out))
}
