//! HTTP handlers (§5.3).
#![allow(clippy::result_large_err)]

use crate::ledger::{ReserveOutcome, Session, SessionId};
use crate::upstream::{estimate_prompt_tokens, requested_max_tokens, UpstreamItem};
use crate::Shared;
use axum::body::{Body, Bytes};
use axum::extract::{Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use gpubnb_protocol::doc::PublicInfo;
use gpubnb_protocol::enc::now_unix;
use gpubnb_protocol::events::ErrorCode;
use gpubnb_protocol::{
    b64u, b64u_decode_n, hex_decode_n, open_envelope, Envelope, Event, FrameEncoder, HpkeMode, OfferPayload,
    OpenedRequest, ReceiptPayload, ResponseKeys, SignedBlob, DOMAIN_OFFER, DOMAIN_RECEIPT,
};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio_stream::wrappers::UnboundedReceiverStream;

pub fn router(gw: Shared) -> Router {
    Router::new()
        .route("/v1/sessions", post(open_session))
        .route("/v1/sessions/status", post(session_status))
        .route("/v1/chat/completions", post(chat))
        .route("/v1/models", get(models))
        .route("/.well-known/gpubnb/attestation", get(attestation))
        .route("/.well-known/gpubnb/info", get(info))
        .route("/healthz", get(|| async { "ok" }))
        .with_state(gw)
}

fn err(status: StatusCode, code: &str) -> Response {
    (status, Json(json!({ "error": code }))).into_response()
}

fn parse_envelope(body: &Bytes) -> Result<Envelope, Response> {
    serde_json::from_slice::<Envelope>(body).map_err(|_| err(StatusCode::BAD_REQUEST, "bad_envelope"))
}

/// One sealed response containing a single final event.
fn sealed_single(keys: &ResponseKeys, event: &Event) -> Response {
    let mut enc = FrameEncoder::new(keys);
    let payload = serde_json::to_vec(event).expect("event serializes");
    let frame = enc.frame(true, &payload);
    ([(header::CONTENT_TYPE, "application/octet-stream")], frame).into_response()
}

/// PSK-mode unseal with replay check. Advances the high-water mark only after a
/// successful decrypt, so garbage with a huge `ctr` cannot poison the session.
fn unseal_psk(gw: &Shared, env: &Envelope) -> Result<(Session, OpenedRequest), Response> {
    let sid_s = env.session_id.as_deref().ok_or_else(|| err(StatusCode::BAD_REQUEST, "missing_session"))?;
    let sid: SessionId = b64u_decode_n(sid_s).map_err(|_| err(StatusCode::BAD_REQUEST, "bad_session_id"))?;
    let session = gw.ledger.get(&sid).ok_or_else(|| err(StatusCode::NOT_FOUND, "unknown_session"))?;
    if !gw.ledger.ctr_fresh(&sid, env.ctr) {
        return Err(err(StatusCode::CONFLICT, "replay"));
    }
    let opened = open_envelope(&gw.identity.hpke_sk, env, HpkeMode::Psk { session_key: &session.key, session_id: &sid })
        .map_err(|_| err(StatusCode::BAD_REQUEST, "decrypt"))?;
    if !gw.ledger.advance_hwm(&sid, env.ctr) {
        return Err(err(StatusCode::CONFLICT, "replay"));
    }
    Ok((session, opened))
}

#[derive(Deserialize)]
struct OpenReq {
    client_nonce: String,
}

async fn open_session(State(gw): State<Shared>, body: Bytes) -> Response {
    let env = match parse_envelope(&body) {
        Ok(e) => e,
        Err(r) => return r,
    };
    if env.session_id.is_some() {
        return err(StatusCode::BAD_REQUEST, "session_id_must_be_null");
    }
    let opened = match open_envelope(&gw.identity.hpke_sk, &env, HpkeMode::Open) {
        Ok(o) => o,
        Err(_) => return err(StatusCode::BAD_REQUEST, "decrypt"),
    };
    let req: OpenReq = match serde_json::from_slice(&opened.plaintext) {
        Ok(r) => r,
        Err(_) => return err(StatusCode::BAD_REQUEST, "bad_request"),
    };
    if b64u_decode_n::<32>(&req.client_nonce).is_err() {
        return err(StatusCode::BAD_REQUEST, "bad_client_nonce");
    }
    let id: SessionId = rand::random();
    let key: [u8; 32] = rand::random();
    let id_b64 = b64u(id);
    let (subaddress, minor) = match gw.subaddrs.subaddress_for(&id_b64).await {
        Ok(x) => x,
        Err(e) => {
            tracing::error!(error = %e, "subaddress allocation failed");
            return sealed_single(&opened.keys, &Event::Error { code: ErrorCode::Busy, message: "wallet unavailable".into() });
        }
    };
    let now = now_unix();
    let offer_payload = OfferPayload {
        session_id: id_b64.clone(),
        subaddress: subaddress.clone(),
        price: gw.price,
        hpke_pub: b64u(gw.identity.hpke_pub),
        created_at: now,
        expires_at: now + gw.session_ttl_s,
    };
    let offer = match SignedBlob::sign(DOMAIN_OFFER, &offer_payload, &gw.identity.sign_key, None) {
        Ok(o) => o,
        Err(_) => return err(StatusCode::INTERNAL_SERVER_ERROR, "sign"),
    };
    gw.ledger.insert_session(Session {
        id,
        key,
        subaddress: subaddress.clone(),
        minor,
        hwm: 0,
        credited: 0,
        pending: 0,
        reserved: 0,
        cumulative_debit: 0,
        seq: 0,
        created_at: now,
        expires_at: now + gw.session_ttl_s,
        offer: offer.clone(),
    });
    if let Some(free) = gw.free_piconero {
        gw.ledger.credit_free(&id, free);
    }
    tracing::info!(session = %id_b64, %subaddress, "session opened");
    sealed_single(
        &opened.keys,
        &Event::Open { session_id: id_b64, session_key: b64u(key), subaddress, price: gw.price, offer },
    )
}

async fn session_status(State(gw): State<Shared>, body: Bytes) -> Response {
    let env = match parse_envelope(&body) {
        Ok(e) => e,
        Err(r) => return r,
    };
    let (session, opened) = match unseal_psk(&gw, &env) {
        Ok(x) => x,
        Err(r) => return r,
    };
    // plaintext is `{}`; any JSON object accepted
    if !serde_json::from_slice::<Value>(&opened.plaintext).map(|v| v.is_object()).unwrap_or(false) {
        return err(StatusCode::BAD_REQUEST, "bad_request");
    }
    let s = gw.ledger.get(&session.id).unwrap_or(session);
    sealed_single(
        &opened.keys,
        &Event::Status {
            balance_piconero: s.balance(),
            credited_piconero: s.credited,
            pending_piconero: s.pending,
            subaddress: s.subaddress.clone(),
            cumulative_debit_piconero: s.cumulative_debit,
        },
    )
}

fn receipt_blob(gw: &Shared, sid: &SessionId, tokens_in: u64, tokens_out: u64, settled: &crate::ledger::Settled) -> SignedBlob {
    let payload = ReceiptPayload {
        session_id: b64u(sid),
        seq: settled.seq,
        tokens_in,
        tokens_out,
        debit_piconero: settled.debit,
        cumulative_debit_piconero: settled.cumulative_debit,
        balance_piconero: settled.balance,
        ts: now_unix(),
    };
    SignedBlob::sign(DOMAIN_RECEIPT, &payload, &gw.identity.sign_key, None).expect("receipt serializes")
}

async fn chat(State(gw): State<Shared>, body: Bytes) -> Response {
    let env = match parse_envelope(&body) {
        Ok(e) => e,
        Err(r) => return r,
    };
    let (session, opened) = match unseal_psk(&gw, &env) {
        Ok(x) => x,
        Err(r) => return r,
    };
    let req: Value = match serde_json::from_slice::<Value>(&opened.plaintext) {
        Ok(v) if v.is_object() => v,
        _ => return err(StatusCode::BAD_REQUEST, "bad_request"),
    };
    let sid = session.id;
    let keys = opened.keys.clone();
    let (tx, rx) = mpsc::unbounded_channel::<Result<Bytes, std::convert::Infallible>>();
    tokio::spawn(async move {
        let mut enc = FrameEncoder::new(&keys);
        let send = |enc: &mut FrameEncoder, is_final: bool, ev: &Event| -> bool {
            let payload = serde_json::to_vec(ev).expect("event serializes");
            tx.send(Ok(Bytes::from(enc.frame(is_final, &payload)))).is_ok()
        };
        let prompt_est = estimate_prompt_tokens(&req);
        let max_tokens = requested_max_tokens(&req, gw.default_max_tokens);
        let reserve = match gw.ledger.reserve(&sid, prompt_est, max_tokens) {
            None => {
                send(&mut enc, true, &Event::Error { code: ErrorCode::BadRequest, message: "session gone".into() });
                return;
            }
            Some(ReserveOutcome::PaymentRequired { reserve, balance, reserved }) => {
                send(
                    &mut enc,
                    false,
                    &Event::Error {
                        code: ErrorCode::PaymentRequired,
                        message: format!(
                            "need {reserve} piconero reserved (balance {balance}, already reserved {reserved}); pay the session subaddress"
                        ),
                    },
                );
                if let Some(settled) = gw.ledger.next_receipt_zero(&sid) {
                    send(&mut enc, true, &Event::Receipt { receipt: receipt_blob(&gw, &sid, 0, 0, &settled) });
                }
                return;
            }
            Some(ReserveOutcome::Ok { reserve }) => reserve,
        };
        let mut client_gone = false;
        let result = gw
            .upstream
            .chat(req, |item| {
                let ev = match item {
                    UpstreamItem::Chunk(v) => Event::Chunk { data: v },
                    UpstreamItem::Response(v) => Event::Response { data: v },
                };
                if !send(&mut enc, false, &ev) {
                    client_gone = true;
                    return false;
                }
                true
            })
            .await;
        let (tokens_in, tokens_out) = match &result {
            Ok((Some(u), _)) => (u.prompt_tokens, u.completion_tokens),
            // Upstream gave no usage: bill the estimate + one token per content chunk.
            Ok((None, chunks)) => (prompt_est, *chunks),
            Err(e) => {
                tracing::warn!(error = %e, "upstream failed");
                if !client_gone {
                    send(&mut enc, false, &Event::Error { code: ErrorCode::Upstream, message: e.to_string() });
                }
                (0, 0)
            }
        };
        let settled = gw.ledger.settle(&sid, reserve, tokens_in, tokens_out);
        if let Some(settled) = settled {
            if !client_gone {
                send(&mut enc, true, &Event::Receipt { receipt: receipt_blob(&gw, &sid, tokens_in, tokens_out, &settled) });
            }
        }
    });
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .body(Body::from_stream(UnboundedReceiverStream::new(rx)))
        .expect("response")
}

async fn models(State(gw): State<Shared>) -> Response {
    let m = gw.model();
    Json(json!({
        "object": "list",
        "data": [{ "id": m.id, "object": "model", "created": 0, "owned_by": "gpubnb",
                   "ctx_len": m.ctx_len, "digest": m.digest }]
    }))
    .into_response()
}

#[derive(Deserialize)]
struct AttQuery {
    challenge: Option<String>,
}

async fn attestation(State(gw): State<Shared>, Query(q): Query<AttQuery>) -> Response {
    let res = match q.challenge {
        Some(c) => match hex_decode_n::<32>(&c) {
            Ok(ch) => gw.attest(ch).await,
            Err(_) => return err(StatusCode::BAD_REQUEST, "bad_challenge"),
        },
        None => gw.boot_doc().await,
    };
    match res {
        Ok(blob) => Json(blob).into_response(),
        Err(e) => {
            tracing::error!(error = %e, "attestation failed");
            err(StatusCode::SERVICE_UNAVAILABLE, "attestation_failed")
        }
    }
}

async fn info(State(gw): State<Shared>) -> Response {
    Json(PublicInfo {
        listing: gw.listing.clone(),
        price: gw.price,
        model: gw.model().clone(),
        runner_version: gw.identity.runner_version.clone(),
        sign_pub: b64u(gw.identity.sign_pub()),
    })
    .into_response()
}
