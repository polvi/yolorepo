//! The register → attest → heartbeat → challenge → re-attest round against a stub marketplace.

use axum::extract::Path;
use axum::http::HeaderMap;
use axum::routing::{post, put};
use axum::{Json, Router};
use gpubnb_attest::{Identity, SimulatedAttester};
use gpubnb_gateway::ledger::Ledger;
use gpubnb_gateway::upstream::Upstream;
use gpubnb_gateway::Gateway;
use gpubnb_protocol::doc::{AttestationDoc, ListingInfo};
use gpubnb_protocol::{Price, SignedBlob};
use gpubnb_xmr::FreeCredit;
use parking_lot::Mutex;
use std::sync::Arc;

#[derive(Default)]
struct Seen {
    upserts: Vec<serde_json::Value>,
    docs: Vec<AttestationDoc>,
    heartbeats: Vec<serde_json::Value>,
    tokens: Vec<String>,
}

type S = Arc<Mutex<Seen>>;

fn auth(h: &HeaderMap, s: &S) {
    let t = h.get("authorization").unwrap().to_str().unwrap().to_string();
    s.lock().tokens.push(t);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn round_trip_with_challenge() {
    let seen: S = Default::default();
    let app = Router::new()
        .route("/api/listings/{slug}", put({
            let s = seen.clone();
            move |h: HeaderMap, Path(slug): Path<String>, Json(b): Json<serde_json::Value>| {
                let s = s.clone();
                async move {
                    auth(&h, &s);
                    assert_eq!(slug, "sim");
                    s.lock().upserts.push(b);
                    Json(serde_json::json!({"id": "L1"}))
                }
            }
        }))
        .route("/api/listings/{id}/attest", post({
            let s = seen.clone();
            move |h: HeaderMap, Path(id): Path<String>, Json(blob): Json<SignedBlob>| {
                let s = s.clone();
                async move {
                    auth(&h, &s);
                    assert_eq!(id, "L1");
                    let v = gpubnb_attest::verify::verify_doc(&blob, gpubnb_protocol::enc::now_unix(), None, true);
                    assert_eq!(v.status, "simulated");
                    s.lock().docs.push(v.doc.unwrap());
                    Json(serde_json::json!({"status": "simulated", "checks": []}))
                }
            }
        }))
        .route("/api/listings/{id}/heartbeat", post({
            let s = seen.clone();
            move |h: HeaderMap, Path(_id): Path<String>, Json(b): Json<serde_json::Value>| {
                let s = s.clone();
                async move {
                    auth(&h, &s);
                    s.lock().heartbeats.push(b);
                    Json(serde_json::json!({"ok": true, "challenge": "cd".repeat(32)}))
                }
            }
        }))
        .with_state(());
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });

    let price = Price { in_per_m: 1, out_per_m: 1 };
    let gw = Arc::new(Gateway {
        identity: Identity::generate("0.1.0", "m", [1u8; 32], 1024),
        attester: Arc::new(SimulatedAttester::new("0.1.0", "SIM")),
        ledger: Arc::new(Ledger::new(price)),
        subaddrs: Arc::new(FreeCredit::new(None)),
        upstream: Upstream::new("http://127.0.0.1:1", "m", None),
        listing: ListingInfo { slug: "sim".into(), gpu_model: "SIM".into(), cpu_tee: "simulated".into(), region: "".into(), simulated: true },
        price,
        free_piconero: Some(1),
        session_ttl_s: 1,
        default_max_tokens: 1,
        boot_doc: Default::default(),
        started: std::time::Instant::now(),
    });
    let mp = gpubnb_marketplace::Marketplace::new(&format!("http://{addr}"), "gb_test");
    let upsert = gpubnb_marketplace::ListingUpsert {
        endpoint_url: "http://x".into(),
        gpu_model: "SIM".into(),
        cpu_tee: "simulated".into(),
        model_id: "m".into(),
        ctx_len: 1024,
        price_in_piconero: 1,
        price_out_piconero: 1,
        region: "".into(),
        simulated: true,
    };
    let task = tokio::spawn(gpubnb_marketplace::run_loop(gw.clone(), mp, "sim".into(), upsert));
    // wait for the first round to complete (upsert, attest, heartbeat, re-attest)
    for _ in 0..100 {
        if seen.lock().docs.len() >= 2 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    task.abort();
    let s = seen.lock();
    assert_eq!(s.upserts.len(), 1);
    assert_eq!(s.upserts[0]["simulated"], true);
    assert_eq!(s.heartbeats.len(), 1);
    assert_eq!(s.docs.len(), 2, "boot attest + challenge re-attest");
    assert_eq!(s.docs[0].challenge, "00".repeat(32));
    assert_eq!(s.docs[1].challenge, "cd".repeat(32));
    assert!(s.tokens.iter().all(|t| t == "Bearer gb_test"));
}
