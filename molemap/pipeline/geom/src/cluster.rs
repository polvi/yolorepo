//! Radius-based greedy clustering of per-image 3D detections.
//!
//! Candidates from many images that refer to the same physical mole land
//! near the same 3D position. We merge them greedily: iterate candidates by
//! descending confidence; a candidate joins the nearest existing cluster
//! whose centroid is within `radius`, otherwise it seeds a new cluster.
//! Cluster position is the running mean of its members; cluster confidence
//! is driven by how many distinct images support it.

use crate::types::Vec3;
use serde::{Deserialize, Serialize};

/// One per-image candidate lifted to 3D.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Candidate {
    /// Index identifying the source image (caller-defined).
    pub image_index: usize,
    pub position: Vec3,
    /// Per-image detection confidence in [0, 1].
    pub confidence: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Cluster {
    /// Mean position of member candidates.
    pub position: Vec3,
    /// Indices into the input candidate slice.
    pub members: Vec<usize>,
    /// Number of distinct supporting images.
    pub images: usize,
    /// Combined confidence: distinct-image support weighted by the mean
    /// per-candidate confidence, i.e. `images * mean(confidence)`.
    pub confidence: f64,
}

pub fn cluster(cands: &[Candidate], radius: f64) -> Vec<Cluster> {
    let mut order: Vec<usize> = (0..cands.len()).collect();
    order.sort_by(|&a, &b| {
        cands[b]
            .confidence
            .partial_cmp(&cands[a].confidence)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    struct Acc {
        sum: Vec3,
        members: Vec<usize>,
    }
    let mut accs: Vec<Acc> = Vec::new();

    for &i in &order {
        let p = cands[i].position;
        let mut best: Option<(usize, f64)> = None;
        for (ci, acc) in accs.iter().enumerate() {
            let centroid = acc.sum / acc.members.len() as f64;
            let d = centroid.distance(p);
            if d < radius && best.map_or(true, |(_, bd)| d < bd) {
                best = Some((ci, d));
            }
        }
        match best {
            Some((ci, _)) => {
                accs[ci].sum = accs[ci].sum + p;
                accs[ci].members.push(i);
            }
            None => accs.push(Acc {
                sum: p,
                members: vec![i],
            }),
        }
    }

    accs.into_iter()
        .map(|acc| {
            let n = acc.members.len() as f64;
            let mut images: Vec<usize> =
                acc.members.iter().map(|&i| cands[i].image_index).collect();
            images.sort_unstable();
            images.dedup();
            let mean_conf: f64 = acc
                .members
                .iter()
                .map(|&i| cands[i].confidence)
                .sum::<f64>()
                / n;
            Cluster {
                position: acc.sum / n,
                confidence: images.len() as f64 * mean_conf,
                images: images.len(),
                members: acc.members,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn c(image: usize, x: f64, y: f64, z: f64, conf: f64) -> Candidate {
        Candidate {
            image_index: image,
            position: Vec3::new(x, y, z),
            confidence: conf,
        }
    }

    #[test]
    fn merges_two_groups() {
        let cands = vec![
            c(0, 0.0, 0.5, 0.0, 0.9),
            c(1, 0.005, 0.5, 0.002, 0.8),
            c(2, -0.004, 0.498, 0.0, 0.7),
            c(0, 0.3, 0.8, 0.1, 0.95),
            c(1, 0.302, 0.801, 0.099, 0.6),
        ];
        let mut cl = cluster(&cands, 0.02);
        cl.sort_by(|a, b| a.position.x.partial_cmp(&b.position.x).unwrap());
        assert_eq!(cl.len(), 2);
        assert_eq!(cl[0].members.len(), 3);
        assert_eq!(cl[0].images, 3);
        assert!(
            cl[0]
                .position
                .distance(Vec3::new(0.000333, 0.499333, 0.000667))
                < 1e-3
        );
        assert_eq!(cl[1].members.len(), 2);
        assert_eq!(cl[1].images, 2);
    }

    #[test]
    fn distinct_images_counted_once() {
        // Two candidates from the same image at the same spot: images = 1.
        let cands = vec![c(3, 0.0, 0.0, 0.0, 1.0), c(3, 0.001, 0.0, 0.0, 1.0)];
        let cl = cluster(&cands, 0.01);
        assert_eq!(cl.len(), 1);
        assert_eq!(cl[0].images, 1);
        assert!((cl[0].confidence - 1.0).abs() < 1e-12);
    }

    #[test]
    fn far_points_stay_separate() {
        let cands = vec![c(0, 0.0, 0.0, 0.0, 0.5), c(1, 1.0, 0.0, 0.0, 0.5)];
        assert_eq!(cluster(&cands, 0.1).len(), 2);
    }

    #[test]
    fn empty_input() {
        assert!(cluster(&[], 0.1).is_empty());
    }
}
