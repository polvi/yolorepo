//! Mole candidate detection.
//!
//! Per image (sharpest N by variance-of-Laplacian):
//! 1. skin mask via the classic YCbCr threshold (Cb 77..127, Cr 133..173),
//!    box-blurred into a "skin neighborhood" so dark moles (which fail the
//!    skin threshold themselves) still count when surrounded by skin;
//! 2. dark-blob candidates: pixels darker than the local (box-filtered) mean
//!    by a contrast threshold, inside the skin neighborhood;
//! 3. connected components filtered by relative size bounds, bbox fill ratio
//!    (circularity proxy) and aspect;
//! 4. each candidate pixel is lifted to 3D by raycasting into the normalized
//!    sparse cloud (geom), then candidates are clustered across images.
//!
//! Output: `dist/detections.json` + 256px crops in `dist/crops/detected/`.

use crate::embed::Embedder;
use crate::manifest::{DetectionEntry, DetectionsFile};
use crate::workspace::Visit;
use anyhow::{bail, Context, Result};
use image::{GrayImage, RgbImage};
use imageproc::filter::box_filter;
use imageproc::region_labelling::{connected_components, Connectivity};
use molemap_geom as geom;
use std::collections::BTreeMap;

/// Analysis resolution (max dimension) for masks/blobs; crops use full res.
const ANALYSIS_DIM: u32 = 1024;
/// Images to analyze (sharpest first).
const MAX_IMAGES: usize = 40;
/// Max candidates kept per image.
const MAX_PER_IMAGE: usize = 25;
/// Luma contrast threshold: blob must be darker than local mean by this.
const DARK_THRESHOLD: i32 = 14;
/// Raycast: perpendicular eps and k-nearest, in body-height units.
const RAY_EPS: f64 = 0.02;
const RAY_K: usize = 8;
/// 3D cluster merge radius (body heights).
const CLUSTER_RADIUS: f64 = 0.02;
/// Crop size (full-res pixels).
const CROP: u32 = 256;

pub struct DetectOutcome {
    pub detections: usize,
    pub images_used: usize,
}

/// Variance of the Laplacian: standard sharpness score.
pub fn sharpness(gray: &GrayImage) -> f64 {
    let lap = imageproc::filter::laplacian_filter(gray);
    let n = (lap.width() * lap.height()) as f64;
    if n == 0.0 {
        return 0.0;
    }
    let mut sum = 0.0;
    let mut sum2 = 0.0;
    for p in lap.pixels() {
        let v = p.0[0] as f64;
        sum += v;
        sum2 += v * v;
    }
    let mean = sum / n;
    sum2 / n - mean * mean
}

/// Classic YCbCr skin threshold. 255 = skin.
pub fn skin_mask(rgb: &RgbImage) -> GrayImage {
    GrayImage::from_fn(rgb.width(), rgb.height(), |x, y| {
        let p = rgb.get_pixel(x, y).0;
        let (r, g, b) = (p[0] as f64, p[1] as f64, p[2] as f64);
        let cb = 128.0 - 0.168736 * r - 0.331264 * g + 0.5 * b;
        let cr = 128.0 + 0.5 * r - 0.418688 * g - 0.081312 * b;
        let skin = (77.0..=127.0).contains(&cb) && (133.0..=173.0).contains(&cr);
        image::Luma([if skin { 255u8 } else { 0 }])
    })
}

fn luma(rgb: &RgbImage) -> GrayImage {
    GrayImage::from_fn(rgb.width(), rgb.height(), |x, y| {
        let p = rgb.get_pixel(x, y).0;
        let v = 0.299 * p[0] as f64 + 0.587 * p[1] as f64 + 0.114 * p[2] as f64;
        image::Luma([v.round().clamp(0.0, 255.0) as u8])
    })
}

/// A per-image candidate in analysis-resolution pixel coordinates.
#[derive(Debug, Clone, Copy)]
pub struct PixelCandidate {
    pub x: f64,
    pub y: f64,
    /// 0..1, driven by local contrast and shape quality.
    pub score: f64,
}

