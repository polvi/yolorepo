//! Ingest a directory of photos into a visit.
//!
//! Originals are copied untouched into `raw/<region>/`; working copies are
//! converted to JPEG and downscaled to max 3200 px into `work/images/<region>/`
//! (HEIC via `/usr/bin/sips`; JPEG/PNG fall back to the `image` crate when
//! sips is unavailable so the pipeline stays testable off-macOS). Raw photos
//! never leave the machine: only `dist/` is ever uploaded.

use crate::doctor::have;
use crate::workspace::{Stage, Visit, Workspace};
use anyhow::{bail, Context, Result};
use std::path::{Path, PathBuf};
use std::process::Command;

pub const MAX_IMAGE_DIM: u32 = 3200;

const IMAGE_EXTS: &[&str] = &["heic", "heif", "jpg", "jpeg", "png"];

pub fn is_image(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| IMAGE_EXTS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

fn collect_images(dir: &Path) -> Result<Vec<PathBuf>> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        for entry in std::fs::read_dir(&d).with_context(|| format!("read {}", d.display()))? {
            let p = entry?.path();
            if p.is_dir() {
                stack.push(p);
            } else if is_image(&p) {
                out.push(p);
            }
        }
    }
    out.sort();
    Ok(out)
}

/// EXIF/file capture date as YYYY-MM-DD: `mdls` content-creation date first,
/// file mtime as fallback.
fn capture_date(sample: &Path) -> String {
    if let Ok(out) = Command::new("mdls")
        .args(["-raw", "-name", "kMDItemContentCreationDate"])
        .arg(sample)
        .output()
    {
        let s = String::from_utf8_lossy(&out.stdout);
        let s = s.trim();
        // Format: 2026-08-09 14:03:22 +0000
        if s.len() >= 10 && s.as_bytes()[4] == b'-' {
            return s[..10].to_string();
        }
    }
    let mtime = sample
        .metadata()
        .and_then(|m| m.modified())
        .map(chrono::DateTime::<chrono::Utc>::from)
        .unwrap_or_else(|_| chrono::Utc::now());
    mtime.format("%Y-%m-%d").to_string()
}

