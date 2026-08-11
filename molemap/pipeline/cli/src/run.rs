//! External tool runner: streams stdout/stderr to the console (prefixed with
//! the tool name) and to `work/logs/<tool>-<step>.log`, and returns the
//! combined output for parsing.

use anyhow::{Context, Result};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

/// Failure of an external tool, carrying enough context to debug.
#[derive(Debug)]
pub struct ToolFailure {
    pub tool: String,
    pub step: String,
    pub code: Option<i32>,
    pub log_path: PathBuf,
}

impl std::fmt::Display for ToolFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{} failed at step '{}' (exit code {}) — full log: {}",
            self.tool,
            self.step,
            self.code
                .map(|c| c.to_string())
                .unwrap_or_else(|| "killed".into()),
            self.log_path.display()
        )
    }
}

impl std::error::Error for ToolFailure {}

/// Run `cmd`, teeing output. Returns combined stdout+stderr on success.
pub fn run_logged(tool: &str, step: &str, cmd: &mut Command, log_dir: &Path) -> Result<String> {
    std::fs::create_dir_all(log_dir).with_context(|| format!("create {}", log_dir.display()))?;
    let log_path = log_dir.join(format!("{tool}-{step}.log"));
    let log_file = std::fs::File::create(&log_path)
        .with_context(|| format!("create {}", log_path.display()))?;
    let log = Arc::new(Mutex::new(log_file));
    let collected = Arc::new(Mutex::new(String::new()));

    println!("[{tool}] $ {}", format_cmd(cmd));
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| {
            format!("failed to launch '{tool}' — is it installed? (see `molemap doctor`)")
        })?;

    let mut handles = Vec::new();
    for stream in [
        child
            .stdout
            .take()
            .map(|s| Box::new(s) as Box<dyn std::io::Read + Send>),
        child
            .stderr
            .take()
            .map(|s| Box::new(s) as Box<dyn std::io::Read + Send>),
    ]
    .into_iter()
    .flatten()
    {
        let tool = tool.to_string();
        let log = Arc::clone(&log);
        let collected = Arc::clone(&collected);
        handles.push(std::thread::spawn(move || {
            let reader = BufReader::new(stream);
            for line in reader.lines().map_while(|l| l.ok()) {
                println!("[{tool}] {line}");
                if let Ok(mut f) = log.lock() {
                    let _ = writeln!(f, "{line}");
                }
                if let Ok(mut c) = collected.lock() {
                    c.push_str(&line);
                    c.push('\n');
                }
            }
        }));
    }
    for h in handles {
        let _ = h.join();
    }
    let status = child.wait().context("wait for child")?;
    let output = collected.lock().map(|c| c.clone()).unwrap_or_default();
    if !status.success() {
        return Err(ToolFailure {
            tool: tool.to_string(),
            step: step.to_string(),
            code: status.code(),
            log_path,
        }
        .into());
    }
    Ok(output)
}

fn format_cmd(cmd: &Command) -> String {
    let mut s = cmd.get_program().to_string_lossy().into_owned();
    for a in cmd.get_args() {
        s.push(' ');
        s.push_str(&a.to_string_lossy());
    }
    s
}

/// Locate an executable on PATH.
pub fn which(tool: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let cand = dir.join(tool);
        if is_executable(&cand) {
            return Some(cand);
        }
    }
    None
}

fn is_executable(p: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        p.is_file()
            && p.metadata()
                .map(|m| m.permissions().mode() & 0o111 != 0)
                .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        p.is_file()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runs_and_captures_output() {
        let tmp = std::env::temp_dir().join(format!("molemap-run-test-{}", std::process::id()));
        let out = run_logged("echo", "hello", Command::new("echo").arg("hi there"), &tmp).unwrap();
        assert_eq!(out.trim(), "hi there");
        let logged = std::fs::read_to_string(tmp.join("echo-hello.log")).unwrap();
        assert_eq!(logged.trim(), "hi there");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn failure_carries_tool_and_log_path() {
        let tmp = std::env::temp_dir().join(format!("molemap-run-fail-{}", std::process::id()));
        let err = run_logged(
            "sh",
            "fail",
            Command::new("sh").args(["-c", "echo boom; exit 3"]),
            &tmp,
        )
        .unwrap_err();
        let tf = err.downcast_ref::<ToolFailure>().expect("ToolFailure");
        assert_eq!(tf.tool, "sh");
        assert_eq!(tf.code, Some(3));
        assert!(tf.log_path.ends_with("sh-fail.log"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn which_finds_sh() {
        assert!(which("sh").is_some());
        assert!(which("definitely-not-a-real-tool-xyz").is_none());
    }
}
