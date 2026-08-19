//! End-to-end: gateway in simulate + free mode against a fake OpenAI upstream.
//! open session → status → streaming chat (chunks + usage) → receipt verifies →
//! replay rejected → non-stream chat → balance exhaustion yields payment_required.

use axum::body::Body;
use axum::http::header;
use axum::routing::post;
use axum::{Json, Router};
use futures_util::StreamExt;
use gpubnb_attest::{Identity, SimulatedAttester};
use gpubnb_gateway::ledger::Ledger;
use gpubnb_gateway::upstream::Upstream;
use gpubnb_gateway::Gateway;
use gpubnb_protocol::doc::{AttestationDoc, ListingInfo};
use gpubnb_protocol::signed::verifying_key_from_b64u;
use gpubnb_protocol::*;
use gpubnb_xmr::FreeCredit;
use std::sync::Arc;

const FREE: u64 = 1200;

async fn fake_upstream(Json(req): Json<serde_json::Value>) -> axum::response::Response {
    assert_eq!(req["model"], "upstream-model-name");
    let stream = req["stream"].as_bool().unwrap_or(false);
    if stream {
        assert_eq!(req["stream_options"]["include_usage"], true);
        let mut body = String::new();
        for (i, w) in ["Hel", "lo ", "world"].iter().enumerate() {
            body.push_str(&format!(
                "data: {}\n\n",
                serde_json::json!({"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":w},"finish_reason": if i==2 {Some("stop")} else {None}}]})
            ));
        }
        body.push_str(&format!(
            "data: {}\n\n",
            serde_json::json!({"id":"c1","object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3,"total_tokens":10}})
        ));
        body.push_str("data: [DONE]\n\n");
        axum::response::Response::builder()
            .header(header::CONTENT_TYPE, "text/event-stream")
            .body(Body::from(body))
            .unwrap()
    } else {
        Json(serde_json::json!({"id":"c2","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"Hello world"},"finish_reason":"stop"}],
            "usage":{"prompt_tokens":7,"completion_tokens":2,"total_tokens":9}}))
        .into_response()
    }
}
use axum::response::IntoResponse;

async fn spawn(app: Router) -> String {
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    format!("http://{addr}")
}

struct Client {
    http: reqwest::Client,
    base: String,
    hpke_pub: [u8; 32],
    sign_pub: ed25519_dalek::VerifyingKey,
}

