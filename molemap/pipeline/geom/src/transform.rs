//! 4x4 / 3x3 transform helpers: composition, inversion, point application,
//! and rotation constructors.

use crate::types::{Mat3, Mat4, Vec3};

impl Mat4 {
    pub fn identity() -> Mat4 {
        let mut m = [0.0; 16];
        m[0] = 1.0;
        m[5] = 1.0;
        m[10] = 1.0;
        m[15] = 1.0;
        Mat4(m)
    }

    pub fn get(&self, r: usize, c: usize) -> f64 {
        self.0[r * 4 + c]
    }

    pub fn set(&mut self, r: usize, c: usize, v: f64) {
        self.0[r * 4 + c] = v;
    }

    pub fn mul(&self, o: &Mat4) -> Mat4 {
        let mut r = [0.0; 16];
        for i in 0..4 {
            for j in 0..4 {
                let mut s = 0.0;
                for k in 0..4 {
                    s += self.get(i, k) * o.get(k, j);
                }
                r[i * 4 + j] = s;
            }
        }
        Mat4(r)
    }

    /// Apply to a point (homogeneous, with perspective divide when w != 1).
    pub fn transform_point(&self, p: Vec3) -> Vec3 {
        let x = self.get(0, 0) * p.x + self.get(0, 1) * p.y + self.get(0, 2) * p.z + self.get(0, 3);
        let y = self.get(1, 0) * p.x + self.get(1, 1) * p.y + self.get(1, 2) * p.z + self.get(1, 3);
        let z = self.get(2, 0) * p.x + self.get(2, 1) * p.y + self.get(2, 2) * p.z + self.get(2, 3);
        let w = self.get(3, 0) * p.x + self.get(3, 1) * p.y + self.get(3, 2) * p.z + self.get(3, 3);
        if (w - 1.0).abs() < 1e-12 || w.abs() < 1e-300 {
            Vec3::new(x, y, z)
        } else {
            Vec3::new(x / w, y / w, z / w)
        }
    }

    /// Apply to a direction (rotation/scale only, no translation).
    pub fn transform_dir(&self, d: Vec3) -> Vec3 {
        Vec3::new(
            self.get(0, 0) * d.x + self.get(0, 1) * d.y + self.get(0, 2) * d.z,
            self.get(1, 0) * d.x + self.get(1, 1) * d.y + self.get(1, 2) * d.z,
            self.get(2, 0) * d.x + self.get(2, 1) * d.y + self.get(2, 2) * d.z,
        )
    }

    /// General 4x4 inverse via Gauss-Jordan elimination with partial
    /// pivoting. Returns `None` when the matrix is singular.
    pub fn inverse(&self) -> Option<Mat4> {
        // Augmented [A | I], reduce A to I.
        let mut a = [[0.0f64; 8]; 4];
        for r in 0..4 {
            for c in 0..4 {
                a[r][c] = self.get(r, c);
            }
            a[r][4 + r] = 1.0;
        }
        for col in 0..4 {
            // Pivot.
            let mut piv = col;
            for r in (col + 1)..4 {
                if a[r][col].abs() > a[piv][col].abs() {
                    piv = r;
                }
            }
            if a[piv][col].abs() < 1e-14 {
                return None;
            }
            a.swap(col, piv);
            let d = a[col][col];
            for c in 0..8 {
                a[col][c] /= d;
            }
            for r in 0..4 {
                if r != col {
                    let f = a[r][col];
                    if f != 0.0 {
                        for c in 0..8 {
                            a[r][c] -= f * a[col][c];
                        }
                    }
                }
            }
        }
        let mut out = [0.0; 16];
        for r in 0..4 {
            for c in 0..4 {
                out[r * 4 + c] = a[r][4 + c];
            }
        }
        Some(Mat4(out))
    }

    /// Similarity transform `p' = s * R * p + t` as a Mat4.
    pub fn from_srt(s: f64, rot: &Mat3, t: Vec3) -> Mat4 {
        let mut m = Mat4::identity();
        for r in 0..3 {
            for c in 0..3 {
                m.set(r, c, s * rot.get(r, c));
            }
        }
        m.set(0, 3, t.x);
        m.set(1, 3, t.y);
        m.set(2, 3, t.z);
        m
    }

    /// Embed a rotation as a Mat4.
    pub fn from_rotation(rot: &Mat3) -> Mat4 {
        Mat4::from_srt(1.0, rot, Vec3::ZERO)
    }
}

impl Mat3 {
    /// Rodrigues rotation of `angle` radians about (unnormalized) `axis`.
    pub fn rotation_axis_angle(axis: Vec3, angle: f64) -> Mat3 {
        let u = axis.normalized();
        let (s, c) = angle.sin_cos();
        let ic = 1.0 - c;
        Mat3([
            c + u.x * u.x * ic,
            u.x * u.y * ic - u.z * s,
            u.x * u.z * ic + u.y * s,
            u.y * u.x * ic + u.z * s,
            c + u.y * u.y * ic,
            u.y * u.z * ic - u.x * s,
            u.z * u.x * ic - u.y * s,
            u.z * u.y * ic + u.x * s,
            c + u.z * u.z * ic,
        ])
    }

