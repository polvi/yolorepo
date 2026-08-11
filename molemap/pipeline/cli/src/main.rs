//! molemap — local pipeline CLI.
//!
//! Photos of a capture session ("visit") -> COLMAP sparse reconstruction ->
//! gravity/scale normalization -> Gaussian splat (OpenSplat) -> SOG
//! compression -> mole detection -> uploadable `dist/` bundle. Raw photos
//! never leave the machine; only derived artifacts in `dist/` are uploaded.

mod bundle;
mod colmap;
mod config;
mod detect;
mod doctor;
mod embed;
mod ingest;
mod manifest;
mod opensplat;
mod preview;
mod run;
mod sog;
mod upload;
mod workspace;

use anyhow::Result;
use clap::{Parser, Subcommand};
use colmap::{MapperOpt, MatcherOpt};
use std::path::PathBuf;
use std::time::Instant;
use workspace::{Stage, Visit, Workspace};

#[derive(Parser)]
#[command(
    name = "molemap",
    version,
    about = "Google Earth for the body — local capture pipeline"
)]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Create the workspace (env MOLEMAP_HOME, else <git root>/molemap/workspace, else ~/molemap).
    Init,
    /// Check external tools (colmap, glomap, opensplat, bunx, sips).
    Doctor,
    /// Copy photos into a visit: originals to raw/, JPEG working copies to work/images/.
    Ingest {
        /// Directory of photos (heic/jpg/jpeg/png).
        dir: PathBuf,
        /// Add to an existing visit instead of creating one.
        #[arg(long)]
        visit: Option<String>,
        /// Region label (e.g. left-arm); default region is "body".
        #[arg(long)]
        region: Option<String>,
    },
    /// End-to-end: SfM -> normalize -> export -> opensplat -> sog (-> detect).
    Reconstruct {
        #[arg(long)]
        visit: Option<String>,
        #[arg(long, value_enum, default_value_t = MatcherOpt::Auto)]
        matcher: MatcherOpt,
        #[arg(long, value_enum, default_value_t = MapperOpt::Auto)]
        mapper: MapperOpt,
        /// Splat training iterations.
        #[arg(long, default_value_t = opensplat::DEFAULT_ITERATIONS)]
        iterations: u32,
        /// Re-run even if already done (invalidates downstream stages).
        #[arg(long)]
        force: bool,
        /// Skip the detect stage.
        #[arg(long)]
        no_detect: bool,
    },
    /// Train the Gaussian splat and compress to dist/scene.sog.
    Splat {
        #[arg(long)]
        visit: Option<String>,
        #[arg(long, default_value_t = opensplat::DEFAULT_ITERATIONS)]
        iterations: u32,
        #[arg(long)]
        force: bool,
    },
    /// Detect mole candidates and write dist/detections.json + crops.
    Detect {
        #[arg(long)]
        visit: Option<String>,
        #[arg(long)]
        force: bool,
    },
    /// Assemble dist/ + manifest.json.
    Bundle {
        #[arg(long)]
        visit: Option<String>,
        #[arg(long)]
        force: bool,
    },
    /// Serve dist/ locally with a minimal artifact page.
    Preview {
        #[arg(long)]
        visit: Option<String>,
        #[arg(long, default_value_t = 8330)]
        port: u16,
    },
    /// Store the molemap API key (~/.config/molemap/credentials.json, 0600).
    Login,
    /// Upload derived artifacts (never raw photos) to the molemap app.
    Upload {
        #[arg(long)]
        visit: Option<String>,
    },
    /// Visits x stage x counts.
    Status,
}

fn main() {
    let cli = Cli::parse();
    if let Err(e) = dispatch(cli) {
        eprintln!("error: {e:#}");
        std::process::exit(1);
    }
}

