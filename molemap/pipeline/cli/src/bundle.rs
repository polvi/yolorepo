//! Assemble `dist/` into an uploadable bundle with a `manifest.json`.
//!
//! Artifact ordering is deterministic (sorted by role, then path) and hashes
//! are streamed so multi-hundred-MB splats never sit in memory.

use crate::detect::sharpness;
use crate::doctor::tool_versions;
use crate::manifest::{
    AlignmentInfo, ArtifactEntry, CaptureInfo, Manifest, ReconstructionInfo, BUNDLE_VERSION,
};
use crate::workspace::Visit;
use anyhow::{bail, Context, Result};
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::{Path, PathBuf};

/// Streaming sha256; returns (hex digest, size).
pub fn sha256_file(path: &Path) -> Result<(String, u64)> {
    let mut f = std::fs::File::open(path).with_context(|| format!("open {}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 65536];
    let mut size = 0u64;
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        size += n as u64;
        hasher.update(&buf[..n]);
    }
    Ok((format!("{:x}", hasher.finalize()), size))
}

fn content_type(path: &str) -> &'static str {
    match Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
    {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "json" => "application/json",
        "ply" | "sog" => "application/octet-stream",
        "html" => "text/html",
        _ => "application/octet-stream",
    }
}

/// Pick the sharpest image from the middle third of the (name-sorted) image
/// list — mid-orbit frames face the subject squarely — and write a 1024px
/// `dist/preview.jpg`.
fn make_preview(visit: &Visit) -> Result<Option<PathBuf>> {
    let mut images = Vec::new();
    let mut stack = vec![visit.images_dir()];
    while let Some(d) = stack.pop() {
        if let Ok(rd) = std::fs::read_dir(&d) {
            for e in rd.filter_map(|e| e.ok()) {
                let p = e.path();
                if p.is_dir() {
                    stack.push(p);
                } else if crate::ingest::is_image(&p) {
                    images.push(p);
                }
            }
        }
    }
    if images.is_empty() {
        return Ok(None);
    }
    images.sort();
    let third = images.len() / 3;
    let mid = &images[third..images.len() - third.min(images.len() - third)];
    let mid = if mid.is_empty() { &images[..] } else { mid };

    let mut best: Option<(f64, &PathBuf)> = None;
    for p in mid {
        let Ok(img) = image::open(p) else { continue };
        let small = img.resize(512, 512, image::imageops::FilterType::Triangle);
        let s = sharpness(&small.to_luma8());
        if best.map_or(true, |(bs, _)| s > bs) {
            best = Some((s, p));
        }
    }
    let Some((_, path)) = best else {
        return Ok(None);
    };
    let img = image::open(path)?;
    let out = visit.dist_dir().join("preview.jpg");
    img.resize(1024, 1024, image::imageops::FilterType::Triangle)
        .to_rgb8()
        .save(&out)?;
    Ok(Some(out))
}

pub fn bundle(visit: &mut Visit) -> Result<PathBuf> {
    let dist = visit.dist_dir();
    std::fs::create_dir_all(&dist)?;
    if !dist.join("sparse.ply").exists() {
        bail!(
            "no {} — run `molemap reconstruct` first",
            dist.join("sparse.ply").display()
        );
    }

    if !dist.join("preview.jpg").exists() {
        make_preview(visit)?;
    }

    // (role, relative path) pairs for whatever exists.
    let mut items: Vec<(String, String, Option<String>)> = Vec::new(); // role, relpath, detection_id
    items.push(("sparse".into(), "sparse.ply".into(), None));
    if dist.join("scene.sog").exists() {
        items.push(("splat".into(), "scene.sog".into(), None));
    } else {
        eprintln!("[bundle] warning: no scene.sog (run `molemap splat` with opensplat installed); bundling without it");
    }
    if dist.join("preview.jpg").exists() {
        items.push(("preview".into(), "preview.jpg".into(), None));
    }
    if dist.join("detections.json").exists() {
        items.push(("detections".into(), "detections.json".into(), None));
        let crops_dir = visit.crops_dir();
        if crops_dir.exists() {
            let mut crops: Vec<_> = std::fs::read_dir(&crops_dir)?
                .filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("jpg"))
                .collect();
            crops.sort();
            for c in crops {
                let name = c.file_name().unwrap().to_string_lossy().into_owned();
                // Crop files are "<detectionId>.jpg" or "<detectionId>-N.jpg".
                let det_id = name.trim_end_matches(".jpg");
                let det_id = det_id.split('-').next().unwrap_or(det_id).to_string();
                items.push((
                    "crop".into(),
                    format!("crops/detected/{name}"),
                    Some(det_id),
                ));
            }
        }
    }
    items.sort_by(|a, b| (&a.0, &a.1).cmp(&(&b.0, &b.1)));

    let mut artifacts = Vec::new();
    for (role, rel, det_id) in items {
        let full = dist.join(&rel);
        let (sha, size) = sha256_file(&full)?;
        artifacts.push(ArtifactEntry {
            role,
            content_type: content_type(&rel).to_string(),
            path: rel,
            sha256: sha,
            size,
            detection_id: det_id,
        });
    }

    let s = &visit.meta.stats;
    let get_u = |k: &str| s.get(k).and_then(|v| v.as_u64()).unwrap_or(0) as usize;
    let world_from_visit: [f64; 16] = s
        .get("worldFromVisit")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_else(|| {
            let mut m = [0.0; 16];
            m[0] = 1.0;
            m[5] = 1.0;
            m[10] = 1.0;
            m[15] = 1.0;
            m
        });
    let regions: Vec<String> = s
        .get("regions")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();
    let manifest = Manifest {
        molemap_bundle: BUNDLE_VERSION,
        visit_id: visit.meta.visit_id.clone(),
        capture_date: visit.meta.capture_date.clone(),
        created_at: chrono::Utc::now().to_rfc3339(),
        tools: tool_versions(),
        capture: CaptureInfo {
            image_count: get_u("imageCount"),
            registered_images: get_u("registeredImages"),
            regions,
        },
        reconstruction: ReconstructionInfo {
            matcher: s
                .get("matcher")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown")
                .into(),
            mapper: s
                .get("mapper")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown")
                .into(),
            mean_reproj_error: s
                .get("meanReprojError")
                .and_then(|v| v.as_f64())
                .unwrap_or(f64::NAN),
            sparse_points: get_u("sparsePoints"),
        },
        alignment: AlignmentInfo {
            world_from_visit,
            source: "auto-gravity".into(),
            up_axis: "+y".into(),
            scale: "unit-height".into(),
        },
        artifacts,
    };

    let path = dist.join("manifest.json");
    std::fs::write(&path, serde_json::to_string_pretty(&manifest)?)
        .with_context(|| format!("write {}", path.display()))?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_known_vector() {
        let tmp = std::env::temp_dir().join(format!("molemap-sha-test-{}", std::process::id()));
        std::fs::write(&tmp, b"abc").unwrap();
        let (sha, size) = sha256_file(&tmp).unwrap();
        assert_eq!(
            sha,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(size, 3);
        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn content_types() {
        assert_eq!(content_type("crops/detected/d001.jpg"), "image/jpeg");
        assert_eq!(content_type("detections.json"), "application/json");
        assert_eq!(content_type("scene.sog"), "application/octet-stream");
    }
}
