//! Parser for COLMAP TXT model exports (`model_converter --output_type TXT`):
//! `cameras.txt`, `images.txt`, `points3D.txt`. Comment lines start with `#`.
//!
//! Only the TXT format is needed: the CLI always exports TXT before the
//! stages that consume the model.

use crate::types::{Camera, Intrinsics, Point3D, Vec3};
use std::collections::HashMap;
use std::path::Path;

/// Raw camera row from `cameras.txt`.
#[derive(Debug, Clone, PartialEq)]
pub struct ColmapCamera {
    pub camera_id: u32,
    pub model: String,
    pub width: u32,
    pub height: u32,
    pub params: Vec<f64>,
}

impl ColmapCamera {
    /// Reduce any COLMAP camera model to pinhole fx/fy/cx/cy
    /// (distortion parameters are dropped, see `types::Intrinsics`).
    pub fn intrinsics(&self) -> Result<Intrinsics, String> {
        let p = &self.params;
        let (fx, fy, cx, cy) = match self.model.as_str() {
            "SIMPLE_PINHOLE"
            | "SIMPLE_RADIAL"
            | "SIMPLE_RADIAL_FISHEYE"
            | "RADIAL"
            | "RADIAL_FISHEYE" => {
                if p.len() < 3 {
                    return Err(format!("camera {}: too few params", self.camera_id));
                }
                (p[0], p[0], p[1], p[2])
            }
            "PINHOLE" | "OPENCV" | "OPENCV_FISHEYE" | "FULL_OPENCV" | "FOV"
            | "THIN_PRISM_FISHEYE" => {
                if p.len() < 4 {
                    return Err(format!("camera {}: too few params", self.camera_id));
                }
                (p[0], p[1], p[2], p[3])
            }
            other => {
                return Err(format!(
                    "camera {}: unsupported model {}",
                    self.camera_id, other
                ))
            }
        };
        Ok(Intrinsics {
            model: self.model.clone(),
            fx,
            fy,
            cx,
            cy,
            width: self.width,
            height: self.height,
        })
    }
}

/// One 2D observation from the second line of an image entry.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Obs {
    pub x: f64,
    pub y: f64,
    /// -1 when the feature has no triangulated 3D point.
    pub point3d_id: i64,
}

/// One image entry (pose line + observation line) from `images.txt`.
/// Pose is camera-from-world, `qvec = [qw, qx, qy, qz]` (see `types`).
#[derive(Debug, Clone, PartialEq)]
pub struct ColmapImage {
    pub image_id: u32,
    pub qvec: [f64; 4],
    pub tvec: Vec3,
    pub camera_id: u32,
    pub name: String,
    pub observations: Vec<Obs>,
}

fn data_lines(text: &str) -> impl Iterator<Item = &str> {
    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
}

pub fn parse_cameras(text: &str) -> Result<Vec<ColmapCamera>, String> {
    let mut out = Vec::new();
    for line in data_lines(text) {
        let mut it = line.split_whitespace();
        let camera_id = it
            .next()
            .ok_or("cameras.txt: empty line")?
            .parse::<u32>()
            .map_err(|e| format!("cameras.txt camera_id: {e}"))?;
        let model = it.next().ok_or("cameras.txt: missing model")?.to_string();
        let width = it
            .next()
            .ok_or("cameras.txt: missing width")?
            .parse::<u32>()
            .map_err(|e| format!("cameras.txt width: {e}"))?;
        let height = it
            .next()
            .ok_or("cameras.txt: missing height")?
            .parse::<u32>()
            .map_err(|e| format!("cameras.txt height: {e}"))?;
        let params = it
            .map(|t| {
                t.parse::<f64>()
                    .map_err(|e| format!("cameras.txt param: {e}"))
            })
            .collect::<Result<Vec<f64>, String>>()?;
        out.push(ColmapCamera {
            camera_id,
            model,
            width,
            height,
            params,
        });
    }
    Ok(out)
}

