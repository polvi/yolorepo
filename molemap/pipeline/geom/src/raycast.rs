//! Pixel -> ray -> sparse-cloud intersection.
//!
//! A detection in image space is lifted to 3D by shooting the camera ray
//! through the pixel and collecting sparse points that lie close to the ray
//! (perpendicular distance < `eps`, in front of the camera). The depth is the
//! median depth of the `k` nearest such points; the confidence is the total
//! number of supporting points.

use crate::types::{Camera, Point3D, Vec3};

/// A world-space ray with unit direction.
#[derive(Debug, Clone, Copy)]
pub struct Ray {
    pub origin: Vec3,
    pub dir: Vec3,
}

/// Result of casting a pixel ray against the sparse cloud.
#[derive(Debug, Clone, Copy)]
pub struct RayHit {
    pub point: Vec3,
    /// Number of sparse points within `eps` of the ray (confidence proxy).
    pub support: usize,
    /// Median depth along the ray.
    pub depth: f64,
}

/// Build the world-space ray through pixel `(u, v)` of `cam`.
///
/// Camera convention (COLMAP): `x_cam = R x_world + t`, pixel
/// `u = fx * X/Z + cx`, `v = fy * Y/Z + cy`. Distortion is ignored (see
/// `types::Intrinsics`).
pub fn pixel_ray(cam: &Camera, u: f64, v: f64) -> Ray {
    let d_cam = Vec3::new(
        (u - cam.intrinsics.cx) / cam.intrinsics.fx,
        (v - cam.intrinsics.cy) / cam.intrinsics.fy,
        1.0,
    )
    .normalized();
    let rt = cam.rotation().transpose();
    Ray {
        origin: cam.center(),
        dir: rt.mul_vec(d_cam).normalized(),
    }
}

/// Cast `ray` against `points`; see module docs for semantics.
pub fn cast(ray: &Ray, points: &[Point3D], eps: f64, k: usize) -> Option<RayHit> {
    // (perpendicular distance, depth) of points within eps and in front.
    let mut near: Vec<(f64, f64)> = Vec::new();
    for p in points {
        let v = p.xyz - ray.origin;
        let t = v.dot(ray.dir);
        if t <= 0.0 {
            continue;
        }
        let perp = (v - ray.dir * t).norm();
        if perp < eps {
            near.push((perp, t));
        }
    }
    if near.is_empty() {
        return None;
    }
    let support = near.len();
    near.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
    near.truncate(k.max(1));
    let mut depths: Vec<f64> = near.iter().map(|&(_, t)| t).collect();
    depths.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let depth = if depths.len() % 2 == 1 {
        depths[depths.len() / 2]
    } else {
        (depths[depths.len() / 2 - 1] + depths[depths.len() / 2]) / 2.0
    };
    Some(RayHit {
        point: ray.origin + ray.dir * depth,
        support,
        depth,
    })
}

/// Convenience: pixel -> 3D point in one call.
pub fn raycast_pixel(
    cam: &Camera,
    u: f64,
    v: f64,
    points: &[Point3D],
    eps: f64,
    k: usize,
) -> Option<RayHit> {
    cast(&pixel_ray(cam, u, v), points, eps, k)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Intrinsics;

    fn ident_cam() -> Camera {
        Camera {
            id: 1,
            name: "a.jpg".into(),
            intrinsics: Intrinsics {
                model: "PINHOLE".into(),
                fx: 100.0,
                fy: 100.0,
                cx: 50.0,
                cy: 50.0,
                width: 100,
                height: 100,
            },
            qvec: [1.0, 0.0, 0.0, 0.0],
            tvec: Vec3::ZERO,
        }
    }

    fn pt(id: u64, p: Vec3) -> Point3D {
        Point3D {
            id,
            xyz: p,
            rgb: [0, 0, 0],
            error: 0.1,
        }
    }

    #[test]
    fn center_pixel_ray_is_forward() {
        let cam = ident_cam();
        let r = pixel_ray(&cam, 50.0, 50.0);
        assert!(r.origin.norm() < 1e-12);
        assert!(r.dir.distance(Vec3::Z) < 1e-12);
    }

    #[test]
    fn finds_median_depth_of_cluster() {
        let cam = ident_cam();
        let ray = pixel_ray(&cam, 60.0, 50.0); // dir ~ (0.0995, 0, 0.995)
                                               // Three points near the ray at depths 1.9, 2.0, 2.1, small offsets.
        let mk = |t: f64, off: Vec3| pt(0, ray.origin + ray.dir * t + off);
        let points = vec![
            mk(1.9, Vec3::new(0.0, 0.005, 0.0)),
            mk(2.0, Vec3::new(-0.003, 0.0, 0.0)),
            mk(2.1, Vec3::new(0.0, -0.004, 0.0)),
            // Outliers: far off the ray and behind the camera.
            pt(1, Vec3::new(5.0, 5.0, 5.0)),
            mk(-1.5, Vec3::ZERO),
        ];
        let hit = cast(&ray, &points, 0.02, 8).unwrap();
        assert_eq!(hit.support, 3);
        // Offsets have a tiny component along the ray (~3e-4), so the median
        // depth is near, not exactly, 2.0.
        assert!((hit.depth - 2.0).abs() < 1e-3);
        assert!(hit.point.distance(ray.origin + ray.dir * 2.0) < 1e-3);
    }

    #[test]
    fn none_when_no_support() {
        let cam = ident_cam();
        let ray = pixel_ray(&cam, 50.0, 50.0);
        let points = vec![pt(0, Vec3::new(3.0, 0.0, 1.0))];
        assert!(cast(&ray, &points, 0.01, 4).is_none());
    }

    #[test]
    fn k_limits_median_but_not_support() {
        let cam = ident_cam();
        let ray = pixel_ray(&cam, 50.0, 50.0);
        // 5 supporting points; nearest-2 have depths 1.0 and 3.0.
        let mk = |t: f64, perp: f64| pt(0, ray.origin + ray.dir * t + Vec3::new(perp, 0.0, 0.0));
        let points = vec![
            mk(1.0, 0.001),
            mk(3.0, 0.002),
            mk(9.0, 0.008),
            mk(9.5, 0.009),
            mk(10.0, 0.0095),
        ];
        let hit = cast(&ray, &points, 0.02, 2).unwrap();
        assert_eq!(hit.support, 5);
        assert!((hit.depth - 2.0).abs() < 1e-9); // median of {1.0, 3.0}
    }
}
