//! COLMAP structure-from-motion orchestration:
//! feature_extractor -> matcher -> mapper (colmap or glomap) ->
//! model_analyzer -> TXT export -> gravity/scale normalization (geom) ->
//! model_transformer -> normalized TXT + `dist/sparse.ply`.
//!
//! Option names verified against COLMAP 4.1.1 (`--FeatureExtraction.max_image_size`,
//! `--FeatureMatching.guided_matching`).

use crate::doctor::have;
use crate::ingest::is_image;
use crate::run::run_logged;
use crate::workspace::Visit;
use anyhow::{bail, Context, Result};
use molemap_geom as geom;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Clone, Copy, PartialEq, Eq, clap::ValueEnum)]
pub enum MatcherOpt {
    Auto,
    Sequential,
    Exhaustive,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, clap::ValueEnum)]
pub enum MapperOpt {
    Auto,
    Colmap,
    Glomap,
}

#[derive(Debug, Clone)]
pub struct SfmResult {
    pub matcher: String,
    pub mapper: String,
    pub total_images: usize,
    pub registered: usize,
    pub mean_reproj_error: f64,
    pub sparse_points: usize,
    pub world_from_visit: [f64; 16],
    pub up_source: String,
    pub scale: f64,
}

fn count_images(dir: &Path) -> usize {
    let mut n = 0;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        if let Ok(rd) = std::fs::read_dir(&d) {
            for e in rd.filter_map(|e| e.ok()) {
                let p = e.path();
                if p.is_dir() {
                    stack.push(p);
                } else if is_image(&p) {
                    n += 1;
                }
            }
        }
    }
    n
}

// model_analyzer emits glog-prefixed lines ("I2026... model.cc:446] Registered
// images: 16"), so match the stat anywhere in the line, not as a prefix.
fn parse_analyzer(output: &str) -> (Option<usize>, Option<usize>, Option<f64>) {
    fn after<'a>(line: &'a str, key: &str) -> Option<&'a str> {
        line.find(key).map(|i| line[i + key.len()..].trim())
    }
    let mut registered = None;
    let mut images = None;
    let mut err = None;
    for line in output.lines() {
        if let Some(v) = after(line, "Registered images:") {
            registered = v.parse().ok();
        } else if let Some(v) = after(line, "Mean reprojection error:") {
            err = v.trim_end_matches("px").trim().parse().ok();
        } else if let Some(v) = after(line, "Images:") {
            images = v.parse().ok();
        }
    }
    (registered.or(images), images, err)
}

pub fn print_capture_advisory() {
    eprintln!(
        "\nReconstruction struggled. Capture protocol for the next attempt:\n\
           - orbit the subject at 2-3 heights (knees, chest, head), full 360 degrees\n\
           - ~80% overlap between consecutive frames (small steps, many photos)\n\
           - subject holds breath / stays still during each orbit\n\
           - diffuse, even light; avoid harsh shadows and specular highlights\n\
           - keep some textured context (floor, furniture) in frame for anchoring\n\
           - avoid motion blur: brace the phone, use burst-free single shots\n"
    );
}