    /// Shortest-arc rotation mapping unit vector `a` onto unit vector `b`.
    pub fn rotation_between(a: Vec3, b: Vec3) -> Mat3 {
        let a = a.normalized();
        let b = b.normalized();
        let c = a.dot(b);
        if c > 1.0 - 1e-12 {
            return Mat3::identity();
        }
        if c < -1.0 + 1e-9 {
            // 180 degrees: rotate about any axis perpendicular to a.
            let mut axis = a.cross(Vec3::X);
            if axis.norm() < 1e-6 {
                axis = a.cross(Vec3::Y);
            }
            return Mat3::rotation_axis_angle(axis, std::f64::consts::PI);
        }
        let v = a.cross(b);
        let k = 1.0 / (1.0 + c);
        // R = I + [v]x + [v]x^2 / (1 + c)
        Mat3([
            1.0 - k * (v.y * v.y + v.z * v.z),
            -v.z + k * v.x * v.y,
            v.y + k * v.x * v.z,
            v.z + k * v.x * v.y,
            1.0 - k * (v.x * v.x + v.z * v.z),
            -v.x + k * v.y * v.z,
            -v.y + k * v.x * v.z,
            v.x + k * v.y * v.z,
            1.0 - k * (v.x * v.x + v.y * v.y),
        ])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_vec_close(a: Vec3, b: Vec3, tol: f64) {
        assert!(a.distance(b) < tol, "{a:?} != {b:?}");
    }

    #[test]
    fn mat4_mul_identity() {
        let m = Mat4::from_srt(
            2.0,
            &Mat3::rotation_axis_angle(Vec3::new(1.0, 2.0, 3.0), 0.4),
            Vec3::new(1.0, -2.0, 0.5),
        );
        let i = Mat4::identity();
        assert_eq!(m.mul(&i).0, m.0);
        assert_eq!(i.mul(&m).0, m.0);
    }

    #[test]
    fn mat4_inverse_round_trip() {
        let m = Mat4::from_srt(
            1.7,
            &Mat3::rotation_axis_angle(Vec3::new(0.3, -1.0, 0.2), 1.1),
            Vec3::new(4.0, 5.0, -6.0),
        );
        let inv = m.inverse().unwrap();
        let p = Vec3::new(0.3, -0.7, 2.2);
        assert_vec_close(inv.transform_point(m.transform_point(p)), p, 1e-10);
        let ident = m.mul(&inv);
        for r in 0..4 {
            for c in 0..4 {
                let expect = if r == c { 1.0 } else { 0.0 };
                assert!((ident.get(r, c) - expect).abs() < 1e-10);
            }
        }
    }

    #[test]
    fn singular_matrix_has_no_inverse() {
        let m = Mat4([
            1.0, 2.0, 3.0, 4.0, 2.0, 4.0, 6.0, 8.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0,
        ]);
        assert!(m.inverse().is_none());
    }

    #[test]
    fn rotation_between_maps_a_to_b() {
        let cases = [
            (Vec3::new(1.0, 1.0, 1.0), Vec3::Y),
            (Vec3::Z, Vec3::X),
            (Vec3::new(0.2, -0.9, 0.1), Vec3::new(-1.0, 0.4, 0.0)),
            (Vec3::Y, Vec3::Y),
            (Vec3::Y, -Vec3::Y), // antiparallel
        ];
        for (a, b) in cases {
            let r = Mat3::rotation_between(a.normalized(), b.normalized());
            assert_vec_close(r.mul_vec(a.normalized()), b.normalized(), 1e-9);
            assert!((r.det() - 1.0).abs() < 1e-9, "det {}", r.det());
        }
    }

    #[test]
    fn quaternion_identity_and_known_rotation() {
        let r = Mat3::from_quaternion([1.0, 0.0, 0.0, 0.0]);
        assert_eq!(r.0, Mat3::identity().0);
        // 90 degrees about Z: qw = cos(45), qz = sin(45).
        let h = std::f64::consts::FRAC_1_SQRT_2;
        let r = Mat3::from_quaternion([h, 0.0, 0.0, h]);
        assert_vec_close(r.mul_vec(Vec3::X), Vec3::Y, 1e-12);
    }

    #[test]
    fn similarity_compose() {
        // p' = s2*R2*(s1*R1*p + t1) + t2 should equal (M2*M1) p.
        let r1 = Mat3::rotation_axis_angle(Vec3::X, 0.3);
        let r2 = Mat3::rotation_axis_angle(Vec3::new(0.0, 1.0, 1.0), -0.8);
        let m1 = Mat4::from_srt(2.0, &r1, Vec3::new(1.0, 0.0, -1.0));
        let m2 = Mat4::from_srt(0.5, &r2, Vec3::new(0.0, 3.0, 0.0));
        let p = Vec3::new(-1.0, 2.0, 0.25);
        let a = m2.transform_point(m1.transform_point(p));
        let b = m2.mul(&m1).transform_point(p);
        assert_vec_close(a, b, 1e-12);
    }
}
