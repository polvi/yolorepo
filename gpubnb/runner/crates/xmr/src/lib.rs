//! §6/§7 Monero: view-only `monero-wallet-rpc` JSON-RPC client and the
//! watcher loop that credits sessions at K confirmations, idempotent by
//! `(txid, subaddr_major, subaddr_minor)`, revoking on reorg.
//!
//! The ledger itself lives in the gateway; this crate pushes observations
//! into a [`CreditSink`].

pub mod rpc;
pub mod watcher;

pub use rpc::{AddressEntry, Transfer, WalletRpc};
pub use watcher::{ChainView, CreditSink, Observed, Watcher, WatcherConfig};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("http: {0}")]
    Http(#[from] reqwest::Error),
    #[error("rpc error {code}: {message}")]
    Rpc { code: i64, message: String },
    #[error("bad response: {0}")]
    BadResponse(String),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, Error>;

/// One subaddress per session (§7). `label = session_id` is how sessions are
/// re-linked after a restart.
#[async_trait::async_trait]
pub trait SubaddressSource: Send + Sync {
    /// Returns `(address, minor_index)` for a new session.
    async fn subaddress_for(&self, session_id: &str) -> Result<(String, u32)>;
}

/// `--simulate` + `xmr.mode = "free"`: no chain, every session gets a fixed
/// balance from the gateway. Subaddresses are placeholders.
pub struct FreeCredit {
    pub display_address: String,
    next: std::sync::atomic::AtomicU32,
}

impl FreeCredit {
    pub fn new(display_address: Option<String>) -> Self {
        FreeCredit {
            display_address: display_address.unwrap_or_else(|| "SIMULATED-FREE".into()),
            next: std::sync::atomic::AtomicU32::new(1),
        }
    }
}

#[async_trait::async_trait]
impl SubaddressSource for FreeCredit {
    async fn subaddress_for(&self, _session_id: &str) -> Result<(String, u32)> {
        let minor = self.next.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok((self.display_address.clone(), minor))
    }
}

/// Re-export so binaries can implement [`SubaddressSource`] without adding the dependency.
pub use async_trait;