/// Run the full SfM + normalization sequence. `force` wipes previous COLMAP
/// state first.
pub fn reconstruct(
    visit: &Visit,
    matcher_opt: MatcherOpt,
    mapper_opt: MapperOpt,
    force: bool,
) -> Result<SfmResult> {
    if !have("colmap") {
        bail!("colmap not found — brew install colmap (see `molemap doctor`)");
    }
    let images = visit.images_dir();
    let total = count_images(&images);
    if total == 0 {
        bail!(
            "no images in {} — run `molemap ingest <dir>` first",
            images.display()
        );
    }

    let cdir = visit.colmap_dir();
    if force && cdir.exists() {
        std::fs::remove_dir_all(&cdir).with_context(|| format!("clear {}", cdir.display()))?;
    }
    std::fs::create_dir_all(&cdir)?;
    let logs = visit.logs_dir();
    let db = visit.database_path();

    // 1. Features.
    run_logged(
        "colmap",
        "feature_extractor",
        Command::new("colmap").args([
            "feature_extractor",
            "--database_path",
            &db.to_string_lossy(),
            "--image_path",
            &images.to_string_lossy(),
            "--ImageReader.camera_model",
            "OPENCV",
            "--ImageReader.single_camera_per_folder",
            "1",
            "--FeatureExtraction.max_image_size",
            "3200",
            "--SiftExtraction.estimate_affine_shape",
            "1",
            "--SiftExtraction.domain_size_pooling",
            "1",
        ]),
        &logs,
    )?;

    // 2. Matching: exhaustive for small captures, sequential otherwise.
    let use_exhaustive =
        matcher_opt == MatcherOpt::Exhaustive || (matcher_opt == MatcherOpt::Auto && total < 250);
    let matcher_name = if use_exhaustive {
        "exhaustive"
    } else {
        "sequential"
    };
    if use_exhaustive {
        run_logged(
            "colmap",
            "exhaustive_matcher",
            Command::new("colmap").args([
                "exhaustive_matcher",
                "--database_path",
                &db.to_string_lossy(),
                "--FeatureMatching.guided_matching",
                "1",
            ]),
            &logs,
        )?;
    } else {
        run_logged(
            "colmap",
            "sequential_matcher",
            Command::new("colmap").args([
                "sequential_matcher",
                "--database_path",
                &db.to_string_lossy(),
                "--SequentialMatching.overlap",
                "15",
                "--FeatureMatching.guided_matching",
                "1",
            ]),
            &logs,
        )?;
    }

    // 3. Mapping. glomap when explicitly requested, or in auto mode when
    // it's installed and the capture is big (>300 images).
    let want_glomap = match mapper_opt {
        MapperOpt::Glomap => {
            if !have("glomap") {
                bail!("--mapper glomap requested but glomap not found — build from https://github.com/colmap/glomap");
            }
            true
        }
        MapperOpt::Auto => have("glomap") && total > 300,
        MapperOpt::Colmap => false,
    };

    let sparse = visit.sparse_dir();
    let mut mapper_name = if want_glomap { "glomap" } else { "colmap" }.to_string();
    let mut analyzed = run_mapper(visit, &mapper_name, &db, &images, &sparse, total)?;

    // glomap fallback: below 60% registration, retry with colmap's
    // incremental mapper which is slower but more forgiving.
    if want_glomap {
        let (reg, _, _) = analyzed;
        if (reg as f64) < 0.6 * total as f64 {
            eprintln!(
                "[molemap] glomap registered only {reg}/{total} images (<60%); retrying with colmap mapper"
            );
            std::fs::remove_dir_all(&sparse).ok();
            mapper_name = "colmap".into();
            analyzed = run_mapper(visit, &mapper_name, &db, &images, &sparse, total)?;
        }
    }
    let (registered, _, mean_err) = analyzed;

    if registered < 3 || (registered as f64) < 0.3 * total as f64 {
        print_capture_advisory();
        bail!(
            "reconstruction failed: only {registered}/{total} images registered (need >= 30% and >= 3)"
        );
    }

    // 4. Export TXT and normalize (from the largest model the mapper made).
    let model = select_best_model(&sparse, &visit.logs_dir())
        .ok_or_else(|| anyhow::anyhow!("no model under {}", sparse.display()))?;
    let txt = visit.sparse_txt_dir();
    convert_model(visit, &model, &txt, "TXT", "export-txt")?;

    let parsed = geom::Model::load(&txt).map_err(anyhow::Error::msg)?;
    let cams = parsed.cameras_posed().map_err(anyhow::Error::msg)?;
    let norm = geom::normalize(&cams, &parsed.points).map_err(|e| {
        print_capture_advisory();
        anyhow::anyhow!("normalization failed: {e}")
    })?;

    // COLMAP model_transformer wants a text file with a 4x4 row-major matrix.
    let tpath = cdir.join("transform.txt");
    let m = norm.world_from_visit.0;
    let mut tbody = String::new();
    for r in 0..4 {
        tbody.push_str(&format!(
            "{} {} {} {}\n",
            m[r * 4],
            m[r * 4 + 1],
            m[r * 4 + 2],
            m[r * 4 + 3]
        ));
    }
    std::fs::write(&tpath, tbody)?;

    let sparse_norm = visit.sparse_norm_dir();
    std::fs::create_dir_all(&sparse_norm)?;
    run_logged(
        "colmap",
        "model_transformer",
        Command::new("colmap").args([
            "model_transformer",
            "--input_path",
            &model.to_string_lossy(),
            "--output_path",
            &sparse_norm.to_string_lossy(),
            "--transform_path",
            &tpath.to_string_lossy(),
        ]),
        &logs,
    )?;

    // 5. Normalized TXT (for detect/raycast) + PLY for the bundle.
    convert_model(
        visit,
        &sparse_norm,
        &visit.sparse_norm_txt_dir(),
        "TXT",
        "export-norm-txt",
    )?;
    std::fs::create_dir_all(visit.dist_dir())?;
    let ply = visit.dist_dir().join("sparse.ply");
    run_logged(
        "colmap",
        "export-ply",
        Command::new("colmap").args([
            "model_converter",
            "--input_path",
            &sparse_norm.to_string_lossy(),
            "--output_path",
            &ply.to_string_lossy(),
            "--output_type",
            "PLY",
        ]),
        &logs,
    )?;

    let norm_model = geom::Model::load(&visit.sparse_norm_txt_dir()).map_err(anyhow::Error::msg)?;
    Ok(SfmResult {
        matcher: matcher_name.to_string(),
        mapper: mapper_name,
        total_images: total,
        registered,
        mean_reproj_error: mean_err.unwrap_or(f64::NAN),
        sparse_points: norm_model.points.len(),
        world_from_visit: norm.world_from_visit.0,
        up_source: norm.up_source.to_string(),
        scale: norm.scale,
    })
}