fn dispatch(cli: Cli) -> Result<()> {
    let ws = Workspace::locate();
    match cli.cmd {
        Cmd::Init => {
            ws.init()?;
            println!("workspace ready at {}", ws.root.display());
            println!("next: `molemap doctor`, then `molemap ingest <photo dir>`");
            Ok(())
        }
        Cmd::Doctor => {
            doctor::doctor();
            Ok(())
        }
        Cmd::Ingest { dir, visit, region } => {
            ws.init()?;
            let out = ingest::ingest(&ws, &dir, visit.as_deref(), region.as_deref())?;
            println!(
                "visit {}: {} added, {} already present ({} images total)",
                out.visit.name,
                out.added,
                out.skipped,
                out.visit.stat_u64("imageCount").unwrap_or(0)
            );
            println!("next: `molemap reconstruct --visit {}`", out.visit.name);
            Ok(())
        }
        Cmd::Reconstruct {
            visit,
            matcher,
            mapper,
            iterations,
            force,
            no_detect,
        } => {
            let mut v = ws.resolve(visit.as_deref())?;
            stage_sfm(&mut v, matcher, mapper, force)?;
            // Splat + SOG: soft-fail with remediation so a machine without
            // opensplat still gets a usable sparse reconstruction.
            match stage_splat(&mut v, iterations, force) {
                Ok(()) => {}
                Err(e) => {
                    eprintln!("[molemap] splat stage skipped: {e:#}");
                    eprintln!(
                        "[molemap] rerun `molemap splat --visit {}` once opensplat is installed",
                        v.name
                    );
                }
            }
            if !no_detect {
                stage_detect(&mut v, force)?;
            }
            println!("visit {} is at stage '{}'", v.name, v.meta.stage);
            Ok(())
        }
        Cmd::Splat {
            visit,
            iterations,
            force,
        } => {
            let mut v = ws.resolve(visit.as_deref())?;
            v.require_stage(Stage::Reconstructed, "run `molemap reconstruct`")?;
            stage_splat(&mut v, iterations, force)?;
            Ok(())
        }
        Cmd::Detect { visit, force } => {
            let mut v = ws.resolve(visit.as_deref())?;
            v.require_stage(Stage::Reconstructed, "run `molemap reconstruct`")?;
            stage_detect(&mut v, force)?;
            Ok(())
        }
        Cmd::Bundle { visit, force } => {
            let mut v = ws.resolve(visit.as_deref())?;
            v.require_stage(Stage::Reconstructed, "run `molemap reconstruct`")?;
            if v.meta.stage >= Stage::Bundled && !force {
                println!("visit {} already bundled (use --force to redo)", v.name);
                return Ok(());
            }
            let t = Instant::now();
            let path = bundle::bundle(&mut v)?;
            v.record_timing("bundle", t.elapsed().as_secs_f64());
            v.meta.stage = Stage::Bundled;
            v.save()?;
            println!("bundle manifest: {}", path.display());
            Ok(())
        }
        Cmd::Preview { visit, port } => {
            let v = ws.resolve(visit.as_deref())?;
            preview::serve(&v, port)
        }
        Cmd::Login => {
            println!("Get an API key from your molemap account page (starts with mm_).");
            print!("API key: ");
            use std::io::Write;
            std::io::stdout().flush()?;
            let mut key = String::new();
            std::io::stdin().read_line(&mut key)?;
            let key = key.trim();
            upload::validate_key(key)?;
            if !key.starts_with("mm_") {
                eprintln!("warning: key does not start with mm_ — storing anyway");
            }
            let path = config::save_api_key(key)?;
            println!("stored (0600) at {}", path.display());
            Ok(())
        }
        Cmd::Upload { visit } => {
            let mut v = ws.resolve(visit.as_deref())?;
            v.require_stage(Stage::Bundled, "run `molemap bundle`")?;
            let cfg = config::load_config();
            let key = config::load_api_key()?;
            let t = Instant::now();
            upload::upload(&mut v, &cfg, &key)?;
            v.record_timing("upload", t.elapsed().as_secs_f64());
            v.meta.stage = Stage::Uploaded;
            v.save()?;
            Ok(())
        }
        Cmd::Status => {
            let visits = ws.list_visits()?;
            if visits.is_empty() {
                println!("no visits in {}", ws.visits_dir().display());
                return Ok(());
            }
            println!(
                "{:<14} {:<14} {:>7} {:>11} {:>8} {:>11}",
                "VISIT", "STAGE", "IMAGES", "REGISTERED", "POINTS", "DETECTIONS"
            );
            for v in visits {
                let n = |k: &str| {
                    v.stat_u64(k)
                        .map(|x| x.to_string())
                        .unwrap_or_else(|| "-".into())
                };
                println!(
                    "{:<14} {:<14} {:>7} {:>11} {:>8} {:>11}",
                    v.name,
                    v.meta.stage.to_string(),
                    n("imageCount"),
                    n("registeredImages"),
                    n("sparsePoints"),
                    n("detections"),
                );
            }
            Ok(())
        }
    }
}

