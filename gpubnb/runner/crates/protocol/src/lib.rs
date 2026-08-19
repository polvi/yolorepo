//! gpubnb protocol v1 (Rust side). Mirrors `packages/protocol` (TypeScript).
//! Normative reference: `gpubnb/PROTOCOL.md`. If this crate and that file
//! disagree, this crate is wrong.
//!
//! Pure code: no I/O except [`digest::model_digest`], which reads the weights
//! directory.

pub mod binding;
pub mod digest;
pub mod doc;
pub mod enc;
pub mod events;
pub mod hpke;
pub mod signed;

pub use binding::{binding, gpu_nonce, report_data, simulated_measurement};
pub use doc::{AttestationDoc, GpuPart, ModelInfo, Platform, SnpPart};
pub use enc::{b64u, b64u_decode, b64u_decode_n, hex_decode_n};
pub use events::{cost, Event, OfferPayload, Price, ReceiptPayload};
pub use hpke::{
    open_envelope, seal_envelope, Envelope, FrameDecoder, FrameEncoder, HpkeMode, OpenedRequest,
    ResponseKeys, AAD_OPEN, AAD_REQ_PREFIX, INFO_OPEN, INFO_REQ,
};
pub use signed::{SignedBlob, DOMAIN_ATTDOC, DOMAIN_GOLDEN, DOMAIN_MODELS, DOMAIN_OFFER, DOMAIN_RECEIPT, DOMAIN_SIMULATED};

/// Protocol version carried in every attestation doc.
pub const PROTOCOL_VERSION: u32 = 1;

/// Dev root key id (signs simulated reports).
pub const DEV_ROOT_KID: &str = "gpubnb-dev-root";
/// Dev root public key (b64u). Public knowledge, checked in on purpose.
pub const DEV_ROOT_PUB_B64U: &str = "ymOF_JrpoPhtWQ3ddhLxQ2ElP4IvWU42GJ5Y98FK4bk";
/// Dev root private seed (b64u). Anything it signs is `simulated`, never `verified`.
pub const DEV_ROOT_SEED_B64U: &str = "dV0ywEoe20SjGM__t7x94B9I7NWqws9oILxmNOXy9G0";
/// Offline root key id (signs golden set + model catalog). Private half lives outside the repo.
pub const OFFLINE_ROOT_KID: &str = "gpubnb-root-2026";
/// Offline root public key (b64u).
pub const OFFLINE_ROOT_PUB_B64U: &str = "vDTaTKbOIk2FAGfIMYwICVyEHkSQq4RBEe4WOCgwb04";

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("bad encoding: {0}")]
    Encoding(String),
    #[error("bad signature")]
    Signature,
    #[error("hpke: {0}")]
    Hpke(String),
    #[error("aead failure")]
    Aead,
    #[error("frame: {0}")]
    Frame(String),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, Error>;

/// SHA-256 helper (used for placeholder digests and tests).
pub fn sha256(bytes: &[u8]) -> [u8; 32] {
    use sha2::Digest;
    sha2::Sha256::digest(bytes).into()
}