fn run_mapper(
    visit: &Visit,
    mapper: &str,
    db: &Path,
    images: &Path,
    sparse: &PathBuf,
    total: usize,
) -> Result<(usize, Option<usize>, Option<f64>)> {
    std::fs::create_dir_all(sparse)?;
    let logs = visit.logs_dir();
    let result = run_logged(
        mapper,
        "mapper",
        Command::new(mapper).args([
            "mapper",
            "--database_path",
            &db.to_string_lossy(),
            "--image_path",
            &images.to_string_lossy(),
            "--output_path",
            &sparse.to_string_lossy(),
        ]),
        &logs,
    );
    if let Err(e) = result {
        print_capture_advisory();
        return Err(e.context(format!("{mapper} mapper failed on {total} images")));
    }
    let model = match select_best_model(&sparse, &logs) {
        Some(m) => m,
        None => {
            print_capture_advisory();
            bail!("{mapper} produced no model under {}", sparse.display());
        }
    };
    let out = run_logged(
        "colmap",
        "model_analyzer",
        Command::new("colmap").args(["model_analyzer", "--path", &model.to_string_lossy()]),
        &logs,
    )?;
    let (reg, images_n, err) = parse_analyzer(&out);
    Ok((reg.unwrap_or(0), images_n, err))
}

/// The mapper can fragment a capture into several models (sparse/0, sparse/1,
/// ...). Analyze each and return the one with the most registered images.
pub fn select_best_model(sparse: &Path, logs: &Path) -> Option<PathBuf> {
    let mut best: Option<(usize, PathBuf)> = None;
    let mut dirs: Vec<PathBuf> = std::fs::read_dir(sparse)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir() && p.file_name().is_some_and(|n| n.to_string_lossy().chars().all(|c| c.is_ascii_digit())))
        .collect();
    dirs.sort();
    for dir in dirs {
        let out = run_logged(
            "colmap",
            "model_analyzer",
            Command::new("colmap").args(["model_analyzer", "--path", &dir.to_string_lossy()]),
            logs,
        )
        .ok()?;
        let (reg, _, _) = parse_analyzer(&out);
        let reg = reg.unwrap_or(0);
        if best.as_ref().is_none_or(|(b, _)| reg > *b) {
            best = Some((reg, dir));
        }
    }
    best.map(|(_, p)| p)
}

fn convert_model(visit: &Visit, input: &Path, output: &Path, ty: &str, step: &str) -> Result<()> {
    std::fs::create_dir_all(output)?;
    run_logged(
        "colmap",
        step,
        Command::new("colmap").args([
            "model_converter",
            "--input_path",
            &input.to_string_lossy(),
            "--output_path",
            &output.to_string_lossy(),
            "--output_type",
            ty,
        ]),
        &visit.logs_dir(),
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_model_analyzer_output() {
        let out = "\
Cameras: 1
Images: 42
Registered images: 40
Points: 12345
Observations: 100000
Mean track length: 4.5
Mean observations per image: 2500
Mean reprojection error: 0.8712px
";
        let (reg, images, err) = parse_analyzer(out);
        assert_eq!(reg, Some(40));
        assert_eq!(images, Some(42));
        assert!((err.unwrap() - 0.8712).abs() < 1e-12);
    }

    #[test]
    fn analyzer_falls_back_to_images_line() {
        let out = "Cameras: 1\nImages: 12\nMean reprojection error: 1.2px\n";
        let (reg, _, err) = parse_analyzer(out);
        assert_eq!(reg, Some(12));
        assert!((err.unwrap() - 1.2).abs() < 1e-12);
    }
}