/// Dark-blob candidate detection on an analysis-resolution RGB image.
pub fn find_candidates(rgb: &RgbImage) -> Vec<PixelCandidate> {
    let (w, h) = (rgb.width(), rgb.height());
    if w < 32 || h < 32 {
        return Vec::new();
    }
    let gray = luma(rgb);
    let skin = skin_mask(rgb);
    // Skin neighborhood: mean skin-ness in a 17x17 window.
    let skin_frac = box_filter(&skin, 8, 8);
    // Local surround luminance in a 25x25 window.
    let local_mean = box_filter(&gray, 12, 12);

    let mut dark = GrayImage::new(w, h);
    for y in 0..h {
        for x in 0..w {
            let in_skin = skin_frac.get_pixel(x, y).0[0] > 128;
            let contrast =
                local_mean.get_pixel(x, y).0[0] as i32 - gray.get_pixel(x, y).0[0] as i32;
            if in_skin && contrast > DARK_THRESHOLD {
                dark.put_pixel(x, y, image::Luma([255]));
            }
        }
    }

    let labels = connected_components(&dark, Connectivity::Eight, image::Luma([0u8]));
    #[derive(Default)]
    struct Blob {
        area: u64,
        sx: u64,
        sy: u64,
        min_x: u32,
        min_y: u32,
        max_x: u32,
        max_y: u32,
        sum_luma: u64,
        sum_local: u64,
        init: bool,
    }
    let mut blobs: BTreeMap<u32, Blob> = BTreeMap::new();
    for y in 0..h {
        for x in 0..w {
            let l = labels.get_pixel(x, y).0[0];
            if l == 0 {
                continue;
            }
            let b = blobs.entry(l).or_default();
            if !b.init {
                b.min_x = x;
                b.min_y = y;
                b.max_x = x;
                b.max_y = y;
                b.init = true;
            }
            b.area += 1;
            b.sx += x as u64;
            b.sy += y as u64;
            b.min_x = b.min_x.min(x);
            b.min_y = b.min_y.min(y);
            b.max_x = b.max_x.max(x);
            b.max_y = b.max_y.max(y);
            b.sum_luma += gray.get_pixel(x, y).0[0] as u64;
            b.sum_local += local_mean.get_pixel(x, y).0[0] as u64;
        }
    }

    let px = (w as f64) * (h as f64);
    let area_min = (4e-6 * px).max(6.0);
    let area_max = 2e-3 * px;
    let mut out = Vec::new();
    for b in blobs.values() {
        let area = b.area as f64;
        if area < area_min || area > area_max {
            continue;
        }
        // Border-touching blobs are unreliable (clothes edges, background).
        if b.min_x == 0 || b.min_y == 0 || b.max_x == w - 1 || b.max_y == h - 1 {
            continue;
        }
        let bw = (b.max_x - b.min_x + 1) as f64;
        let bh = (b.max_y - b.min_y + 1) as f64;
        let fill = area / (bw * bh);
        let aspect = bw.max(bh) / bw.min(bh);
        if fill < 0.4 || aspect > 3.0 {
            continue;
        }
        let mean_luma = b.sum_luma as f64 / area;
        let mean_local = b.sum_local as f64 / area;
        let contrast = ((mean_local - mean_luma) / 64.0).clamp(0.0, 1.0);
        let score = (contrast * 0.7 + fill * 0.3).clamp(0.0, 1.0);
        out.push(PixelCandidate {
            x: b.sx as f64 / area,
            y: b.sy as f64 / area,
            score,
        });
    }
    out.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap());
    out.truncate(MAX_PER_IMAGE);
    out
}

