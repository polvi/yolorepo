//! Umeyama similarity alignment (R, t, s) from point correspondences, plus
//! the small symmetric-eigen / SVD machinery it needs.
//!
//! Everything is dependency-free: the 3x3 SVD is built from a Jacobi
//! eigen-decomposition of `A^T A` (cyclic Jacobi rotations zeroing the
//! largest off-diagonal element until convergence), with `U` recovered as
//! `A v_i / sigma_i` and rank-2 cases completed by a cross product. This is
//! numerically fine at 3x3 scale and is validated by the round-trip tests.

use crate::types::{Mat3, Mat4, Vec3};

/// Similarity transform `p' = s * R * p + t`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Similarity {
    pub scale: f64,
    pub rotation: Mat3,
    pub translation: Vec3,
}

impl Similarity {
    pub fn apply(&self, p: Vec3) -> Vec3 {
        self.rotation.mul_vec(p) * self.scale + self.translation
    }

    pub fn to_mat4(&self) -> Mat4 {
        Mat4::from_srt(self.scale, &self.rotation, self.translation)
    }
}

/// Eigen-decomposition of a symmetric 3x3 matrix via Jacobi iterations.
/// Returns `(eigenvalues, eigenvectors)` with eigenvectors as the *columns*
/// of the returned matrix, unsorted.
pub fn sym_eigen_3x3(m: &Mat3) -> ([f64; 3], Mat3) {
    let mut a = [[0.0f64; 3]; 3];
    for r in 0..3 {
        for c in 0..3 {
            a[r][c] = m.get(r, c);
        }
    }
    let mut v = [[0.0f64; 3]; 3];
    for (i, row) in v.iter_mut().enumerate() {
        row[i] = 1.0;
    }

    for _sweep in 0..64 {
        // Largest off-diagonal element.
        let (mut p, mut q, mut max) = (0usize, 1usize, a[0][1].abs());
        for (i, j) in [(0usize, 2usize), (1, 2)] {
            if a[i][j].abs() > max {
                max = a[i][j].abs();
                p = i;
                q = j;
            }
        }
        if max < 1e-15 {
            break;
        }
        let theta = (a[q][q] - a[p][p]) / (2.0 * a[p][q]);
        let t = theta.signum() / (theta.abs() + (theta * theta + 1.0).sqrt());
        let c = 1.0 / (t * t + 1.0).sqrt();
        let s = t * c;

        // A <- J^T A J for the (p, q) Givens rotation J.
        for k in 0..3 {
            let akp = a[k][p];
            let akq = a[k][q];
            a[k][p] = c * akp - s * akq;
            a[k][q] = s * akp + c * akq;
        }
        for k in 0..3 {
            let apk = a[p][k];
            let aqk = a[q][k];
            a[p][k] = c * apk - s * aqk;
            a[q][k] = s * apk + c * aqk;
        }
        // V <- V J (columns accumulate eigenvectors).
        for row in &mut v {
            let vkp = row[p];
            let vkq = row[q];
            row[p] = c * vkp - s * vkq;
            row[q] = s * vkp + c * vkq;
        }
    }

    let vals = [a[0][0], a[1][1], a[2][2]];
    let vecs = Mat3([
        v[0][0], v[0][1], v[0][2], v[1][0], v[1][1], v[1][2], v[2][0], v[2][1], v[2][2],
    ]);
    (vals, vecs)
}

/// SVD of a 3x3 matrix: `A = U * diag(sigma) * V^T`, singular values sorted
/// descending. Requires rank >= 2 (returns Err for near rank-<2 input).
fn svd_3x3(a: &Mat3) -> Result<(Mat3, [f64; 3], Mat3), String> {
    let ata = a.transpose().mul(a);
    let (vals, vecs) = sym_eigen_3x3(&ata);
    // Sort eigenpairs by eigenvalue descending.
    let mut idx = [0usize, 1, 2];
    idx.sort_by(|&i, &j| vals[j].partial_cmp(&vals[i]).unwrap());
    let sigma: Vec<f64> = idx.iter().map(|&i| vals[i].max(0.0).sqrt()).collect();
    let v_cols: Vec<Vec3> = idx.iter().map(|&i| vecs.col(i)).collect();

    let tol = sigma[0].max(1e-300) * 1e-9;
    if sigma[1] <= tol {
        return Err("svd_3x3: input has rank < 2 (degenerate point configuration)".into());
    }
    let u0 = a.mul_vec(v_cols[0]) / sigma[0];
    let u1 = a.mul_vec(v_cols[1]) / sigma[1];
    let u2 = if sigma[2] > tol {
        a.mul_vec(v_cols[2]) / sigma[2]
    } else {
        u0.cross(u1)
    };
    let u = Mat3::from_cols(u0.normalized(), u1.normalized(), u2.normalized());
    let v = Mat3::from_cols(v_cols[0], v_cols[1], v_cols[2]);
    Ok((u, [sigma[0], sigma[1], sigma[2]], v))
}

