//! RAM-only ledger (§6): sessions, per-session balances, credits keyed by
//! `(txid, major, minor)`, replay high-water marks, receipt sequence numbers.
//! Snapshotted to `state_dir` periodically (plaintext in simulate mode,
//! sealed under a key from `SNP_GET_DERIVED_KEY` in real mode, see [`snapshot`]).

use gpubnb_protocol::{cost, Price, SignedBlob};
use gpubnb_xmr::{ChainView, CreditSink};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};

pub type SessionId = [u8; 16];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    #[serde(with = "hex_arr16")]
    pub id: SessionId,
    #[serde(with = "hex_arr32")]
    pub key: [u8; 32],
    pub subaddress: String,
    pub minor: u32,
    /// Replay high-water mark: next accepted `ctr` must be `> hwm`.
    pub hwm: u64,
    pub credited: u64,
    pub pending: u64,
    pub reserved: u64,
    pub cumulative_debit: u64,
    pub seq: u64,
    pub created_at: u64,
    pub expires_at: u64,
    pub offer: SignedBlob,
}

impl Session {
    pub fn id_b64(&self) -> String {
        gpubnb_protocol::b64u(self.id)
    }
    /// `credited - cumulative_debit` (reserved not subtracted; may be negative after a reorg).
    pub fn balance(&self) -> i64 {
        self.credited as i64 - self.cumulative_debit as i64
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Credit {
    pub minor: u32,
    pub amount: u64,
    pub height: u64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct LedgerState {
    pub sessions: BTreeMap<String, Session>, // keyed by b64u session id for a stable JSON shape
    /// "txid:major:minor" → credit
    pub credits: BTreeMap<String, Credit>,
    pub tokens_in_total: u64,
    pub tokens_out_total: u64,
}

pub fn credit_key(txid: &str, major: u32, minor: u32) -> String {
    format!("{txid}:{major}:{minor}")
}

#[derive(Debug)]
pub struct Ledger {
    pub state: Mutex<LedgerState>,
    pub price: Price,
    by_minor: Mutex<HashMap<u32, SessionId>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReserveOutcome {
    Ok { reserve: u64 },
    PaymentRequired { reserve: u64, balance: i64, reserved: u64 },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Settled {
    pub debit: u64,
    pub cumulative_debit: u64,
    pub balance: i64,
    pub seq: u64,
}

impl Ledger {
    pub fn new(price: Price) -> Self {
        Ledger { state: Mutex::new(LedgerState::default()), price, by_minor: Mutex::new(HashMap::new()) }
    }

    pub fn restore(price: Price, state: LedgerState) -> Self {
        let mut by_minor = HashMap::new();
        for s in state.sessions.values() {
            by_minor.insert(s.minor, s.id);
        }
        let l = Ledger { state: Mutex::new(LedgerState::default()), price, by_minor: Mutex::new(by_minor) };
        *l.state.lock() = state;
        l
    }

    pub fn insert_session(&self, s: Session) {
        self.by_minor.lock().insert(s.minor, s.id);
        self.state.lock().sessions.insert(s.id_b64(), s);
    }

    pub fn get(&self, id: &SessionId) -> Option<Session> {
        self.state.lock().sessions.get(&gpubnb_protocol::b64u(id)).cloned()
    }

    pub fn session_count(&self) -> usize {
        self.state.lock().sessions.len()
    }

    /// Replay check + advance. Returns `false` (and changes nothing) when `ctr <= hwm`.
    /// Call only after the envelope decrypted successfully, so garbage with a huge
    /// `ctr` cannot burn the counter space.
    pub fn advance_hwm(&self, id: &SessionId, ctr: u64) -> bool {
        let mut st = self.state.lock();
        match st.sessions.get_mut(&gpubnb_protocol::b64u(id)) {
            Some(s) if ctr > s.hwm => {
                s.hwm = ctr;
                true
            }
            _ => false,
        }
    }

    /// Peek whether `ctr` would be accepted (no change).
    pub fn ctr_fresh(&self, id: &SessionId, ctr: u64) -> bool {
        self.get(id).map(|s| ctr > s.hwm).unwrap_or(false)
    }

    /// §6 reserve: `reserve = cost(prompt_estimate, max_tokens)`; refuse if `balance - reserved < reserve`.
    pub fn reserve(&self, id: &SessionId, prompt_estimate: u64, max_tokens: u64) -> Option<ReserveOutcome> {
        let reserve = cost(&self.price, prompt_estimate, max_tokens);
        let mut st = self.state.lock();
        let s = st.sessions.get_mut(&gpubnb_protocol::b64u(id))?;
        let avail = s.balance() - s.reserved as i64;
        if avail < reserve as i64 {
            return Some(ReserveOutcome::PaymentRequired { reserve, balance: s.balance(), reserved: s.reserved });
        }
        s.reserved += reserve;
        Some(ReserveOutcome::Ok { reserve })
    }

    /// Release a reservation and debit actual usage; bump seq and return receipt fields.
    pub fn settle(&self, id: &SessionId, reserve: u64, tokens_in: u64, tokens_out: u64) -> Option<Settled> {
        let debit = cost(&self.price, tokens_in, tokens_out);
        let mut st = self.state.lock();
        st.tokens_in_total += tokens_in;
        st.tokens_out_total += tokens_out;
        let s = st.sessions.get_mut(&gpubnb_protocol::b64u(id))?;
        s.reserved = s.reserved.saturating_sub(reserve);
        s.cumulative_debit += debit;
        s.seq += 1;
        Some(Settled { debit, cumulative_debit: s.cumulative_debit, balance: s.balance(), seq: s.seq })
    }

    /// Receipt with zero debit (refusals and errors still get a receipt).
    pub fn next_receipt_zero(&self, id: &SessionId) -> Option<Settled> {
        self.settle(id, 0, 0, 0)
    }

    /// Free-mode credit at session open (simulate only).
    pub fn credit_free(&self, id: &SessionId, amount: u64) {
        if let Some(s) = self.state.lock().sessions.get_mut(&gpubnb_protocol::b64u(id)) {
            s.credited += amount;
        }
    }

    pub fn totals(&self) -> (u64, u64) {
        let st = self.state.lock();
        (st.tokens_in_total, st.tokens_out_total)
    }

    /// Serialize for a snapshot.
    pub fn snapshot_json(&self) -> Vec<u8> {
        serde_json::to_vec(&*self.state.lock()).expect("ledger serializes")
    }
}

impl CreditSink for Ledger {
    /// Credit every confirmed transfer once (by key), revoke credited keys that
    /// vanished from the re-check window (reorg; balance may go negative),
    /// and recompute per-session pending totals.
    fn apply_chain_view(&self, view: &ChainView) {
        let by_minor = self.by_minor.lock().clone();
        let mut st = self.state.lock();
        let mut seen = std::collections::HashSet::new();
        for o in &view.confirmed {
            if o.major != 0 {
                continue;
            }
            let key = credit_key(&o.txid, o.major, o.minor);
            seen.insert(key.clone());
            if st.credits.contains_key(&key) {
                continue;
            }
            let Some(sid) = by_minor.get(&o.minor) else { continue };
            let sid_b64 = gpubnb_protocol::b64u(sid);
            if let Some(s) = st.sessions.get_mut(&sid_b64) {
                s.credited += o.amount;
                st.credits.insert(key, Credit { minor: o.minor, amount: o.amount, height: o.height });
                tracing::info!(session = %sid_b64, txid = %o.txid, amount = o.amount, "credited");
            }
        }
        // reorg revocation inside the window
        let revoke: Vec<(String, Credit)> = st
            .credits
            .iter()
            .filter(|(k, c)| c.height >= view.window_start && !seen.contains(*k))
            .map(|(k, c)| (k.clone(), c.clone()))
            .collect();
        for (k, c) in revoke {
            st.credits.remove(&k);
            if let Some(sid) = by_minor.get(&c.minor) {
                if let Some(s) = st.sessions.get_mut(&gpubnb_protocol::b64u(sid)) {
                    s.credited = s.credited.saturating_sub(c.amount);
                    tracing::warn!(credit = %k, amount = c.amount, "credit revoked (reorg)");
                }
            }
        }
        // pending totals
        let mut pend: HashMap<u32, u64> = HashMap::new();
        for o in &view.pending {
            if o.major == 0 {
                *pend.entry(o.minor).or_default() += o.amount;
            }
        }
        for s in st.sessions.values_mut() {
            s.pending = pend.get(&s.minor).copied().unwrap_or(0);
        }
    }
}

mod hex_arr16 {
    use serde::{Deserialize, Deserializer, Serializer};
    pub fn serialize<S: Serializer>(v: &[u8; 16], s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&hex::encode(v))
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<[u8; 16], D::Error> {
        let s = String::deserialize(d)?;
        let v = hex::decode(s).map_err(serde::de::Error::custom)?;
        v.try_into().map_err(|_| serde::de::Error::custom("len"))
    }
}
mod hex_arr32 {
    use serde::{Deserialize, Deserializer, Serializer};
    pub fn serialize<S: Serializer>(v: &[u8; 32], s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&hex::encode(v))
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<[u8; 32], D::Error> {
        let s = String::deserialize(d)?;
        let v = hex::decode(s).map_err(serde::de::Error::custom)?;
        v.try_into().map_err(|_| serde::de::Error::custom("len"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpubnb_xmr::Observed;

    fn sess(id: u8, minor: u32) -> Session {
        Session {
            id: [id; 16],
            key: [1; 32],
            subaddress: "5x".into(),
            minor,
            hwm: 0,
            credited: 0,
            pending: 0,
            reserved: 0,
            cumulative_debit: 0,
            seq: 0,
            created_at: 0,
            expires_at: 0,
            offer: SignedBlob { payload: String::new(), sig: String::new(), kid: None },
        }
    }

    fn obs(txid: &str, minor: u32, amount: u64, height: u64) -> Observed {
        Observed { txid: txid.into(), major: 0, minor, amount, height, confirmations: 10 }
    }

    #[test]
    fn credit_once_and_revoke_on_reorg() {
        let l = Ledger::new(Price { in_per_m: 1, out_per_m: 1 });
        l.insert_session(sess(1, 7));
        let v = ChainView { height: 100, window_start: 0, confirmed: vec![obs("t1", 7, 50, 90)], pending: vec![obs("t2", 7, 5, 0)] };
        l.apply_chain_view(&v);
        l.apply_chain_view(&v); // idempotent
        let s = l.get(&[1; 16]).unwrap();
        assert_eq!(s.credited, 50);
        assert_eq!(s.pending, 5);
        // reorg: t1 vanishes inside window
        let v2 = ChainView { height: 101, window_start: 50, confirmed: vec![], pending: vec![] };
        l.apply_chain_view(&v2);
        assert_eq!(l.get(&[1; 16]).unwrap().credited, 0);
        // a credit below the window is not revoked
        let v3 = ChainView { height: 1000, window_start: 0, confirmed: vec![obs("t3", 7, 9, 10)], pending: vec![] };
        l.apply_chain_view(&v3);
        let v4 = ChainView { height: 1001, window_start: 500, confirmed: vec![], pending: vec![] };
        l.apply_chain_view(&v4);
        assert_eq!(l.get(&[1; 16]).unwrap().credited, 9);
    }

    #[test]
    fn reserve_settle_and_replay() {
        let l = Ledger::new(Price { in_per_m: 1_000_000, out_per_m: 2_000_000 });
        l.insert_session(sess(2, 1));
        l.credit_free(&[2; 16], 100);
        assert!(l.advance_hwm(&[2; 16], 1));
        assert!(!l.advance_hwm(&[2; 16], 1));
        assert!(!l.advance_hwm(&[2; 16], 0));
        assert!(l.advance_hwm(&[2; 16], 5));
        // reserve 10 in + 20 out = 50
        assert_eq!(l.reserve(&[2; 16], 10, 20), Some(ReserveOutcome::Ok { reserve: 50 }));
        // second reserve of 60 fails (100 - 50 < 60)
        assert!(matches!(l.reserve(&[2; 16], 10, 25), Some(ReserveOutcome::PaymentRequired { .. })));
        let st = l.settle(&[2; 16], 50, 10, 5).unwrap();
        assert_eq!(st.debit, 20);
        assert_eq!(st.balance, 80);
        assert_eq!(st.seq, 1);
        let s = l.get(&[2; 16]).unwrap();
        assert_eq!(s.reserved, 0);
        // cumulative monotone, seq strictly increasing
        let st2 = l.next_receipt_zero(&[2; 16]).unwrap();
        assert_eq!(st2.seq, 2);
        assert_eq!(st2.cumulative_debit, 20);
        // snapshot roundtrip
        let bytes = l.snapshot_json();
        let state: LedgerState = serde_json::from_slice(&bytes).unwrap();
        let l2 = Ledger::restore(l.price, state);
        assert_eq!(l2.get(&[2; 16]).unwrap().cumulative_debit, 20);
        assert_eq!(l2.get(&[2; 16]).unwrap().hwm, 5);
    }
}
