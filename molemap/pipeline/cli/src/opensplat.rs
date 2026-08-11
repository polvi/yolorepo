//! Gaussian-splat training via OpenSplat.
//!
//! OpenSplat consumes a COLMAP-layout project directory, so we assemble one
//! from symlinks: `project/images -> work/images`, `project/sparse/0 ->
//! work/colmap/sparse-norm` (the gravity-normalized model, so the splat is
//! already in the canonical visit frame).

use crate::doctor::have;
use crate::run::run_logged;
use crate::workspace::Visit;
use anyhow::{bail, Context, Result};
use std::path::PathBuf;
use std::process::Command;

pub const DEFAULT_ITERATIONS: u32 = 15000;

fn relink(link: &PathBuf, target: &PathBuf) -> Result<()> {
    if link.symlink_metadata().is_ok() {
        std::fs::remove_file(link).or_else(|_| std::fs::remove_dir_all(link))?;
    }
    #[cfg(unix)]
    std::os::unix::fs::symlink(target, link)
        .with_context(|| format!("symlink {} -> {}", link.display(), target.display()))?;
    #[cfg(not(unix))]
    bail!("opensplat project assembly requires symlinks (unix only)");
    #[allow(unreachable_code)]
    Ok(())
}

/// Train a splat; returns the output PLY path (`work/opensplat/splat.ply`).
pub fn splat(visit: &Visit, iterations: u32) -> Result<PathBuf> {
    if !have("opensplat") {
        bail!(
            "opensplat not found — build from https://github.com/pierotofy/OpenSplat with Metal \
             (GPU_RUNTIME=MPS). If macOS Gatekeeper blocks libc10.dylib, run: \
             xattr -dr com.apple.quarantine <libtorch dir>. See `molemap doctor`."
        );
    }
    let sparse_norm = visit.sparse_norm_dir();
    if !sparse_norm.join("cameras.bin").exists() && !sparse_norm.join("cameras.txt").exists() {
        bail!(
            "no normalized model at {} — run `molemap reconstruct` first",
            sparse_norm.display()
        );
    }

    let project = visit.opensplat_dir().join("project");
    std::fs::create_dir_all(project.join("sparse"))?;
    relink(&project.join("images"), &visit.images_dir())?;
    relink(&project.join("sparse/0"), &sparse_norm)?;

    let out = visit.opensplat_dir().join("splat.ply");
    run_logged(
        "opensplat",
        "train",
        Command::new("opensplat").arg(&project).args([
            "-n",
            &iterations.to_string(),
            "-o",
            &out.to_string_lossy(),
        ]),
        &visit.logs_dir(),
    )?;
    if !out.exists() {
        bail!("opensplat finished but {} is missing", out.display());
    }
    Ok(out)
}