fn stage_sfm(v: &mut Visit, matcher: MatcherOpt, mapper: MapperOpt, force: bool) -> Result<()> {
    if v.meta.stage >= Stage::Reconstructed && !force {
        println!(
            "[molemap] reconstruction already done for {} (use --force to redo)",
            v.name
        );
        return Ok(());
    }
    let t = Instant::now();
    let r = colmap::reconstruct(v, matcher, mapper, force)?;
    v.record_timing("reconstruct", t.elapsed().as_secs_f64());
    v.set_stat("registeredImages", serde_json::json!(r.registered));
    v.set_stat("imageCount", serde_json::json!(r.total_images));
    v.set_stat("meanReprojError", serde_json::json!(r.mean_reproj_error));
    v.set_stat("sparsePoints", serde_json::json!(r.sparse_points));
    v.set_stat("matcher", serde_json::json!(r.matcher));
    v.set_stat("mapper", serde_json::json!(r.mapper));
    v.set_stat(
        "worldFromVisit",
        serde_json::json!(r.world_from_visit.to_vec()),
    );
    v.set_stat("upSource", serde_json::json!(r.up_source));
    v.set_stat("normScale", serde_json::json!(r.scale));
    v.meta.stage = Stage::Reconstructed; // force implies downstream invalidation
    v.save()?;
    println!(
        "[molemap] reconstructed {}/{} images, {} points, mean reproj {:.2}px ({} mapper, up from {})",
        r.registered, r.total_images, r.sparse_points, r.mean_reproj_error, r.mapper, r.up_source
    );
    Ok(())
}

fn stage_splat(v: &mut Visit, iterations: u32, force: bool) -> Result<()> {
    if v.meta.stage >= Stage::Splatted && !force && v.dist_dir().join("scene.sog").exists() {
        println!(
            "[molemap] splat already done for {} (use --force to redo)",
            v.name
        );
        return Ok(());
    }
    let t = Instant::now();
    let ply = opensplat::splat(v, iterations)?;
    let sog_path = sog::to_sog(v, &ply)?;
    v.record_timing("splat", t.elapsed().as_secs_f64());
    v.meta
        .params
        .insert("splatIterations".into(), serde_json::json!(iterations));
    v.meta.stage = Stage::Splatted;
    v.save()?;
    println!("[molemap] splat ready: {}", sog_path.display());
    Ok(())
}

fn stage_detect(v: &mut Visit, force: bool) -> Result<()> {
    if v.meta.stage >= Stage::Detected && !force && v.dist_dir().join("detections.json").exists() {
        println!(
            "[molemap] detect already done for {} (use --force to redo)",
            v.name
        );
        return Ok(());
    }
    let t = Instant::now();
    let out = detect::detect(v)?;
    v.record_timing("detect", t.elapsed().as_secs_f64());
    v.meta.stage = Stage::Detected;
    v.save()?;
    println!(
        "[molemap] detected {} mole candidate(s) across {} image(s); see dist/detections.json",
        out.detections, out.images_used
    );
    Ok(())
}
