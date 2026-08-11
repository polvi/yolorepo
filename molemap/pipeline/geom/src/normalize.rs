//! Gravity/scale normalization of a COLMAP reconstruction.
//!
//! COLMAP models live in an arbitrary similarity frame. molemap normalizes
//! every visit into a canonical "visit frame":
//!
//! 1. **Up estimation.** Phone photos of a standing person are taken roughly
//!    level, so each camera's up vector (`R^T * (0,-1,0)`, see
//!    `types::Camera::up_world`) points near world up. We average those.
//!    Capture orbits circle the body at roughly constant heights, so the
//!    camera centers lie near horizontal planes: the normal of the best-fit
//!    plane through the centers (smallest-eigenvalue eigenvector of the
//!    center covariance) is a second, usually cleaner, up estimate. We use
//!    the plane normal when there are enough cameras and it agrees with the
//!    mean-up to within 45 degrees (sign chosen to agree with mean-up),
//!    otherwise fall back to the mean-up.
//! 2. **Rotate** so that up maps to +Y.
//! 3. **Translate** so the 5th percentile of sparse-point Y (robust "floor",
//!    resists outlier points below the feet) sits at Y = 0.
//! 4. **Scale** so the 5th..95th percentile Y span (robust body height) is 1.
//!
//! The result is `world_from_visit` mapping reconstruction coordinates into
//! the canonical frame. All downstream radii (clustering, matching) are in
//! units of body height.

use crate::types::{Camera, Mat3, Mat4, Point3D, Vec3};
use crate::umeyama::sym_eigen_3x3;

#[derive(Debug, Clone)]
pub struct Normalization {
    /// Canonical-from-reconstruction transform.
    pub world_from_visit: Mat4,
    /// Estimated world-up in reconstruction coordinates.
    pub up: Vec3,
    /// Which estimator produced `up`: "camera-ring-plane" or "mean-camera-up".
    pub up_source: &'static str,
    /// Uniform scale applied (1 / robust height).
    pub scale: f64,
}

/// Linear-interpolation percentile of a sorted slice, `p` in [0, 100].
fn percentile(sorted: &[f64], p: f64) -> f64 {
    let n = sorted.len();
    debug_assert!(n > 0);
    if n == 1 {
        return sorted[0];
    }
    let pos = (p / 100.0).clamp(0.0, 1.0) * (n - 1) as f64;
    let lo = pos.floor() as usize;
    let hi = pos.ceil() as usize;
    let frac = pos - lo as f64;
    sorted[lo] * (1.0 - frac) + sorted[hi] * frac
}

