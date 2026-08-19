//! §3 Attestation doc (payload of a signed blob, DOMAIN `gpubnb-attdoc-v1`).

use crate::signed::SignedBlob;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ModelInfo {
    pub id: String,
    /// hex32
    pub digest: String,
    pub ctx_len: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Platform {
    /// "snp" | "simulated"
    pub kind: String,
    pub cpu: String,
    pub gpu_model: String,
    /// "on" | "devtools" | "off" | "simulated"
    pub cc_mode: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SnpPart {
    /// b64u of the 1184-byte report
    pub report: String,
    /// PEM certificates, VCEK first, then ASK, then ARK
    pub vcek_chain: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GpuPart {
    /// overall JWT of the detached EAT bundle
    pub overall: String,
    /// per-device JWTs keyed "GPU-0", ...
    pub devices: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AttestationDoc {
    pub v: u32,
    pub runner_version: String,
    pub hpke_pub: String,
    pub sign_pub: String,
    pub boot_nonce: String,
    /// hex32
    pub binding: String,
    /// hex32
    pub challenge: String,
    pub issued_at: u64,
    pub model: ModelInfo,
    pub platform: Platform,
    pub snp: Option<SnpPart>,
    pub gpu: Option<GpuPart>,
    pub simulated: Option<SignedBlob>,
}

/// Inner payload of `simulated` (DOMAIN `gpubnb-simulated-v1`, signed by the dev root).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SimulatedReport {
    /// hex64
    pub report_data: String,
    /// hex32
    pub gpu_nonce: String,
    /// hex48
    pub measurement: String,
    pub hwmodel: String,
    pub issued_at: u64,
}

/// Unsigned public info at `GET /.well-known/gpubnb/info`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PublicInfo {
    pub listing: ListingInfo,
    pub price: crate::events::Price,
    pub model: ModelInfo,
    pub runner_version: String,
    pub sign_pub: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ListingInfo {
    pub slug: String,
    pub gpu_model: String,
    pub cpu_tee: String,
    pub region: String,
    pub simulated: bool,
}