pub fn detect(visit: &mut Visit) -> Result<DetectOutcome> {
    let txt = visit.sparse_norm_txt_dir();
    if !txt.join("images.txt").exists() {
        bail!(
            "no normalized TXT model at {} — run `molemap reconstruct` first",
            txt.display()
        );
    }
    let model = geom::Model::load(&txt).map_err(anyhow::Error::msg)?;
    let cams = model.cameras_posed().map_err(anyhow::Error::msg)?;
    let points = &model.points;

    // Rank registered images by sharpness (at analysis resolution).
    struct Analyzed {
        cam_idx: usize,
        small: RgbImage,
        scale: f64, // full-res px per analysis px
        sharp: f64,
    }
    let mut analyzed: Vec<Analyzed> = Vec::new();
    for (ci, cam) in cams.iter().enumerate() {
        let path = visit.images_dir().join(&cam.name);
        let Ok(img) = image::open(&path) else {
            eprintln!("[detect] skipping unreadable {}", path.display());
            continue;
        };
        let rgb = img.to_rgb8();
        let (w, h) = (rgb.width(), rgb.height());
        let maxdim = w.max(h);
        let small = if maxdim > ANALYSIS_DIM {
            image::imageops::resize(
                &rgb,
                w * ANALYSIS_DIM / maxdim,
                h * ANALYSIS_DIM / maxdim,
                image::imageops::FilterType::Triangle,
            )
        } else {
            rgb
        };
        let scale = w as f64 / small.width() as f64;
        let sharp = sharpness(&luma(&small));
        analyzed.push(Analyzed {
            cam_idx: ci,
            small,
            scale,
            sharp,
        });
    }
    if analyzed.is_empty() {
        bail!(
            "no readable registered images under {}",
            visit.images_dir().display()
        );
    }
    analyzed.sort_by(|a, b| b.sharp.partial_cmp(&a.sharp).unwrap());
    analyzed.truncate(MAX_IMAGES);
    let images_used = analyzed.len();

    // Per-image candidates lifted to 3D.
    let mut cands3d: Vec<geom::Candidate> = Vec::new();
    // Remember pixel coords (full-res) per candidate for cropping later.
    let mut cand_px: Vec<(usize, f64, f64)> = Vec::new(); // (cam_idx, x, y) full-res
    for a in &analyzed {
        let cam = &cams[a.cam_idx];
        for pc in find_candidates(&a.small) {
            // Analysis px -> work-image px (== COLMAP px: COLMAP ran on the
            // same work/images files).
            let fx = pc.x * a.scale;
            let fy = pc.y * a.scale;
            if let Some(hit) = geom::raycast_pixel(cam, fx, fy, points, RAY_EPS, RAY_K) {
                let support_boost = (hit.support as f64 / 4.0).min(1.0);
                cands3d.push(geom::Candidate {
                    image_index: a.cam_idx,
                    position: hit.point,
                    confidence: pc.score * (0.5 + 0.5 * support_boost),
                });
                cand_px.push((a.cam_idx, fx, fy));
            }
        }
    }

    let mut clusters = geom::cluster(&cands3d, CLUSTER_RADIUS);
    // Require multi-view support when we have enough images to expect it.
    let min_views = if images_used >= 6 { 2 } else { 1 };
    clusters.retain(|c| c.images >= min_views);
    clusters.sort_by(|a, b| b.confidence.partial_cmp(&a.confidence).unwrap());
    clusters.truncate(200);

    // Crops + entries.
    std::fs::create_dir_all(visit.crops_dir())?;
    let embedder = Embedder::new();
    let mut entries: Vec<DetectionEntry> = Vec::new();
    for (i, cl) in clusters.iter().enumerate() {
        let id = format!("d{:03}", i + 1);
        // Up to 3 crops from distinct images, highest-confidence members first.
        let mut members: Vec<usize> = cl.members.clone();
        members.sort_by(|&a, &b| {
            cands3d[b]
                .confidence
                .partial_cmp(&cands3d[a].confidence)
                .unwrap()
        });
        let mut used_imgs = Vec::new();
        let mut crops = Vec::new();
        let mut supporting = Vec::new();
        for &m in &members {
            let (cam_idx, fx, fy) = cand_px[m];
            if used_imgs.contains(&cam_idx) {
                continue;
            }
            used_imgs.push(cam_idx);
            supporting.push(cams[cam_idx].name.clone());
            if crops.len() < 3 {
                let crop_name = if crops.is_empty() {
                    format!("{id}.jpg")
                } else {
                    format!("{id}-{}.jpg", crops.len() + 1)
                };
                let crop_path = visit.crops_dir().join(&crop_name);
                if let Err(e) = save_crop(
                    &visit.images_dir().join(&cams[cam_idx].name),
                    fx,
                    fy,
                    &crop_path,
                ) {
                    eprintln!("[detect] crop failed for {id}: {e}");
                    continue;
                }
                crops.push(format!("crops/detected/{crop_name}"));
            }
        }
        let embedding = crops
            .first()
            .and_then(|c| embedder.embed_image(&visit.dist_dir().join(c)));
        entries.push(DetectionEntry {
            id,
            position: cl.position.into(),
            confidence: (cl.confidence / 3.0).min(1.0), // ~1.0 at 3+ good views
            support: cl.members.len(),
            supporting_images: supporting,
            crops,
            embedding,
        });
    }

    let file = DetectionsFile {
        visit_id: visit.meta.visit_id.clone(),
        generated_at: chrono::Utc::now().to_rfc3339(),
        detections: entries,
    };
    std::fs::create_dir_all(visit.dist_dir())?;
    let path = visit.dist_dir().join("detections.json");
    std::fs::write(&path, serde_json::to_string_pretty(&file)?)
        .with_context(|| format!("write {}", path.display()))?;

    visit.set_stat("detections", serde_json::json!(file.detections.len()));
    visit.set_stat("detectImagesUsed", serde_json::json!(images_used));
    Ok(DetectOutcome {
        detections: file.detections.len(),
        images_used,
    })
}