impl Client {
    /// POST a sealed request, decode all frames, return events.
    async fn sealed(&self, path: &str, mode: HpkeMode<'_>, ctr: u64, pt: &[u8]) -> std::result::Result<Vec<Event>, (u16, String)> {
        let (env, keys) = seal_envelope(&self.hpke_pub, pt, mode, ctr).unwrap();
        let resp = self.http.post(format!("{}{path}", self.base)).json(&env).send().await.unwrap();
        if !resp.status().is_success() {
            let st = resp.status().as_u16();
            return Err((st, resp.text().await.unwrap()));
        }
        assert_eq!(resp.headers()[header::CONTENT_TYPE], "application/octet-stream");
        let mut dec = FrameDecoder::new(&keys);
        let mut events = Vec::new();
        let mut body = resp.bytes_stream();
        while let Some(chunk) = body.next().await {
            for (_fin, payload) in dec.push(&chunk.unwrap()).unwrap() {
                events.push(serde_json::from_slice::<Event>(&payload).unwrap());
            }
        }
        dec.finish().unwrap();
        Ok(events)
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn simulate_free_end_to_end() {
    let upstream_url = spawn(Router::new().route("/v1/chat/completions", post(fake_upstream))).await;

    let price = Price { in_per_m: 1_000_000, out_per_m: 1_000_000 }; // 1 piconero per token each way
    let identity = Identity::generate("0.1.0", "test/model", [9u8; 32], 4096);
    // Persist-on-write probe: every accepted ctr, every receipt and every open
    // must hit the persister before the client sees a response.
    let persists = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let persists_c = persists.clone();
    let persist: gpubnb_gateway::Persister = Arc::new(move |_l: &Ledger| {
        persists_c.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok(())
    });
    let gw = Arc::new(Gateway {
        identity,
        attester: Arc::new(SimulatedAttester::new("0.1.0", "SIMULATED GPU")),
        ledger: Arc::new(Ledger::new(price)),
        subaddrs: Arc::new(FreeCredit::new(None)),
        upstream: Upstream::new(&upstream_url, "upstream-model-name", None),
        listing: ListingInfo { slug: "t".into(), gpu_model: "SIMULATED GPU".into(), cpu_tee: "simulated".into(), region: "".into(), simulated: true },
        price,
        free_piconero: Some(FREE),
        session_ttl_s: 3600,
        default_max_tokens: 1024,
        boot_doc: Default::default(),
        started: std::time::Instant::now(),
        persist: Some(persist),
    });
    let base = spawn(gpubnb_gateway::router(gw.clone())).await;
    let http = reqwest::Client::new();

    // attestation doc verifies as simulated; challenge honored
    let blob: SignedBlob = http.get(format!("{base}/.well-known/gpubnb/attestation")).send().await.unwrap().json().await.unwrap();
    let v = gpubnb_attest::verify::verify_doc(&blob, enc::now_unix(), Some(&[0u8; 32]), true);
    assert_eq!(v.status, "simulated", "{:?}", v.checks);
    let doc: AttestationDoc = v.doc.unwrap();
    let ch = "ab".repeat(32);
    let blob2: SignedBlob = http.get(format!("{base}/.well-known/gpubnb/attestation?challenge={ch}")).send().await.unwrap().json().await.unwrap();
    let v2 = gpubnb_attest::verify::verify_doc(&blob2, enc::now_unix(), Some(&hex_decode_n(&ch).unwrap()), true);
    assert_eq!(v2.status, "simulated");
    assert_eq!(gpubnb_attest::verify::verify_doc(&blob2, enc::now_unix(), Some(&[0u8; 32]), true).status, "failed");
    // not allowed → failed
    assert_eq!(gpubnb_attest::verify::verify_doc(&blob, enc::now_unix(), None, false).status, "failed");

    // info + models
    let info: serde_json::Value = http.get(format!("{base}/.well-known/gpubnb/info")).send().await.unwrap().json().await.unwrap();
    assert_eq!(info["listing"]["simulated"], true);
    assert_eq!(info["sign_pub"], doc.sign_pub);
    let models: serde_json::Value = http.get(format!("{base}/v1/models")).send().await.unwrap().json().await.unwrap();
    assert_eq!(models["data"][0]["id"], "test/model");

    let client = Client {
        http: http.clone(),
        base: base.clone(),
        hpke_pub: b64u_decode_n(&doc.hpke_pub).unwrap(),
        sign_pub: verifying_key_from_b64u(&doc.sign_pub).unwrap(),
    };

    // open session
    let nonce: [u8; 32] = rand::random();
    let open_pt = serde_json::json!({"client_nonce": b64u(nonce)}).to_string();
    let evs = client.sealed("/v1/sessions", HpkeMode::Open, 0, open_pt.as_bytes()).await.unwrap();
    assert_eq!(evs.len(), 1);
    let (sid_b64, key_b64, offer) = match &evs[0] {
        Event::Open { session_id, session_key, offer, price: p, .. } => {
            assert_eq!(*p, price);
            (session_id.clone(), session_key.clone(), offer.clone())
        }
        other => panic!("expected open, got {other:?}"),
    };
    let offer_payload: OfferPayload = offer.verify(DOMAIN_OFFER, &client.sign_pub).unwrap();
    assert_eq!(offer_payload.session_id, sid_b64);
    assert_eq!(offer_payload.hpke_pub, doc.hpke_pub);
    let sid: [u8; 16] = b64u_decode_n(&sid_b64).unwrap();
    let key: [u8; 32] = b64u_decode_n(&key_b64).unwrap();
    let psk = HpkeMode::Psk { session_key: &key, session_id: &sid };

    // status
    let evs = client.sealed("/v1/sessions/status", psk, 1, b"{}").await.unwrap();
    match &evs[0] {
        Event::Status { balance_piconero, credited_piconero, .. } => {
            assert_eq!(*balance_piconero, FREE as i64);
            assert_eq!(*credited_piconero, FREE);
        }
        other => panic!("{other:?}"),
    }

    // streaming chat
    let chat = serde_json::json!({"model":"whatever","stream":true,"messages":[{"role":"user","content":"hi there"}]}).to_string();
    let evs = client.sealed("/v1/chat/completions", psk, 2, chat.as_bytes()).await.unwrap();
    let chunks = evs.iter().filter(|e| matches!(e, Event::Chunk { .. })).count();
    assert_eq!(chunks, 4, "{evs:?}");
    let Some(Event::Receipt { receipt }) = evs.last() else { panic!("last must be receipt: {evs:?}") };
    let r: ReceiptPayload = receipt.verify(DOMAIN_RECEIPT, &client.sign_pub).unwrap();
    assert_eq!((r.tokens_in, r.tokens_out), (7, 3));
    assert_eq!(r.debit_piconero, 10);
    assert_eq!(r.cumulative_debit_piconero, 10);
    assert_eq!(r.balance_piconero, FREE as i64 - 10);
    assert_eq!(r.seq, 1);
    assert_eq!(r.session_id, sid_b64);

    // replay: same ctr → 409, nothing changes
    let err = client.sealed("/v1/chat/completions", psk, 2, chat.as_bytes()).await.unwrap_err();
    assert_eq!(err.0, 409);
    assert!(err.1.contains("replay"));
    let err = client.sealed("/v1/sessions/status", psk, 1, b"{}").await.unwrap_err();
    assert_eq!(err.0, 409);

    // wrong psk → 400 and hwm does not advance
    let bad_key = [0u8; 32];
    let err = client.sealed("/v1/sessions/status", HpkeMode::Psk { session_key: &bad_key, session_id: &sid }, 50, b"{}").await.unwrap_err();
    assert_eq!(err.0, 400);
    // unknown session → 404
    let other = [7u8; 16];
    let err = client.sealed("/v1/sessions/status", HpkeMode::Psk { session_key: &key, session_id: &other }, 1, b"{}").await.unwrap_err();
    assert_eq!(err.0, 404);

    // non-stream chat, ctr 3 (50 was never accepted)
    let chat2 = serde_json::json!({"model":"x","messages":[{"role":"user","content":"hi"}],"max_tokens":10}).to_string();
    let evs = client.sealed("/v1/chat/completions", psk, 3, chat2.as_bytes()).await.unwrap();
    assert!(matches!(evs[0], Event::Response { .. }), "{evs:?}");
    let Some(Event::Receipt { receipt }) = evs.last() else { panic!() };
    let r2: ReceiptPayload = receipt.verify(DOMAIN_RECEIPT, &client.sign_pub).unwrap();
    assert_eq!(r2.seq, 2);
    assert_eq!(r2.debit_piconero, 9);
    assert_eq!(r2.cumulative_debit_piconero, 19);

    // exhaustion: ask for more than the balance can reserve
    let big = serde_json::json!({"model":"x","stream":true,"messages":[{"role":"user","content":"hi"}],"max_tokens":5000}).to_string();
    let evs = client.sealed("/v1/chat/completions", psk, 4, big.as_bytes()).await.unwrap();
    assert_eq!(evs.len(), 2, "{evs:?}");
    assert!(matches!(&evs[0], Event::Error { code: gpubnb_protocol::events::ErrorCode::PaymentRequired, .. }), "{evs:?}");
    let Event::Receipt { receipt } = &evs[1] else { panic!() };
    let r3: ReceiptPayload = receipt.verify(DOMAIN_RECEIPT, &client.sign_pub).unwrap();
    assert_eq!(r3.debit_piconero, 0);
    assert_eq!(r3.seq, 3);
    assert_eq!(r3.cumulative_debit_piconero, 19);
    // balance unchanged
    let evs = client.sealed("/v1/sessions/status", psk, 5, b"{}").await.unwrap();
    match &evs[0] {
        Event::Status { balance_piconero, cumulative_debit_piconero, .. } => {
            assert_eq!(*balance_piconero, FREE as i64 - 19);
            assert_eq!(*cumulative_debit_piconero, 19);
        }
        other => panic!("{other:?}"),
    }
    let (tin, tout) = gw.ledger.totals();
    assert_eq!((tin, tout), (14, 5));
    // 1 open + accepted ctrs (status 1, chat 2, chat 3, chat 4, status 5 = 5)
    // + receipts (3) = 9; replays / bad PSK / unknown session never persist.
    assert_eq!(persists.load(std::sync::atomic::Ordering::SeqCst), 9);
}
