//! `molemap doctor`: probe external tools, print found/missing with exact
//! remediation. Never installs anything; exits 0 with warnings so scripting
//! stays easy. Only `init`/`doctor`/`login`/`status` work without tools.

use crate::run::which;
use std::collections::BTreeMap;
use std::process::Command;

#[derive(Debug, Clone)]
pub struct ToolStatus {
    pub name: &'static str,
    pub found: bool,
    /// Version line / path when found.
    pub detail: String,
    pub remedy: &'static str,
    pub required: bool,
}

fn probe_version(cmd: &str, args: &[&str]) -> Option<String> {
    let out = Command::new(cmd).args(args).output().ok()?;
    let text = if out.stdout.is_empty() {
        out.stderr
    } else {
        out.stdout
    };
    let text = String::from_utf8_lossy(&text);
    text.lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .map(|s| {
            let mut s = s.to_string();
            s.truncate(80);
            s
        })
}

pub fn check_tools() -> Vec<ToolStatus> {
    let mut out = Vec::new();

    let colmap = which("colmap");
    out.push(ToolStatus {
        name: "colmap",
        found: colmap.is_some(),
        detail: colmap
            .as_ref()
            .map(|p| {
                let v = probe_version("colmap", &["help"]).unwrap_or_default();
                format!("{v} ({})", p.display())
            })
            .unwrap_or_default(),
        remedy: "brew install colmap",
        required: true,
    });

    let glomap = which("glomap");
    out.push(ToolStatus {
        name: "glomap",
        found: glomap.is_some(),
        detail: glomap.as_ref().map(|p| format!("({})", p.display())).unwrap_or_default(),
        remedy: "optional (fast global mapper for big captures): build from https://github.com/colmap/glomap",
        required: false,
    });

    let opensplat = which("opensplat");
    out.push(ToolStatus {
        name: "opensplat",
        found: opensplat.is_some(),
        detail: opensplat.as_ref().map(|p| format!("({})", p.display())).unwrap_or_default(),
        remedy: "build from https://github.com/pierotofy/OpenSplat with Metal (GPU_RUNTIME=MPS); \
                 if macOS Gatekeeper blocks libc10.dylib, run: xattr -dr com.apple.quarantine <libtorch dir>",
        required: true,
    });

    let bunx = which("bunx");
    out.push(ToolStatus {
        name: "bunx",
        found: bunx.is_some(),
        detail: bunx
            .as_ref()
            .map(|p| {
                let v = probe_version("bunx", &["--version"]).unwrap_or_default();
                format!("bun {v} ({})", p.display())
            })
            .unwrap_or_default(),
        remedy: "install bun: curl -fsSL https://bun.sh/install | bash (bunx ships with bun)",
        required: true,
    });

    let sips = std::path::Path::new("/usr/bin/sips");
    let sips_found = sips.exists() || which("sips").is_some();
    out.push(ToolStatus {
        name: "sips",
        found: sips_found,
        detail: if sips.exists() {
            "(/usr/bin/sips)".into()
        } else {
            String::new()
        },
        remedy:
            "ships with macOS; on other platforms HEIC ingest is unavailable (JPEG/PNG still work)",
        required: false,
    });

    out
}

pub fn have(tool: &str) -> bool {
    if tool == "sips" {
        return std::path::Path::new("/usr/bin/sips").exists() || which("sips").is_some();
    }
    which(tool).is_some()
}

/// Tool -> version detail map for the bundle manifest.
pub fn tool_versions() -> BTreeMap<String, String> {
    check_tools()
        .into_iter()
        .filter(|t| t.found)
        .map(|t| {
            (
                t.name.to_string(),
                if t.detail.is_empty() {
                    "present".into()
                } else {
                    t.detail
                },
            )
        })
        .collect()
}

pub fn doctor() {
    println!("molemap doctor");
    println!("--------------");
    let statuses = check_tools();
    for t in &statuses {
        if t.found {
            println!("  {:<10} FOUND    {}", t.name, t.detail);
        } else if t.required {
            println!("  {:<10} MISSING  fix: {}", t.name, t.remedy);
        } else {
            println!("  {:<10} MISSING  (optional) fix: {}", t.name, t.remedy);
        }
    }
    let missing: Vec<&ToolStatus> = statuses.iter().filter(|t| !t.found).collect();
    if missing.is_empty() {
        println!("\nAll tools present. Full pipeline available.");
    } else {
        println!(
            "\n{} tool(s) missing (warnings only, exit 0).",
            missing.len()
        );
        println!("Without them: `init`, `doctor`, `login`, `status` still work;");
        println!("`reconstruct` needs colmap, `splat` needs opensplat, `bundle` needs bunx for scene.sog.");
    }
}
