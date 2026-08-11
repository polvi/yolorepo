//! wasm-bindgen exports for the web worker (feature `wasm` only).
//!
//! The interface is JSON-string based to keep the ABI trivial and avoid
//! extra glue dependencies. Build with:
//! `cargo build -p molemap-geom --features wasm --target wasm32-unknown-unknown`
//! (artifacts are not built or committed by the pipeline; the apps side owns
//! packaging.)

use crate::matching::{match_detections, DetectionIn, MoleIn};
use crate::types::{Mat4, Vec3};
use crate::umeyama::umeyama;
use wasm_bindgen::prelude::*;

fn err(e: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&e.to_string())
}

/// `detections`: `[{id, position: [x,y,z], confidence}]`
/// `moles`: `[{id, position: [x,y,z], dismissed?}]`
/// `alignment`: flat row-major 16-element array (visit -> body space)
/// Returns `[{detectionId, verdict: {type: "attachTo"|"newMole", ...}, distance?}]`.
#[wasm_bindgen]
pub fn match_detections_json(
    detections: &str,
    moles: &str,
    alignment: &str,
    radius: f64,
) -> Result<String, JsValue> {
    let dets: Vec<DetectionIn> = serde_json::from_str(detections).map_err(err)?;
    let moles: Vec<MoleIn> = serde_json::from_str(moles).map_err(err)?;
    let alignment: Mat4 = serde_json::from_str(alignment).map_err(err)?;
    let out = match_detections(&dets, &moles, &alignment, radius);
    serde_json::to_string(&out).map_err(err)
}

/// `src`, `dst`: JSON arrays of `[x, y, z]` (equal length, >= 3).
/// Returns `{scale, rotation: [9], translation: [x,y,z], matrix: [16]}`.
#[wasm_bindgen]
pub fn umeyama_json(src: &str, dst: &str) -> Result<String, JsValue> {
    let src: Vec<Vec3> = serde_json::from_str(src).map_err(err)?;
    let dst: Vec<Vec3> = serde_json::from_str(dst).map_err(err)?;
    let sim = umeyama(&src, &dst).map_err(err)?;
    let out = serde_json::json!({
        "scale": sim.scale,
        "rotation": sim.rotation,
        "translation": sim.translation,
        "matrix": sim.to_mat4(),
    });
    serde_json::to_string(&out).map_err(err)
}
