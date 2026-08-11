//! Core geometric types.
//!
//! # Conventions
//!
//! * `Mat3` is a row-major `[f64; 9]`, `Mat4` a row-major `[f64; 16]`.
//! * COLMAP stores image poses in `images.txt` as **camera-from-world**:
//!   `x_cam = R * x_world + t`, with the rotation given as a unit quaternion
//!   `QW QX QY QZ` and translation `TX TY TZ`. The camera center in world
//!   coordinates is therefore `C = -R^T * t`.
//! * COLMAP camera axes: +X right, +Y down, +Z forward (into the scene).
//!   The camera's "up" direction expressed in world coordinates is
//!   `R^T * (0, -1, 0)`, i.e. the negated second row of `R`.
//! * `Vec3` serializes as a 3-element JSON array, `Mat3`/`Mat4` as flat
//!   row-major arrays, so the types interop directly with the worker's TS.

use serde::{Deserialize, Serialize};
use std::ops::{Add, Div, Mul, Neg, Sub};

/// 3D vector, `f64` components. Serializes as `[x, y, z]`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(from = "[f64; 3]", into = "[f64; 3]")]
pub struct Vec3 {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

impl From<[f64; 3]> for Vec3 {
    fn from(a: [f64; 3]) -> Self {
        Vec3::new(a[0], a[1], a[2])
    }
}

impl From<Vec3> for [f64; 3] {
    fn from(v: Vec3) -> Self {
        [v.x, v.y, v.z]
    }
}

impl Vec3 {
    pub const ZERO: Vec3 = Vec3 {
        x: 0.0,
        y: 0.0,
        z: 0.0,
    };
    pub const X: Vec3 = Vec3 {
        x: 1.0,
        y: 0.0,
        z: 0.0,
    };
    pub const Y: Vec3 = Vec3 {
        x: 0.0,
        y: 1.0,
        z: 0.0,
    };
    pub const Z: Vec3 = Vec3 {
        x: 0.0,
        y: 0.0,
        z: 1.0,
    };

    pub fn new(x: f64, y: f64, z: f64) -> Self {
        Vec3 { x, y, z }
    }

    pub fn dot(self, o: Vec3) -> f64 {
        self.x * o.x + self.y * o.y + self.z * o.z
    }

    pub fn cross(self, o: Vec3) -> Vec3 {
        Vec3::new(
            self.y * o.z - self.z * o.y,
            self.z * o.x - self.x * o.z,
            self.x * o.y - self.y * o.x,
        )
    }

    pub fn norm(self) -> f64 {
        self.dot(self).sqrt()
    }

    pub fn normalized(self) -> Vec3 {
        let n = self.norm();
        if n < 1e-300 {
            Vec3::ZERO
        } else {
            self / n
        }
    }

    pub fn distance(self, o: Vec3) -> f64 {
        (self - o).norm()
    }
}

impl Add for Vec3 {
    type Output = Vec3;
    fn add(self, o: Vec3) -> Vec3 {
        Vec3::new(self.x + o.x, self.y + o.y, self.z + o.z)
    }
}

impl Sub for Vec3 {
    type Output = Vec3;
    fn sub(self, o: Vec3) -> Vec3 {
        Vec3::new(self.x - o.x, self.y - o.y, self.z - o.z)
    }
}

impl Mul<f64> for Vec3 {
    type Output = Vec3;
    fn mul(self, s: f64) -> Vec3 {
        Vec3::new(self.x * s, self.y * s, self.z * s)
    }
}

impl Div<f64> for Vec3 {
    type Output = Vec3;
    fn div(self, s: f64) -> Vec3 {
        Vec3::new(self.x / s, self.y / s, self.z / s)
    }
}

impl Neg for Vec3 {
    type Output = Vec3;
    fn neg(self) -> Vec3 {
        Vec3::new(-self.x, -self.y, -self.z)
    }
}

/// Row-major 3x3 matrix. Serializes as a flat 9-element array.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Mat3(pub [f64; 9]);

impl Mat3 {
    pub fn identity() -> Mat3 {
        Mat3([1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0])
    }

    pub fn get(&self, r: usize, c: usize) -> f64 {
        self.0[r * 3 + c]
    }

    pub fn set(&mut self, r: usize, c: usize, v: f64) {
        self.0[r * 3 + c] = v;
    }

    pub fn row(&self, r: usize) -> Vec3 {
        Vec3::new(self.0[r * 3], self.0[r * 3 + 1], self.0[r * 3 + 2])
    }

