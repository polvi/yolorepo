//! §9 marketplace API client (host side). The host's `gb_` token only ever
//! reaches the marketplace; prompts and money never do.

use gpubnb_gateway::Shared;
use gpubnb_protocol::SignedBlob;
use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("http: {0}")]
    Http(#[from] reqwest::Error),
    #[error("marketplace {status}: {body}")]
    Status { status: u16, body: String },
    #[error("bad response: {0}")]
    BadResponse(String),
}

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Clone, Serialize)]
pub struct ListingUpsert {
    pub endpoint_url: String,
    pub gpu_model: String,
    pub cpu_tee: String,
    pub model_id: String,
    pub ctx_len: u64,
    pub price_in_piconero: u64,
    pub price_out_piconero: u64,
    pub region: String,
    pub simulated: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Verdict {
    pub status: String,
    #[serde(default)]
    pub checks: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Heartbeat {
    pub sessions_open: u64,
    pub tokens_in_total: u64,
    pub tokens_out_total: u64,
    pub uptime_s: u64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct HeartbeatResp {
    #[serde(default)]
    pub ok: bool,
    #[serde(default)]
    pub challenge: Option<String>,
}

#[derive(Clone)]
pub struct Marketplace {
    client: reqwest::Client,
    base: String,
    token: String,
}

pub const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(300);

impl Marketplace {
    pub fn new(base_url: &str, token: &str) -> Self {
        Marketplace {
            client: reqwest::Client::builder().timeout(Duration::from_secs(30)).build().expect("client"),
            base: base_url.trim_end_matches('/').to_string(),
            token: token.to_string(),
        }
    }

    async fn send<T: serde::de::DeserializeOwned>(&self, rb: reqwest::RequestBuilder) -> Result<T> {
        let resp = rb.bearer_auth(&self.token).send().await?;
        let status = resp.status();
        let body = resp.text().await?;
        if !status.is_success() {
            return Err(Error::Status { status: status.as_u16(), body: body.chars().take(400).collect() });
        }
        serde_json::from_str(&body).map_err(|e| Error::BadResponse(format!("{e}: {}", body.chars().take(200).collect::<String>())))
    }

    /// `PUT /api/listings/:slug` → listing id.
    pub async fn upsert_listing(&self, slug: &str, body: &ListingUpsert) -> Result<String> {
        #[derive(Deserialize)]
        struct R {
            id: serde_json::Value,
        }
        let r: R = self.send(self.client.put(format!("{}/api/listings/{slug}", self.base)).json(body)).await?;
        Ok(match r.id {
            serde_json::Value::String(s) => s,
            other => other.to_string(),
        })
    }

    /// `POST /api/listings/:id/attest` with the signed doc.
    pub async fn attest(&self, id: &str, doc: &SignedBlob) -> Result<Verdict> {
        self.send(self.client.post(format!("{}/api/listings/{id}/attest", self.base)).json(doc)).await
    }

    /// `POST /api/listings/:id/heartbeat`.
    pub async fn heartbeat(&self, id: &str, hb: &Heartbeat) -> Result<HeartbeatResp> {
        self.send(self.client.post(format!("{}/api/listings/{id}/heartbeat", self.base)).json(hb)).await
    }
}

/// Register, attest the boot doc, then heartbeat every 5 minutes; when a
/// heartbeat returns a challenge, re-attest with it (within 10 min or the
/// listing goes `stale`). Never returns; errors are logged and retried.
pub async fn run_loop(gw: Shared, mp: Marketplace, slug: String, upsert: ListingUpsert) {
    let mut listing_id: Option<String> = None;
    let mut attested = false;
    loop {
        if listing_id.is_none() {
            match mp.upsert_listing(&slug, &upsert).await {
                Ok(id) => {
                    tracing::info!(%id, %slug, "listing upserted");
                    listing_id = Some(id);
                }
                Err(e) => {
                    tracing::warn!(error = %e, "listing upsert failed; retrying in 60s");
                    tokio::time::sleep(Duration::from_secs(60)).await;
                    continue;
                }
            }
        }
        let id = listing_id.clone().unwrap();
        if !attested {
            match gw.boot_doc().await {
                Ok(doc) => match mp.attest(&id, &doc).await {
                    Ok(v) => {
                        tracing::info!(status = %v.status, "attested with marketplace");
                        attested = true;
                    }
                    Err(e) => tracing::warn!(error = %e, "attest failed"),
                },
                Err(e) => tracing::error!(error = %e, "could not produce attestation doc"),
            }
        }
        let (tin, tout) = gw.ledger.totals();
        let hb = Heartbeat {
            sessions_open: gw.ledger.session_count() as u64,
            tokens_in_total: tin,
            tokens_out_total: tout,
            uptime_s: gw.uptime_s(),
        };
        match mp.heartbeat(&id, &hb).await {
            Ok(resp) => {
                if let Some(ch) = resp.challenge {
                    match gpubnb_protocol::hex_decode_n::<32>(&ch) {
                        Ok(challenge) => match gw.attest(challenge).await {
                            Ok(doc) => match mp.attest(&id, &doc).await {
                                Ok(v) => tracing::info!(status = %v.status, "re-attested on challenge"),
                                Err(e) => tracing::warn!(error = %e, "challenge re-attest failed"),
                            },
                            Err(e) => tracing::error!(error = %e, "attestation for challenge failed"),
                        },
                        Err(_) => tracing::warn!("marketplace sent a malformed challenge"),
                    }
                }
            }
            Err(Error::Status { status: 404, .. }) => {
                tracing::warn!("listing vanished; re-registering");
                listing_id = None;
                attested = false;
                continue;
            }
            Err(e) => tracing::warn!(error = %e, "heartbeat failed"),
        }
        tokio::time::sleep(HEARTBEAT_INTERVAL).await;
    }
}
