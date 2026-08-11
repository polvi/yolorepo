//! Serde types for `manifest.json` and `detections.json` — the bundle
//! contract shared with the molemap web app.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const BUNDLE_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub molemap_bundle: u32,
    pub visit_id: String,
    pub capture_date: String,
    pub created_at: String,
    /// Tool name -> version string, for the tools that produced the bundle.
    pub tools: BTreeMap<String, String>,
    pub capture: CaptureInfo,
    pub reconstruction: ReconstructionInfo,
    pub alignment: AlignmentInfo,
    pub artifacts: Vec<ArtifactEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureInfo {
    pub image_count: usize,
    pub registered_images: usize,
    pub regions: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconstructionInfo {
    pub matcher: String,
    pub mapper: String,
    pub mean_reproj_error: f64,
    pub sparse_points: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignmentInfo {
    /// Row-major 4x4 mapping reconstruction coords -> canonical visit frame.
    pub world_from_visit: [f64; 16],
    /// "auto-gravity" for the automatic estimator.
    pub source: String,
    /// Always "+y".
    pub up_axis: String,
    /// Always "unit-height".
    pub scale: String,
}

/// Artifact roles: `splat` | `sparse` | `preview` | `crop` | `detections`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactEntry {
    pub role: String,
    /// Path relative to `dist/`.
    pub path: String,
    pub sha256: String,
    pub size: u64,
    pub content_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detection_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectionsFile {
    pub visit_id: String,
    pub generated_at: String,
    pub detections: Vec<DetectionEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectionEntry {
    pub id: String,
    /// Position in the canonical visit frame (units of body height).
    pub position: [f64; 3],
    pub confidence: f64,
    /// Sparse points supporting the raycast.
    pub support: usize,
    pub supporting_images: Vec<String>,
    /// Crop paths relative to `dist/`.
    pub crops: Vec<String>,
    /// `null` when built without the `embed` feature (or embedding failed).
    pub embedding: Option<Vec<f32>>,
}

/// Map a manifest artifact role to the upload API's `kind`.
pub fn role_to_kind(role: &str) -> &'static str {
    match role {
        "splat" => "splat",
        "sparse" => "pointcloud",
        "preview" => "preview",
        "crop" => "crop",
        "detections" => "detections",
        _ => "other",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_serializes_with_camel_case_keys() {
        let m = Manifest {
            molemap_bundle: BUNDLE_VERSION,
            visit_id: "v".into(),
            capture_date: "2026-08-10".into(),
            created_at: "now".into(),
            tools: BTreeMap::new(),
            capture: CaptureInfo {
                image_count: 2,
                registered_images: 2,
                regions: vec!["body".into()],
            },
            reconstruction: ReconstructionInfo {
                matcher: "sequential".into(),
                mapper: "colmap".into(),
                mean_reproj_error: 0.8,
                sparse_points: 100,
            },
            alignment: AlignmentInfo {
                world_from_visit: [0.0; 16],
                source: "auto-gravity".into(),
                up_axis: "+y".into(),
                scale: "unit-height".into(),
            },
            artifacts: vec![ArtifactEntry {
                role: "sparse".into(),
                path: "sparse.ply".into(),
                sha256: "ab".into(),
                size: 10,
                content_type: "application/octet-stream".into(),
                detection_id: None,
            }],
        };
        let v = serde_json::to_value(&m).unwrap();
        assert_eq!(v["molemapBundle"], 1);
        assert_eq!(
            v["alignment"]["worldFromVisit"].as_array().unwrap().len(),
            16
        );
        assert_eq!(v["alignment"]["upAxis"], "+y");
        assert!(v["artifacts"][0].get("detectionId").is_none());
    }

    #[test]
    fn detection_embedding_serializes_null() {
        let d = DetectionEntry {
            id: "d001".into(),
            position: [0.1, 0.5, 0.0],
            confidence: 0.9,
            support: 5,
            supporting_images: vec![],
            crops: vec![],
            embedding: None,
        };
        let v = serde_json::to_value(&d).unwrap();
        assert!(v["embedding"].is_null());
    }

    #[test]
    fn kinds_map() {
        assert_eq!(role_to_kind("sparse"), "pointcloud");
        assert_eq!(role_to_kind("splat"), "splat");
    }
}