fn save_crop(image_path: &std::path::Path, cx: f64, cy: f64, out: &std::path::Path) -> Result<()> {
    let img = image::open(image_path)?.to_rgb8();
    let (w, h) = (img.width(), img.height());
    let half = CROP / 2;
    let x0 = (cx as i64 - half as i64).clamp(0, (w.saturating_sub(CROP)) as i64) as u32;
    let y0 = (cy as i64 - half as i64).clamp(0, (h.saturating_sub(CROP)) as i64) as u32;
    let cw = CROP.min(w);
    let ch = CROP.min(h);
    let crop = image::imageops::crop_imm(&img, x0, y0, cw, ch).to_image();
    crop.save(out)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Skin-toned background with one dark disc: exactly the mole shape we
    /// want to find.
    fn synthetic_skin_image(w: u32, h: u32, mole: Option<(u32, u32, u32)>) -> RgbImage {
        RgbImage::from_fn(w, h, |x, y| {
            if let Some((mx, my, r)) = mole {
                let dx = x as i64 - mx as i64;
                let dy = y as i64 - my as i64;
                if dx * dx + dy * dy <= (r * r) as i64 {
                    return image::Rgb([70, 40, 30]); // dark brown mole
                }
            }
            image::Rgb([224, 172, 140]) // light skin tone
        })
    }

    #[test]
    fn skin_mask_accepts_skin_and_rejects_sky() {
        let skin = synthetic_skin_image(8, 8, None);
        let m = skin_mask(&skin);
        assert!(m.pixels().all(|p| p.0[0] == 255));
        let sky = RgbImage::from_pixel(8, 8, image::Rgb([80, 140, 255]));
        let m = skin_mask(&sky);
        assert!(m.pixels().all(|p| p.0[0] == 0));
    }

    #[test]
    fn finds_dark_disc_on_skin() {
        let img = synthetic_skin_image(256, 256, Some((130, 120, 6)));
        let cands = find_candidates(&img);
        assert_eq!(
            cands.len(),
            1,
            "expected exactly one candidate, got {cands:?}"
        );
        let c = cands[0];
        assert!(
            (c.x - 130.0).abs() < 2.0 && (c.y - 120.0).abs() < 2.0,
            "centroid off: {c:?}"
        );
        assert!(c.score > 0.5, "score too low: {}", c.score);
    }

    #[test]
    fn no_candidates_on_clean_skin() {
        let img = synthetic_skin_image(256, 256, None);
        assert!(find_candidates(&img).is_empty());
    }

    #[test]
    fn huge_dark_region_is_rejected() {
        // A dark blob way over the size bound (r=60 => ~11310 px > 0.2% of 256^2).
        let img = synthetic_skin_image(256, 256, Some((128, 128, 60)));
        assert!(find_candidates(&img).is_empty());
    }

    #[test]
    fn sharpness_orders_sharp_above_blurred() {
        let sharp_img = luma(&synthetic_skin_image(128, 128, Some((64, 64, 5))));
        let blurred = imageproc::filter::gaussian_blur_f32(&sharp_img, 3.0);
        assert!(sharpness(&sharp_img) > sharpness(&blurred));
    }
}
