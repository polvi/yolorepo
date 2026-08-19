//! Watcher: polls `get_transfers {in,pool}` + `get_height`, builds a
//! [`ChainView`] of confirmed (>= K) and pending transfers keyed by
//! `(txid, major, minor)`, and hands it to the [`CreditSink`] (the ledger),
//! which credits once per key and revokes keys that vanished from the window.

use crate::rpc::{Transfer, WalletRpc};
use crate::Result;
use std::time::Duration;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Observed {
    pub txid: String,
    pub major: u32,
    pub minor: u32,
    pub amount: u64,
    pub height: u64,
    pub confirmations: u64,
}

impl Observed {
    pub fn key(&self) -> (String, u32, u32) {
        (self.txid.clone(), self.major, self.minor)
    }
}

/// What the watcher saw in one poll.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ChainView {
    pub height: u64,
    /// Lowest block height this view covers (credits below it are not re-checked).
    pub window_start: u64,
    /// Transfers with `confirmations >= K`.
    pub confirmed: Vec<Observed>,
    /// In the mempool or `< K` confirmations.
    pub pending: Vec<Observed>,
}

pub trait CreditSink: Send + Sync {
    fn apply_chain_view(&self, view: &ChainView);
}

#[derive(Debug, Clone)]
pub struct WatcherConfig {
    pub confirmations: u64,
    pub poll_interval: Duration,
    /// Re-check window in blocks (credits inside it are revoked if the transfer vanishes).
    pub window_blocks: u64,
}

impl Default for WatcherConfig {
    fn default() -> Self {
        WatcherConfig { confirmations: 10, poll_interval: Duration::from_secs(20), window_blocks: 720 }
    }
}

pub struct Watcher {
    pub rpc: WalletRpc,
    pub cfg: WatcherConfig,
    first: bool,
}

/// Classify transfers at `height` into a [`ChainView`]. Pure, for tests.
pub fn classify(height: u64, window_start: u64, k: u64, confirmed_in: &[Transfer], pool: &[Transfer]) -> ChainView {
    let mut view = ChainView { height, window_start, ..Default::default() };
    let to_obs = |t: &Transfer| Observed {
        txid: t.txid.clone(),
        major: t.subaddr_index.major,
        minor: t.subaddr_index.minor,
        amount: t.amount,
        height: t.height,
        confirmations: t.confirmations,
    };
    for t in confirmed_in {
        if t.double_spend_seen {
            continue;
        }
        // wallet-rpc reports confirmations; recompute from height when it is 0 but height is set.
        let confs = if t.confirmations == 0 && t.height > 0 && height >= t.height { height - t.height + 1 } else { t.confirmations };
        let o = Observed { confirmations: confs, ..to_obs(t) };
        if confs >= k {
            view.confirmed.push(o);
        } else {
            view.pending.push(o);
        }
    }
    for t in pool {
        if t.double_spend_seen {
            continue;
        }
        view.pending.push(Observed { height: 0, confirmations: 0, ..to_obs(t) });
    }
    view
}

impl Watcher {
    pub fn new(rpc: WalletRpc, cfg: WatcherConfig) -> Self {
        Watcher { rpc, cfg, first: true }
    }

    /// One poll. The first poll scans from height 0 (restart: rebuild credits);
    /// later polls scan the trailing window only.
    pub async fn poll(&mut self) -> Result<ChainView> {
        let _ = self.rpc.refresh().await; // best effort; wallet-rpc auto-refreshes too
        let height = self.rpc.get_height().await?;
        let window_start = if self.first { 0 } else { height.saturating_sub(self.cfg.window_blocks) };
        let (inn, pool) = self.rpc.get_transfers(if window_start == 0 { None } else { Some(window_start) }).await?;
        self.first = false;
        Ok(classify(height, window_start, self.cfg.confirmations, &inn, &pool))
    }

    /// Run forever, applying each view to `sink`.
    pub async fn run(mut self, sink: std::sync::Arc<dyn CreditSink>) {
        loop {
            match self.poll().await {
                Ok(view) => sink.apply_chain_view(&view),
                Err(e) => tracing::warn!(error = %e, "xmr watcher poll failed"),
            }
            tokio::time::sleep(self.cfg.poll_interval).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpc::SubaddrIndex;

    fn t(txid: &str, minor: u32, amount: u64, height: u64, confs: u64) -> Transfer {
        Transfer {
            txid: txid.into(),
            amount,
            height,
            confirmations: confs,
            subaddr_index: SubaddrIndex { major: 0, minor },
            address: String::new(),
            double_spend_seen: false,
            unlock_time: 0,
            timestamp: 0,
            kind: "in".into(),
        }
    }

    #[test]
    fn classify_by_confirmations() {
        let v = classify(100, 0, 10, &[t("a", 1, 5, 80, 21), t("b", 2, 7, 95, 6), t("c", 3, 9, 91, 0)], &[t("d", 1, 3, 0, 0)]);
        assert_eq!(v.confirmed.iter().map(|o| o.txid.as_str()).collect::<Vec<_>>(), vec!["a", "c"]);
        assert_eq!(v.pending.iter().map(|o| o.txid.as_str()).collect::<Vec<_>>(), vec!["b", "d"]);
        assert_eq!(v.confirmed[1].confirmations, 10);
    }
}
