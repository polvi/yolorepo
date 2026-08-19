//! Attesters. [`Identity`] holds the RAM-only runner keys (§2); an
//! [`Attester`] turns `(binding, challenge)` into platform evidence and the
//! crate assembles + signs the attestation doc (§3).
//!
//! * [`SimulatedAttester`]: fake report signed by the checked-in dev root.
//!   Anything it produces verifies as `simulated`, never `verified`.
//! * [`snp::SnpNvAttester`] (feature `snp`, Linux only): `/dev/sev-guest`
//!   report with `REPORT_DATA` per §2, VCEK chain from a cache dir or AMD KDS,
//!   `nvattest` (nv-attestation-cli) detached EAT with the hex GPU nonce, a
//!   claims self-check per §4, then `nvidia-smi conf-compute -srs 1`.

pub mod identity;
pub mod simulated;
pub mod verify;

#[cfg(feature = "snp")]
pub mod snp;

pub use identity::Identity;
pub use simulated::SimulatedAttester;

use gpubnb_protocol::doc::{AttestationDoc, GpuPart, Platform, SnpPart};
use gpubnb_protocol::{SignedBlob, DOMAIN_ATTDOC, PROTOCOL_VERSION};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("protocol: {0}")]
    Protocol(#[from] gpubnb_protocol::Error),
    #[error("platform: {0}")]
    Platform(String),
    #[error("gpu attestation failed self-check: {0}")]
    GpuSelfCheck(String),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("unsupported: {0}")]
    Unsupported(String),
}

pub type Result<T> = std::result::Result<T, Error>;

/// Platform evidence for one `(binding, challenge)`.
#[derive(Debug, Clone)]
pub struct Evidence {
    pub platform: Platform,
    pub snp: Option<SnpPart>,
    pub gpu: Option<GpuPart>,
    pub simulated: Option<SignedBlob>,
}

/// Produces platform evidence. Implementations are synchronous (they talk to
/// devices and spawn CLIs); callers run them on a blocking thread.
pub trait Attester: Send + Sync {
    /// Evidence binding `binding` and `challenge` at `issued_at`.
    fn evidence(&self, binding: &[u8; 32], challenge: &[u8; 32], issued_at: u64) -> Result<Evidence>;

    /// Whether this attester is the simulated one (listing must be flagged `simulated`).
    fn is_simulated(&self) -> bool;

    /// Build the full attestation doc for `challenge` (unsigned payload), issued now.
    fn attest(&self, id: &Identity, challenge: [u8; 32]) -> Result<AttestationDoc> {
        self.attest_at(id, challenge, gpubnb_protocol::enc::now_unix())
    }

    /// Build the doc with an explicit `issued_at` (fixtures/tests).
    fn attest_at(&self, id: &Identity, challenge: [u8; 32], issued_at: u64) -> Result<AttestationDoc> {
        let ev = self.evidence(&id.binding, &challenge, issued_at)?;
        Ok(AttestationDoc {
            v: PROTOCOL_VERSION,
            runner_version: id.runner_version.clone(),
            hpke_pub: gpubnb_protocol::b64u(id.hpke_pub),
            sign_pub: gpubnb_protocol::b64u(id.sign_pub()),
            boot_nonce: gpubnb_protocol::b64u(id.boot_nonce),
            binding: hex::encode(id.binding),
            challenge: hex::encode(challenge),
            issued_at,
            model: id.model.clone(),
            platform: ev.platform,
            snp: ev.snp,
            gpu: ev.gpu,
            simulated: ev.simulated,
        })
    }

    /// Build and sign the doc (DOMAIN `gpubnb-attdoc-v1`, runner `sign_key`).
    fn attest_signed(&self, id: &Identity, challenge: [u8; 32]) -> Result<(AttestationDoc, SignedBlob)> {
        let doc = self.attest(id, challenge)?;
        let blob = SignedBlob::sign(DOMAIN_ATTDOC, &doc, &id.sign_key, None)?;
        Ok((doc, blob))
    }
}
