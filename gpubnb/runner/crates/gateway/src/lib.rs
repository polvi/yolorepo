//! §5.3 gateway: axum router serving the HPKE-sealed OpenAI-compatible
//! endpoint, session store + metering ([`ledger`]), signed offers/receipts,
//! and the unauthenticated well-known endpoints.

pub mod ledger;
pub mod routes;
pub mod snapshot;
pub mod upstream;

use gpubnb_attest::{Attester, Identity};
use gpubnb_protocol::doc::{ListingInfo, ModelInfo};
use gpubnb_protocol::{Price, SignedBlob};
use gpubnb_xmr::SubaddressSource;
use ledger::Ledger;
use parking_lot::RwLock;
use std::sync::Arc;
use std::time::Instant;

/// Everything the handlers need.
pub struct Gateway {
    pub identity: Identity,
    pub attester: Arc<dyn Attester>,
    pub ledger: Arc<Ledger>,
    pub subaddrs: Arc<dyn SubaddressSource>,
    pub upstream: upstream::Upstream,
    pub listing: ListingInfo,
    pub price: Price,
    /// Free-mode credit per session (simulate only); `None` = wallet mode.
    pub free_piconero: Option<u64>,
    pub session_ttl_s: u64,
    pub default_max_tokens: u64,
    pub boot_doc: RwLock<Option<SignedBlob>>,
    pub started: Instant,
    /// `None` only in tests; `gpubnbd` always wires the snapshot writer.
    pub persist: Option<Persister>,
}

pub type Shared = Arc<Gateway>;

/// Persist-on-write hook (see `specs/Metering.tla`, `ReceiptsDurable` /
/// `ReplaySafe`): the ledger must reach disk *before* a receipt leaves the
/// runner and *before* an accepted request starts, otherwise a crash between
/// a receipt and the next lazy snapshot lets the runner re-issue a `seq` and
/// re-accept a replayed counter after restart. Only reservations and chain
/// credits may stay RAM-only (credits rebuild by rescan).
pub type Persister = Arc<dyn Fn(&Ledger) -> anyhow::Result<()> + Send + Sync>;

impl Gateway {
    pub fn model(&self) -> &ModelInfo {
        &self.identity.model
    }

    /// Attest with `challenge` (blocking attester run on the blocking pool) and sign.
    pub async fn attest(self: &Arc<Self>, challenge: [u8; 32]) -> anyhow::Result<SignedBlob> {
        let gw = self.clone();
        let (_doc, blob) = tokio::task::spawn_blocking(move || gw.attester.attest_signed(&gw.identity, challenge)).await??;
        Ok(blob)
    }

    /// Boot doc (challenge = zero), produced once and cached.
    pub async fn boot_doc(self: &Arc<Self>) -> anyhow::Result<SignedBlob> {
        if let Some(b) = self.boot_doc.read().clone() {
            return Ok(b);
        }
        let b = self.attest([0u8; 32]).await?;
        *self.boot_doc.write() = Some(b.clone());
        Ok(b)
    }

    /// Durably persist the ledger now (no-op without a persister). Callers
    /// refuse to emit a receipt or start a request when this fails.
    pub fn persist_now(&self) -> anyhow::Result<()> {
        match &self.persist {
            Some(p) => p(&self.ledger),
            None => Ok(()),
        }
    }

    pub fn uptime_s(&self) -> u64 {
        self.started.elapsed().as_secs()
    }
}

/// Build the axum router.
pub fn router(gw: Shared) -> axum::Router {
    routes::router(gw)
}