pub fn normalize(cameras: &[Camera], points: &[Point3D]) -> Result<Normalization, String> {
    if cameras.len() < 2 {
        return Err(format!(
            "normalize: need >= 2 cameras, got {}",
            cameras.len()
        ));
    }
    if points.len() < 10 {
        return Err(format!(
            "normalize: need >= 10 sparse points, got {}",
            points.len()
        ));
    }

    // 1a. Mean camera-up.
    let mean_up = cameras
        .iter()
        .fold(Vec3::ZERO, |acc, c| acc + c.up_world())
        .normalized();
    if mean_up.norm() < 0.5 {
        return Err("normalize: camera up vectors cancel out; cannot estimate gravity".into());
    }

    // 1b. Best-fit plane through camera centers.
    let mut up = mean_up;
    let mut up_source: &'static str = "mean-camera-up";
    if cameras.len() >= 6 {
        let centers: Vec<Vec3> = cameras.iter().map(|c| c.center()).collect();
        let mu = centers.iter().fold(Vec3::ZERO, |a, &b| a + b) / centers.len() as f64;
        let mut cov = [0.0f64; 9];
        for c in &centers {
            let d: [f64; 3] = (*c - mu).into();
            for r in 0..3 {
                for cc in 0..3 {
                    cov[r * 3 + cc] += d[r] * d[cc];
                }
            }
        }
        let (vals, vecs) = sym_eigen_3x3(&Mat3(cov));
        let mut min_i = 0;
        for i in 1..3 {
            if vals[i] < vals[min_i] {
                min_i = i;
            }
        }
        let mut normal = vecs.col(min_i).normalized();
        // Orbits are only "roughly" planar; require the spread within the
        // plane to dominate the out-of-plane spread before trusting it.
        let mut sorted_vals = vals;
        sorted_vals.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let planar_enough = sorted_vals[1] > 4.0 * sorted_vals[0].max(0.0);
        if planar_enough && normal.norm() > 0.5 {
            if normal.dot(mean_up) < 0.0 {
                normal = -normal; // pick the sign agreeing with mean-up
            }
            if normal.dot(mean_up) > (45.0f64).to_radians().cos() {
                up = normal;
                up_source = "camera-ring-plane";
            }
        }
    }

    // 2. Rotate up -> +Y.
    let rot = Mat3::rotation_between(up, Vec3::Y);

    // 3+4. Robust floor and height from rotated sparse Ys.
    let mut ys: Vec<f64> = points.iter().map(|p| rot.mul_vec(p.xyz).y).collect();
    ys.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let y5 = percentile(&ys, 5.0);
    let y95 = percentile(&ys, 95.0);
    let span = y95 - y5;
    if span < 1e-9 {
        return Err("normalize: sparse cloud has no vertical extent".into());
    }
    let s = 1.0 / span;

    // p' = s * (R p - y5 * Y) = s R p + (-s * y5) Y.
    let world_from_visit = Mat4::from_srt(s, &rot, Vec3::new(0.0, -s * y5, 0.0));
    Ok(Normalization {
        world_from_visit,
        up,
        up_source,
        scale: s,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Intrinsics;

    fn intr() -> Intrinsics {
        Intrinsics {
            model: "PINHOLE".into(),
            fx: 1000.0,
            fy: 1000.0,
            cx: 500.0,
            cy: 500.0,
            width: 1000,
            height: 1000,
        }
    }

    /// Build a camera at center `c` looking at `target`, with world-up `u`,
    /// in COLMAP convention (camera-from-world; rows of R are the camera
    /// axes expressed in world coordinates; +Y is down the image).
    fn look_at(id: u32, c: Vec3, target: Vec3, u: Vec3) -> Camera {
        let z = (target - c).normalized(); // camera forward
        let down = -u;
        let y = (down - z * down.dot(z)).normalized(); // camera down, orthogonal to z
        let x = y.cross(z); // right-handed: x cross y = z
        let r = Mat3([x.x, x.y, x.z, y.x, y.y, y.z, z.x, z.y, z.z]);
        // Convert R back to a quaternion via the standard branch method.
        let q = mat_to_quat(&r);
        let t = -r.mul_vec(c);
        Camera {
            id,
            name: format!("img{id}.jpg"),
            intrinsics: intr(),
            qvec: q,
            tvec: t,
        }
    }

    fn mat_to_quat(r: &Mat3) -> [f64; 4] {
        let m = |i: usize, j: usize| r.get(i, j);
        let tr = m(0, 0) + m(1, 1) + m(2, 2);
        if tr > 0.0 {
            let s = (tr + 1.0).sqrt() * 2.0;
            [
                s / 4.0,
                (m(2, 1) - m(1, 2)) / s,
                (m(0, 2) - m(2, 0)) / s,
                (m(1, 0) - m(0, 1)) / s,
            ]
        } else if m(0, 0) > m(1, 1) && m(0, 0) > m(2, 2) {
            let s = (1.0 + m(0, 0) - m(1, 1) - m(2, 2)).sqrt() * 2.0;
            [
                (m(2, 1) - m(1, 2)) / s,
                s / 4.0,
                (m(0, 1) + m(1, 0)) / s,
                (m(0, 2) + m(2, 0)) / s,
            ]
        } else if m(1, 1) > m(2, 2) {
            let s = (1.0 + m(1, 1) - m(0, 0) - m(2, 2)).sqrt() * 2.0;
            [
                (m(0, 2) - m(2, 0)) / s,
                (m(0, 1) + m(1, 0)) / s,
                s / 4.0,
                (m(1, 2) + m(2, 1)) / s,
            ]
        } else {
            let s = (1.0 + m(2, 2) - m(0, 0) - m(1, 1)).sqrt() * 2.0;
            [
                (m(1, 0) - m(0, 1)) / s,
                (m(0, 2) + m(2, 0)) / s,
                (m(1, 2) + m(2, 1)) / s,
                s / 4.0,
            ]
        }
    }

    /// Synthetic scene: a "body" cylinder of height 1.8 along an arbitrary
    /// tilted up axis, with two orbit rings of cameras around it.
    fn synthetic_scene(u: Vec3) -> (Vec<Camera>, Vec<Point3D>, Vec3) {
        let u = u.normalized();
        // Basis perpendicular to u.
        let e1 = u.cross(Vec3::X).normalized();
        let e1 = if e1.norm() < 0.5 {
            u.cross(Vec3::Z).normalized()
        } else {
            e1
        };
        let e2 = u.cross(e1);
        let base = Vec3::new(3.0, -1.0, 2.0);
        let height = 1.8;

        let mut cams = Vec::new();
        let mut id = 1;
        for &h in &[0.5, 1.3] {
            for k in 0..8 {
                let th = k as f64 / 8.0 * std::f64::consts::TAU;
                let c = base + u * h + (e1 * th.cos() + e2 * th.sin()) * 2.0;
                let target = base + u * h;
                cams.push(look_at(id, c, target, u));
                id += 1;
            }
        }
        let mut pts = Vec::new();
        let n = 200;
        for i in 0..n {
            let h = i as f64 / (n - 1) as f64 * height;
            let th = i as f64 * 2.399963; // golden-angle spiral
            let p = base + u * h + (e1 * th.cos() + e2 * th.sin()) * 0.3;
            pts.push(Point3D {
                id: i as u64,
                xyz: p,
                rgb: [128, 100, 90],
                error: 0.5,
            });
        }
        (cams, pts, u)
    }

    #[test]
    fn camera_up_world_matches_construction() {
        let u = Vec3::new(1.0, 1.0, 1.0).normalized();
        let (cams, _, _) = synthetic_scene(u);
        for c in &cams {
            assert!(c.up_world().dot(u) > 0.99, "up {:?} vs {u:?}", c.up_world());
        }
    }

    #[test]
    fn normalizes_tilted_ring_scene() {
        let true_up = Vec3::new(1.0, 2.0, 0.5);
        let (cams, pts, u) = synthetic_scene(true_up);
        let n = normalize(&cams, &pts).unwrap();

        // Estimated up agrees with the ground truth.
        assert!(
            n.up.dot(u) > 0.999,
            "up {:?} vs {:?} ({})",
            n.up,
            u,
            n.up_source
        );
        assert_eq!(n.up_source, "camera-ring-plane");

        // Up maps to +Y.
        let mapped_up = n.world_from_visit.transform_dir(u).normalized();
        assert!(mapped_up.dot(Vec3::Y) > 0.999);

        // Transformed points: 5th percentile Y at 0, robust span 1.
        let mut ys: Vec<f64> = pts
            .iter()
            .map(|p| n.world_from_visit.transform_point(p.xyz).y)
            .collect();
        ys.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let y5 = percentile(&ys, 5.0);
        let y95 = percentile(&ys, 95.0);
        assert!(y5.abs() < 1e-9, "y5 = {y5}");
        assert!((y95 - y5 - 1.0).abs() < 1e-9, "span = {}", y95 - y5);

        // Height 1.8 in the input maps to ~1/0.9 (5%..95% of a uniform
        // column spans 90% of it), so total height ~1.111.
        let total = ys.last().unwrap() - ys.first().unwrap();
        assert!((total - 1.0 / 0.9).abs() < 0.02, "total {total}");
    }

    #[test]
    fn falls_back_to_mean_up_with_few_cameras() {
        let u = Vec3::new(0.2, 1.0, -0.1).normalized();
        let (cams, pts, _) = synthetic_scene(u);
        let few = &cams[..3];
        let n = normalize(few, &pts).unwrap();
        assert_eq!(n.up_source, "mean-camera-up");
        assert!(n.up.dot(u) > 0.99);
    }

    #[test]
    fn rejects_tiny_inputs() {
        let (cams, pts, _) = synthetic_scene(Vec3::Y);
        assert!(normalize(&cams[..1], &pts).is_err());
        assert!(normalize(&cams, &pts[..5]).is_err());
    }
}