/// Convert one source photo into `dst` (JPEG, max 3200px).
fn convert(src: &Path, dst: &Path) -> Result<()> {
    if have("sips") {
        let out = Command::new("sips")
            .args(["-s", "format", "jpeg", "-Z", &MAX_IMAGE_DIM.to_string()])
            .arg(src)
            .arg("--out")
            .arg(dst)
            .output()
            .context("run sips")?;
        if out.status.success() && dst.exists() {
            return Ok(());
        }
        bail!(
            "sips failed on {}: {}",
            src.display(),
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    // Fallback: image crate (no HEIC support).
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if ext == "heic" || ext == "heif" {
        bail!(
            "HEIC conversion needs /usr/bin/sips (macOS); convert {} to JPEG first",
            src.display()
        );
    }
    let img = image::open(src).with_context(|| format!("open {}", src.display()))?;
    let (w, h) = (img.width(), img.height());
    let img = if w.max(h) > MAX_IMAGE_DIM {
        img.resize(
            MAX_IMAGE_DIM,
            MAX_IMAGE_DIM,
            image::imageops::FilterType::Triangle,
        )
    } else {
        img
    };
    img.to_rgb8()
        .save(dst)
        .with_context(|| format!("save {}", dst.display()))?;
    Ok(())
}

pub struct IngestOutcome {
    pub visit: Visit,
    pub added: usize,
    pub skipped: usize,
}

pub fn ingest(
    ws: &Workspace,
    dir: &Path,
    visit_id: Option<&str>,
    region: Option<&str>,
) -> Result<IngestOutcome> {
    let sources = collect_images(dir)?;
    if sources.is_empty() {
        bail!(
            "no images (heic/jpg/jpeg/png) found under {}",
            dir.display()
        );
    }

    let mut visit = match visit_id {
        Some(id) => ws.resolve(Some(id))?,
        None => ws.create_visit(&capture_date(&sources[0]))?,
    };
    visit.ensure_layout()?;

    let label = region
        .map(|r| format!("region-{r}"))
        .unwrap_or_else(|| "body".to_string());
    let raw_dir = visit.raw_dir().join(&label);
    let img_dir = visit.images_dir().join(&label);
    std::fs::create_dir_all(&raw_dir)?;
    std::fs::create_dir_all(&img_dir)?;

    let (mut added, mut skipped) = (0usize, 0usize);
    for src in &sources {
        let name = src.file_name().unwrap().to_string_lossy().into_owned();
        let raw_dst = raw_dir.join(&name);
        let stem = src.file_stem().unwrap().to_string_lossy().into_owned();
        let work_dst = img_dir.join(format!("{stem}.jpg"));
        if raw_dst.exists() && work_dst.exists() {
            skipped += 1;
            continue;
        }
        if !raw_dst.exists() {
            std::fs::copy(src, &raw_dst)
                .with_context(|| format!("copy {} -> {}", src.display(), raw_dst.display()))?;
        }
        if !work_dst.exists() {
            convert(src, &work_dst)?;
        }
        added += 1;
        if added % 10 == 0 {
            println!("  ingested {added}/{} ...", sources.len());
        }
    }

    // Refresh stats.
    let total_images = collect_images(&visit.images_dir())?.len();
    let mut regions: Vec<String> = std::fs::read_dir(visit.raw_dir())?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    regions.sort();
    visit.set_stat("imageCount", serde_json::json!(total_images));
    visit.set_stat("regions", serde_json::json!(regions));
    visit
        .meta
        .params
        .insert("maxImageSize".into(), serde_json::json!(MAX_IMAGE_DIM));
    if added > 0 {
        // New source material invalidates everything downstream.
        visit.meta.stage = Stage::Ingested;
    }
    visit.save()?;
    Ok(IngestOutcome {
        visit,
        added,
        skipped,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn image_extension_filter() {
        assert!(is_image(Path::new("a/b/IMG_1.HEIC")));
        assert!(is_image(Path::new("x.jpeg")));
        assert!(is_image(Path::new("x.png")));
        assert!(!is_image(Path::new("x.txt")));
        assert!(!is_image(Path::new("noext")));
    }

    #[test]
    fn ingest_jpeg_end_to_end() {
        let tmp = std::env::temp_dir().join(format!("molemap-ingest-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let src_dir = tmp.join("photos");
        std::fs::create_dir_all(&src_dir).unwrap();
        // Small synthetic JPEG.
        let img = image::RgbImage::from_fn(64, 48, |x, y| {
            image::Rgb([(x * 4) as u8, (y * 5) as u8, 128])
        });
        img.save(src_dir.join("IMG_0001.jpg")).unwrap();

        let ws = Workspace {
            root: tmp.join("ws"),
        };
        let out = ingest(&ws, &src_dir, None, None).unwrap();
        assert_eq!(out.added, 1);
        assert!(out.visit.raw_dir().join("body/IMG_0001.jpg").exists());
        assert!(out.visit.images_dir().join("body/IMG_0001.jpg").exists());
        assert_eq!(out.visit.stat_u64("imageCount"), Some(1));

        // Idempotent: second run skips.
        let out2 = ingest(&ws, &src_dir, Some(&out.visit.name), None).unwrap();
        assert_eq!(out2.added, 0);
        assert_eq!(out2.skipped, 1);

        // Region ingest lands in region-<name>.
        let out3 = ingest(&ws, &src_dir, Some(&out.visit.name), Some("left-arm")).unwrap();
        assert_eq!(out3.added, 1);
        assert!(out3
            .visit
            .images_dir()
            .join("region-left-arm/IMG_0001.jpg")
            .exists());
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
