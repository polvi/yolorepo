//! Compress the trained splat PLY into `dist/scene.sog` with
//! `bunx @playcanvas/splat-transform`.

use crate::doctor::have;
use crate::run::run_logged;
use crate::workspace::Visit;
use anyhow::{bail, Result};
use std::path::{Path, PathBuf};
use std::process::Command;

pub fn to_sog(visit: &Visit, splat_ply: &Path) -> Result<PathBuf> {
    if !have("bunx") {
        bail!("bunx not found — install bun (https://bun.sh), bunx ships with it");
    }
    if !splat_ply.exists() {
        bail!(
            "no splat at {} — run `molemap splat` first",
            splat_ply.display()
        );
    }
    std::fs::create_dir_all(visit.dist_dir())?;
    let out = visit.dist_dir().join("scene.sog");
    run_logged(
        "bunx",
        "splat-transform",
        Command::new("bunx")
            .arg("@playcanvas/splat-transform")
            .arg(splat_ply)
            .arg(&out),
        &visit.logs_dir(),
    )?;
    if !out.exists() {
        bail!("splat-transform finished but {} is missing", out.display());
    }
    Ok(out)
}