pub fn parse_images(text: &str) -> Result<Vec<ColmapImage>, String> {
    // images.txt alternates: pose line, observations line. The observations
    // line may be empty (an image with zero observations), which after
    // trimming is indistinguishable from a blank separator, so we treat any
    // line whose first token parses as an integer *and* which has >= 10
    // fields as the next pose line.
    let mut out: Vec<ColmapImage> = Vec::new();
    let mut expecting_obs = false;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('#') {
            continue;
        }
        if trimmed.is_empty() {
            if expecting_obs {
                // Empty observation line for the previous image.
                expecting_obs = false;
            }
            continue;
        }
        if expecting_obs {
            let toks: Vec<&str> = trimmed.split_whitespace().collect();
            if toks.len() % 3 != 0 {
                return Err(format!(
                    "images.txt: observation line for image {} has {} tokens (not divisible by 3)",
                    out.last().map(|i| i.image_id).unwrap_or(0),
                    toks.len()
                ));
            }
            let img = out.last_mut().unwrap();
            for chunk in toks.chunks(3) {
                img.observations.push(Obs {
                    x: chunk[0]
                        .parse()
                        .map_err(|e| format!("images.txt obs x: {e}"))?,
                    y: chunk[1]
                        .parse()
                        .map_err(|e| format!("images.txt obs y: {e}"))?,
                    point3d_id: chunk[2]
                        .parse()
                        .map_err(|e| format!("images.txt obs point3d_id: {e}"))?,
                });
            }
            expecting_obs = false;
        } else {
            let toks: Vec<&str> = trimmed.split_whitespace().collect();
            if toks.len() < 10 {
                return Err(format!(
                    "images.txt: pose line has {} fields, need 10",
                    toks.len()
                ));
            }
            let f = |i: usize| -> Result<f64, String> {
                toks[i]
                    .parse()
                    .map_err(|e| format!("images.txt field {i}: {e}"))
            };
            out.push(ColmapImage {
                image_id: toks[0]
                    .parse()
                    .map_err(|e| format!("images.txt image_id: {e}"))?,
                qvec: [f(1)?, f(2)?, f(3)?, f(4)?],
                tvec: Vec3::new(f(5)?, f(6)?, f(7)?),
                camera_id: toks[8]
                    .parse()
                    .map_err(|e| format!("images.txt camera_id: {e}"))?,
                // Image names may contain spaces in principle; COLMAP forbids
                // them in practice, so we join the remainder defensively.
                name: toks[9..].join(" "),
                observations: Vec::new(),
            });
            expecting_obs = true;
        }
    }
    Ok(out)
}

pub fn parse_points3d(text: &str) -> Result<Vec<Point3D>, String> {
    let mut out = Vec::new();
    for line in data_lines(text) {
        let toks: Vec<&str> = line.split_whitespace().collect();
        if toks.len() < 8 {
            return Err(format!(
                "points3D.txt: line has {} fields, need >= 8",
                toks.len()
            ));
        }
        let f = |i: usize| -> Result<f64, String> {
            toks[i]
                .parse()
                .map_err(|e| format!("points3D.txt field {i}: {e}"))
        };
        let b = |i: usize| -> Result<u8, String> {
            toks[i]
                .parse()
                .map_err(|e| format!("points3D.txt rgb {i}: {e}"))
        };
        out.push(Point3D {
            id: toks[0]
                .parse()
                .map_err(|e| format!("points3D.txt id: {e}"))?,
            xyz: Vec3::new(f(1)?, f(2)?, f(3)?),
            rgb: [b(4)?, b(5)?, b(6)?],
            error: f(7)?,
            // Track elements (image_id, point2d_idx pairs) are ignored.
        });
    }
    Ok(out)
}

/// A parsed TXT model directory.
#[derive(Debug, Clone)]
pub struct Model {
    pub cameras: Vec<ColmapCamera>,
    pub images: Vec<ColmapImage>,
    pub points: Vec<Point3D>,
}

impl Model {
    pub fn parse(cameras_txt: &str, images_txt: &str, points_txt: &str) -> Result<Model, String> {
        Ok(Model {
            cameras: parse_cameras(cameras_txt)?,
            images: parse_images(images_txt)?,
            points: parse_points3d(points_txt)?,
        })
    }

    /// Load `cameras.txt` / `images.txt` / `points3D.txt` from a directory.
    pub fn load(dir: &Path) -> Result<Model, String> {
        let read = |name: &str| -> Result<String, String> {
            std::fs::read_to_string(dir.join(name))
                .map_err(|e| format!("read {}: {e}", dir.join(name).display()))
        };
        Model::parse(
            &read("cameras.txt")?,
            &read("images.txt")?,
            &read("points3D.txt")?,
        )
    }

