//! Cross-visit detection matching.
//!
//! Given this visit's clustered detections, the account's known moles, and a
//! visit-to-body alignment (`Mat4`), decide for each detection whether it is
//! a re-observation of a known mole or a new one. This mirrors the molemap
//! worker's TS logic so the CLI and the web app agree offline and online
//! (the wasm build exports exactly this function).
//!
//! Semantics:
//! * Detection positions are mapped through `alignment` into mole space.
//! * Matching is greedy **one-to-one** by ascending distance: each mole
//!   absorbs at most one detection. Clustering already merged multi-view
//!   observations of the same physical mole, so two detections near one mole
//!   mean one of them is genuinely new.
//! * Dismissed moles still participate: attaching to a dismissed mole is how
//!   a re-detected freckle stays suppressed instead of resurfacing as "new".

use crate::types::{Mat4, Vec3};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectionIn {
    pub id: String,
    pub position: Vec3,
    pub confidence: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoleIn {
    pub id: String,
    pub position: Vec3,
    #[serde(default)]
    pub dismissed: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Verdict {
    #[serde(rename_all = "camelCase")]
    AttachTo {
        mole_id: String,
        dismissed: bool,
    },
    NewMole,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchResult {
    pub detection_id: String,
    pub verdict: Verdict,
    /// Distance to the matched mole in mole-space units (body heights).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub distance: Option<f64>,
}

pub fn match_detections(
    detections: &[DetectionIn],
    moles: &[MoleIn],
    alignment: &Mat4,
    radius: f64,
) -> Vec<MatchResult> {
    let mapped: Vec<Vec3> = detections
        .iter()
        .map(|d| alignment.transform_point(d.position))
        .collect();

    // All candidate pairs within radius, sorted by distance.
    let mut pairs: Vec<(f64, usize, usize)> = Vec::new();
    for (di, dp) in mapped.iter().enumerate() {
        for (mi, mole) in moles.iter().enumerate() {
            let dist = dp.distance(mole.position);
            if dist <= radius {
                pairs.push((dist, di, mi));
            }
        }
    }
    pairs.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));

    let mut det_assigned: Vec<Option<(usize, f64)>> = vec![None; detections.len()];
    let mut mole_taken = vec![false; moles.len()];
    for (dist, di, mi) in pairs {
        if det_assigned[di].is_none() && !mole_taken[mi] {
            det_assigned[di] = Some((mi, dist));
            mole_taken[mi] = true;
        }
    }

    detections
        .iter()
        .enumerate()
        .map(|(di, d)| match det_assigned[di] {
            Some((mi, dist)) => MatchResult {
                detection_id: d.id.clone(),
                verdict: Verdict::AttachTo {
                    mole_id: moles[mi].id.clone(),
                    dismissed: moles[mi].dismissed,
                },
                distance: Some(dist),
            },
            None => MatchResult {
                detection_id: d.id.clone(),
                verdict: Verdict::NewMole,
                distance: None,
            },
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Mat3;

    fn det(id: &str, x: f64, y: f64, z: f64) -> DetectionIn {
        DetectionIn {
            id: id.into(),
            position: Vec3::new(x, y, z),
            confidence: 0.8,
        }
    }

    fn mole(id: &str, x: f64, y: f64, z: f64, dismissed: bool) -> MoleIn {
        MoleIn {
            id: id.into(),
            position: Vec3::new(x, y, z),
            dismissed,
        }
    }

    #[test]
    fn attaches_near_and_creates_far() {
        let dets = vec![det("d1", 0.1, 0.5, 0.0), det("d2", 0.9, 0.9, 0.9)];
        let moles = vec![mole("m1", 0.105, 0.5, 0.001, false)];
        let r = match_detections(&dets, &moles, &Mat4::identity(), 0.02);
        assert_eq!(
            r[0].verdict,
            Verdict::AttachTo {
                mole_id: "m1".into(),
                dismissed: false
            }
        );
        assert!(r[0].distance.unwrap() < 0.02);
        assert_eq!(r[1].verdict, Verdict::NewMole);
    }

    #[test]
    fn one_to_one_greedy_prefers_nearest() {
        // Two detections near one mole: only the nearest attaches.
        let dets = vec![det("far", 0.015, 0.5, 0.0), det("near", 0.002, 0.5, 0.0)];
        let moles = vec![mole("m1", 0.0, 0.5, 0.0, false)];
        let r = match_detections(&dets, &moles, &Mat4::identity(), 0.05);
        assert_eq!(r[0].verdict, Verdict::NewMole);
        assert_eq!(
            r[1].verdict,
            Verdict::AttachTo {
                mole_id: "m1".into(),
                dismissed: false
            }
        );
    }

    #[test]
    fn dismissed_moles_still_match() {
        let dets = vec![det("d1", 0.0, 0.0, 0.0)];
        let moles = vec![mole("m1", 0.001, 0.0, 0.0, true)];
        let r = match_detections(&dets, &moles, &Mat4::identity(), 0.01);
        assert_eq!(
            r[0].verdict,
            Verdict::AttachTo {
                mole_id: "m1".into(),
                dismissed: true
            }
        );
    }

    #[test]
    fn alignment_is_applied_before_matching() {
        // Alignment translates detections by (1, 0, 0).
        let align = Mat4::from_srt(1.0, &Mat3::identity(), Vec3::new(1.0, 0.0, 0.0));
        let dets = vec![det("d1", 0.0, 0.2, 0.0)];
        let moles = vec![mole("m1", 1.0, 0.2, 0.0, false)];
        let r = match_detections(&dets, &moles, &align, 0.01);
        assert_eq!(
            r[0].verdict,
            Verdict::AttachTo {
                mole_id: "m1".into(),
                dismissed: false
            }
        );
    }

    #[test]
    fn serde_shape_matches_worker() {
        let r = MatchResult {
            detection_id: "d1".into(),
            verdict: Verdict::AttachTo {
                mole_id: "m1".into(),
                dismissed: false,
            },
            distance: Some(0.004),
        };
        let json = serde_json::to_value(&r).unwrap();
        assert_eq!(json["detectionId"], "d1");
        assert_eq!(json["verdict"]["type"], "attachTo");
        assert_eq!(json["verdict"]["moleId"], "m1");
        let new = MatchResult {
            detection_id: "d2".into(),
            verdict: Verdict::NewMole,
            distance: None,
        };
        let json = serde_json::to_value(&new).unwrap();
        assert_eq!(json["verdict"]["type"], "newMole");
        assert!(json.get("distance").is_none());
    }
}
