//! molemap-geom: pure geometry core for the molemap pipeline.
//!
//! No I/O dependencies beyond std; serde for data types. The optional
//! `wasm` feature adds wasm-bindgen exports of `matching` and `umeyama` for
//! the web worker (default builds carry zero wasm deps).

pub mod cluster;
pub mod colmap_txt;
pub mod matching;
pub mod normalize;
pub mod raycast;
pub mod transform;
pub mod types;
pub mod umeyama;

#[cfg(feature = "wasm")]
pub mod wasm;

pub use cluster::{cluster, Candidate, Cluster};
pub use colmap_txt::{ColmapCamera, ColmapImage, Model, Obs};
pub use matching::{match_detections, DetectionIn, MatchResult, MoleIn, Verdict};
pub use normalize::{normalize, Normalization};
pub use raycast::{cast, pixel_ray, raycast_pixel, Ray, RayHit};
pub use types::{Camera, Intrinsics, Mat3, Mat4, Point3D, Vec3};
pub use umeyama::{umeyama, Similarity};