/// Umeyama's closed-form similarity estimation: find `s, R, t` minimizing
/// `sum_i | dst_i - (s * R * src_i + t) |^2`. Needs >= 3 correspondences that
/// are not all collinear (planar sets are fine, handled by the determinant
/// correction).
pub fn umeyama(src: &[Vec3], dst: &[Vec3]) -> Result<Similarity, String> {
    if src.len() != dst.len() {
        return Err("umeyama: src/dst length mismatch".into());
    }
    let n = src.len();
    if n < 3 {
        return Err(format!("umeyama: need >= 3 correspondences, got {n}"));
    }
    let nf = n as f64;
    let mu_src = src.iter().fold(Vec3::ZERO, |a, &b| a + b) / nf;
    let mu_dst = dst.iter().fold(Vec3::ZERO, |a, &b| a + b) / nf;

    // Source variance and cross-covariance Sigma = (1/n) sum (y_c)(x_c)^T.
    let mut var_src = 0.0;
    let mut cov = [0.0f64; 9];
    for i in 0..n {
        let x = src[i] - mu_src;
        let y = dst[i] - mu_dst;
        var_src += x.dot(x);
        let xa: [f64; 3] = x.into();
        let ya: [f64; 3] = y.into();
        for r in 0..3 {
            for c in 0..3 {
                cov[r * 3 + c] += ya[r] * xa[c];
            }
        }
    }
    var_src /= nf;
    if var_src < 1e-300 {
        return Err("umeyama: source points are coincident".into());
    }
    let sigma = Mat3(cov).scale(1.0 / nf);

    let (u, d, v) = svd_3x3(&sigma)?;
    // Reflection correction: S = diag(1, 1, det(U)det(V) < 0 ? -1 : 1).
    let flip = u.det() * v.det() < 0.0;
    let s_last = if flip { -1.0 } else { 1.0 };
    let mut u_corr = u;
    if flip {
        for r in 0..3 {
            let val = u_corr.get(r, 2);
            u_corr.set(r, 2, -val);
        }
    }
    let rotation = u_corr.mul(&v.transpose());
    let scale = (d[0] + d[1] + s_last * d[2]) / var_src;
    let translation = mu_dst - rotation.mul_vec(mu_src) * scale;
    Ok(Similarity {
        scale,
        rotation,
        translation,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn apply_known(points: &[Vec3], s: f64, r: &Mat3, t: Vec3) -> Vec<Vec3> {
        points.iter().map(|&p| r.mul_vec(p) * s + t).collect()
    }

    fn sample_points() -> Vec<Vec3> {
        vec![
            Vec3::new(0.0, 0.0, 0.0),
            Vec3::new(1.0, 0.0, 0.0),
            Vec3::new(0.0, 1.5, 0.0),
            Vec3::new(0.2, -0.4, 2.0),
            Vec3::new(-1.0, 0.7, -0.5),
            Vec3::new(0.9, 0.9, 0.9),
        ]
    }

    #[test]
    fn sym_eigen_recovers_diagonal() {
        let m = Mat3([3.0, 0.0, 0.0, 0.0, -1.0, 0.0, 0.0, 0.0, 0.5]);
        let (vals, vecs) = sym_eigen_3x3(&m);
        let mut sorted = vals;
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
        assert!((sorted[0] + 1.0).abs() < 1e-12);
        assert!((sorted[1] - 0.5).abs() < 1e-12);
        assert!((sorted[2] - 3.0).abs() < 1e-12);
        // Eigenvector matrix should be orthonormal.
        let should_be_identity = vecs.transpose().mul(&vecs);
        for r in 0..3 {
            for c in 0..3 {
                let expect = if r == c { 1.0 } else { 0.0 };
                assert!((should_be_identity.get(r, c) - expect).abs() < 1e-10);
            }
        }
    }

    #[test]
    fn recovers_known_similarity() {
        let src = sample_points();
        let r = Mat3::rotation_axis_angle(Vec3::new(1.0, 2.0, 3.0), 0.7);
        let (s, t) = (2.3, Vec3::new(0.5, -1.0, 2.0));
        let dst = apply_known(&src, s, &r, t);
        let sim = umeyama(&src, &dst).unwrap();
        assert!((sim.scale - s).abs() < 1e-9, "scale {}", sim.scale);
        for i in 0..9 {
            assert!((sim.rotation.0[i] - r.0[i]).abs() < 1e-9);
        }
        assert!(sim.translation.distance(t) < 1e-9);
        // Round-trip through Mat4 too.
        let m = sim.to_mat4();
        for (&p, &q) in src.iter().zip(dst.iter()) {
            assert!(m.transform_point(p).distance(q) < 1e-9);
        }
    }

    #[test]
    fn recovers_identity() {
        let src = sample_points();
        let sim = umeyama(&src, &src).unwrap();
        assert!((sim.scale - 1.0).abs() < 1e-10);
        assert!(sim.translation.norm() < 1e-10);
        for i in 0..9 {
            assert!((sim.rotation.0[i] - Mat3::identity().0[i]).abs() < 1e-10);
        }
    }

    #[test]
    fn handles_planar_points() {
        // All source points in the z = 0 plane (covariance rank 2).
        let src = vec![
            Vec3::new(0.0, 0.0, 0.0),
            Vec3::new(2.0, 0.0, 0.0),
            Vec3::new(0.0, 1.0, 0.0),
            Vec3::new(1.3, 2.1, 0.0),
        ];
        let r = Mat3::rotation_axis_angle(Vec3::new(0.0, 1.0, 0.2), -1.2);
        let (s, t) = (0.6, Vec3::new(-2.0, 0.3, 1.1));
        let dst = apply_known(&src, s, &r, t);
        let sim = umeyama(&src, &dst).unwrap();
        assert!((sim.scale - s).abs() < 1e-9);
        for (&p, &q) in src.iter().zip(dst.iter()) {
            assert!(sim.apply(p).distance(q) < 1e-9);
        }
        assert!((sim.rotation.det() - 1.0).abs() < 1e-9);
    }

    #[test]
    fn rejects_degenerate_input() {
        // Collinear points: rank 1.
        let src = vec![Vec3::ZERO, Vec3::X, Vec3::X * 2.0];
        let dst = src.clone();
        assert!(umeyama(&src, &dst).is_err());
        assert!(umeyama(&src[..2].to_vec(), &dst[..2].to_vec()).is_err());
    }
}