    /// Combine images with their intrinsics into posed `Camera`s.
    pub fn cameras_posed(&self) -> Result<Vec<Camera>, String> {
        let by_id: HashMap<u32, &ColmapCamera> =
            self.cameras.iter().map(|c| (c.camera_id, c)).collect();
        self.images
            .iter()
            .map(|img| {
                let cam = by_id.get(&img.camera_id).ok_or(format!(
                    "image {} references unknown camera {}",
                    img.name, img.camera_id
                ))?;
                Ok(Camera {
                    id: img.image_id,
                    name: img.name.clone(),
                    intrinsics: cam.intrinsics()?,
                    qvec: img.qvec,
                    tvec: img.tvec,
                })
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CAMERAS: &str = "\
# Camera list with one line of data per camera:
#   CAMERA_ID, MODEL, WIDTH, HEIGHT, PARAMS[]
# Number of cameras: 2
1 OPENCV 3200 2400 2880.0 2880.0 1600.0 1200.0 0.01 -0.002 0.0001 0.0002
2 SIMPLE_RADIAL 1000 800 900.5 500.0 400.0 0.05
";

    const IMAGES: &str = "\
# Image list with two lines of data per image:
#   IMAGE_ID, QW, QX, QY, QZ, TX, TY, TZ, CAMERA_ID, NAME
#   POINTS2D[] as (X, Y, POINT3D_ID)
1 1.0 0.0 0.0 0.0 0.0 0.0 3.0 1 body/IMG_0001.jpg
100.5 200.25 1 300.0 400.0 -1
2 0.7071067811865476 0.0 0.0 0.7071067811865476 0.1 -0.2 2.5 2 body/IMG_0002.jpg

";

    const POINTS: &str = "\
# 3D point list with one line of data per point:
#   POINT3D_ID, X, Y, Z, R, G, B, ERROR, TRACK[] as (IMAGE_ID, POINT2D_IDX)
1 0.5 1.2 -0.3 200 150 120 0.75 1 0 2 1
7 -0.1 0.2 0.3 10 20 30 1.5
";

    #[test]
    fn parses_cameras() {
        let cams = parse_cameras(CAMERAS).unwrap();
        assert_eq!(cams.len(), 2);
        assert_eq!(cams[0].model, "OPENCV");
        assert_eq!(cams[0].width, 3200);
        let i = cams[0].intrinsics().unwrap();
        assert_eq!((i.fx, i.fy, i.cx, i.cy), (2880.0, 2880.0, 1600.0, 1200.0));
        let i2 = cams[1].intrinsics().unwrap();
        // SIMPLE_RADIAL: f, cx, cy
        assert_eq!((i2.fx, i2.fy, i2.cx, i2.cy), (900.5, 900.5, 500.0, 400.0));
    }

    #[test]
    fn parses_images_with_and_without_observations() {
        let imgs = parse_images(IMAGES).unwrap();
        assert_eq!(imgs.len(), 2);
        assert_eq!(imgs[0].name, "body/IMG_0001.jpg");
        assert_eq!(imgs[0].observations.len(), 2);
        assert_eq!(imgs[0].observations[0].x, 100.5);
        assert_eq!(imgs[0].observations[0].point3d_id, 1);
        assert_eq!(imgs[0].observations[1].point3d_id, -1);
        assert_eq!(imgs[1].observations.len(), 0);
        assert_eq!(imgs[1].camera_id, 2);
    }

    #[test]
    fn camera_center_from_identity_rotation() {
        let imgs = parse_images(IMAGES).unwrap();
        let cams = parse_cameras(CAMERAS).unwrap();
        let model = Model {
            cameras: cams,
            images: imgs,
            points: vec![],
        };
        let posed = model.cameras_posed().unwrap();
        // q = identity, t = (0,0,3) => C = -R^T t = (0,0,-3).
        let c = posed[0].center();
        assert!(c.distance(crate::types::Vec3::new(0.0, 0.0, -3.0)) < 1e-12);
    }

    #[test]
    fn parses_points() {
        let pts = parse_points3d(POINTS).unwrap();
        assert_eq!(pts.len(), 2);
        assert_eq!(pts[0].id, 1);
        assert_eq!(pts[0].rgb, [200, 150, 120]);
        assert_eq!(pts[0].error, 0.75);
        assert_eq!(pts[1].xyz, crate::types::Vec3::new(-0.1, 0.2, 0.3));
    }
}
