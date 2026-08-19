//! §5.2 events, §5.3 offer/receipt payloads, §6 metering arithmetic.

use crate::signed::SignedBlob;
use serde::{Deserialize, Serialize};

/// Piconero per 1,000,000 tokens, input and output.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct Price {
    pub in_per_m: u64,
    pub out_per_m: u64,
}

/// `cost = ceil(tokens_in * in_per_m / 1e6) + ceil(tokens_out * out_per_m / 1e6)`.
pub fn cost(price: &Price, tokens_in: u64, tokens_out: u64) -> u64 {
    ceil_div(tokens_in as u128 * price.in_per_m as u128, 1_000_000) as u64
        + ceil_div(tokens_out as u128 * price.out_per_m as u128, 1_000_000) as u64
}

fn ceil_div(a: u128, b: u128) -> u128 {
    a.div_ceil(b)
}

/// Offer payload (DOMAIN `gpubnb-offer-v1`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OfferPayload {
    pub session_id: String,
    pub subaddress: String,
    pub price: Price,
    pub hpke_pub: String,
    pub created_at: u64,
    pub expires_at: u64,
}

/// Receipt payload (DOMAIN `gpubnb-receipt-v1`). `seq` strictly increases per
/// session; `cumulative_debit_piconero` never decreases.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReceiptPayload {
    pub session_id: String,
    pub seq: u64,
    pub tokens_in: u64,
    pub tokens_out: u64,
    pub debit_piconero: u64,
    pub cumulative_debit_piconero: u64,
    pub balance_piconero: i64,
    pub ts: u64,
}

/// Events carried as UTF-8 JSON payloads inside response frames.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "t", rename_all = "lowercase")]
pub enum Event {
    Open {
        session_id: String,
        session_key: String,
        subaddress: String,
        price: Price,
        offer: SignedBlob,
    },
    Status {
        balance_piconero: i64,
        credited_piconero: u64,
        pending_piconero: u64,
        subaddress: String,
        cumulative_debit_piconero: u64,
    },
    Chunk {
        data: serde_json::Value,
    },
    Response {
        data: serde_json::Value,
    },
    Receipt {
        receipt: SignedBlob,
    },
    Error {
        code: ErrorCode,
        message: String,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    PaymentRequired,
    Upstream,
    BadRequest,
    Busy,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cost_rounds_up_per_side() {
        let p = Price { in_per_m: 1_000_000, out_per_m: 3 };
        assert_eq!(cost(&p, 0, 0), 0);
        assert_eq!(cost(&p, 1, 0), 1);
        assert_eq!(cost(&p, 1, 1), 2); // ceil(3/1e6) = 1
        assert_eq!(cost(&p, 10, 1_000_000), 13);
    }

    #[test]
    fn event_tags() {
        let e = Event::Error { code: ErrorCode::PaymentRequired, message: "x".into() };
        let s = serde_json::to_string(&e).unwrap();
        assert_eq!(s, r#"{"t":"error","code":"payment_required","message":"x"}"#);
        let e2: Event = serde_json::from_str(r#"{"t":"chunk","data":{"id":"a"}}"#).unwrap();
        assert!(matches!(e2, Event::Chunk { .. }));
    }
}