    pub fn col(&self, c: usize) -> Vec3 {
        Vec3::new(self.0[c], self.0[3 + c], self.0[6 + c])
    }

    pub fn transpose(&self) -> Mat3 {
        let m = &self.0;
        Mat3([m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]])
    }

    pub fn mul(&self, o: &Mat3) -> Mat3 {
        let mut r = [0.0; 9];
        for i in 0..3 {
            for j in 0..3 {
                let mut s = 0.0;
                for k in 0..3 {
                    s += self.get(i, k) * o.get(k, j);
                }
                r[i * 3 + j] = s;
            }
        }
        Mat3(r)
    }

    pub fn mul_vec(&self, v: Vec3) -> Vec3 {
        Vec3::new(self.row(0).dot(v), self.row(1).dot(v), self.row(2).dot(v))
    }

    pub fn det(&self) -> f64 {
        let m = &self.0;
        m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6])
            + m[2] * (m[3] * m[7] - m[4] * m[6])
    }

    pub fn scale(&self, s: f64) -> Mat3 {
        let mut m = self.0;
        for v in &mut m {
            *v *= s;
        }
        Mat3(m)
    }

    /// Build from three column vectors.
    pub fn from_cols(c0: Vec3, c1: Vec3, c2: Vec3) -> Mat3 {
        Mat3([c0.x, c1.x, c2.x, c0.y, c1.y, c2.y, c0.z, c1.z, c2.z])
    }

    /// Rotation matrix from a unit quaternion `(w, x, y, z)` (COLMAP order
    /// QW QX QY QZ). The quaternion is normalized first.
    pub fn from_quaternion(q: [f64; 4]) -> Mat3 {
        let n = (q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]).sqrt();
        let (w, x, y, z) = (q[0] / n, q[1] / n, q[2] / n, q[3] / n);
        Mat3([
            1.0 - 2.0 * (y * y + z * z),
            2.0 * (x * y - z * w),
            2.0 * (x * z + y * w),
            2.0 * (x * y + z * w),
            1.0 - 2.0 * (x * x + z * z),
            2.0 * (y * z - x * w),
            2.0 * (x * z - y * w),
            2.0 * (y * z + x * w),
            1.0 - 2.0 * (x * x + y * y),
        ])
    }
}

/// Row-major 4x4 matrix. Serializes as a flat 16-element array.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Mat4(pub [f64; 16]);

/// Camera intrinsics reduced to a pinhole fx/fy/cx/cy. Distortion
/// coefficients of models like OPENCV are intentionally dropped: molemap
/// only raycasts near image centers where the distortion of phone cameras
/// is small relative to the sparse-cloud epsilon.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Intrinsics {
    pub model: String,
    pub fx: f64,
    pub fy: f64,
    pub cx: f64,
    pub cy: f64,
    pub width: u32,
    pub height: u32,
}

/// A posed camera (one registered image).
///
/// Pose is stored exactly as COLMAP writes it in `images.txt`:
/// **camera-from-world**, `x_cam = R * x_world + t`, rotation as unit
/// quaternion `qvec = [qw, qx, qy, qz]`, translation `tvec`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Camera {
    pub id: u32,
    pub name: String,
    pub intrinsics: Intrinsics,
    pub qvec: [f64; 4],
    pub tvec: Vec3,
}

impl Camera {
    /// Camera-from-world rotation `R`.
    pub fn rotation(&self) -> Mat3 {
        Mat3::from_quaternion(self.qvec)
    }

    /// Camera center in world coordinates: `C = -R^T * t`.
    pub fn center(&self) -> Vec3 {
        -self.rotation().transpose().mul_vec(self.tvec)
    }

    /// The camera's "up" direction in world coordinates.
    ///
    /// COLMAP's camera frame has +Y pointing *down* the image, so up in
    /// camera coordinates is `(0, -1, 0)`; mapping a direction to world uses
    /// `d_world = R^T * d_cam`, which equals the negated second **row** of R.
    pub fn up_world(&self) -> Vec3 {
        -self.rotation().row(1)
    }

    /// Viewing direction (+Z of the camera) in world coordinates.
    pub fn forward_world(&self) -> Vec3 {
        self.rotation().row(2)
    }
}

/// One sparse point from `points3D.txt`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Point3D {
    pub id: u64,
    pub xyz: Vec3,
    pub rgb: [u8; 3],
    /// Mean reprojection error in pixels as reported by COLMAP.
    pub error: f64,
}
