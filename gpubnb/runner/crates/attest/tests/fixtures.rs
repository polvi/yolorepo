//! `fixtures/runner/simulated-doc.json`: a deterministic simulated attestation
//! doc (fixed seeds + issued_at) the TS verifier must accept as `simulated`.

use gpubnb_attest::verify::verify_doc;
use gpubnb_attest::{Attester, Identity, SimulatedAttester};
use gpubnb_protocol::doc::AttestationDoc;
use gpubnb_protocol::*;
use serde_json::{json, Value};
use std::path::PathBuf;

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures/runner")
}

const ISSUED_AT: u64 = 1_755_600_000;

fn fixture_identity() -> Identity {
    let mut sign_seed = [0u8; 32];
    for (i, b) in sign_seed.iter_mut().enumerate() {
        *b = 0x20 + i as u8;
    }
    let mut boot_nonce = [0u8; 32];
    for (i, b) in boot_nonce.iter_mut().enumerate() {
        *b = 0x30 + i as u8;
    }
    let mut model_digest = [0u8; 32];
    for (i, b) in model_digest.iter_mut().enumerate() {
        *b = 0x50 + i as u8;
    }
    Identity::from_seeds(b"gpubnb-fixture-hpke-ikm", &sign_seed, boot_nonce, "0.1.0", "Qwen/Qwen3-8B", model_digest, 32768)
}

#[test]
fn simulated_doc_fixture() {
    let path = fixtures_dir().join("simulated-doc.json");
    let id = fixture_identity();
    let att = SimulatedAttester::new("0.1.0", "NVIDIA RTX PRO 6000 Blackwell Server Edition");
    let mut challenge = [0u8; 32];
    for (i, b) in challenge.iter_mut().enumerate() {
        *b = 0x40 + i as u8;
    }
    let mut docs = Vec::new();
    for ch in [[0u8; 32], challenge] {
        let doc = att.attest_at(&id, ch, ISSUED_AT).unwrap();
        let blob = SignedBlob::sign(DOMAIN_ATTDOC, &doc, &id.sign_key, None).unwrap();
        docs.push(json!({"challenge": hex::encode(ch), "blob": blob, "doc": doc}));
    }
    let produced = json!({
        "note": "§3 simulated attestation docs (dev root, kid gpubnb-dev-root). Verifies as `simulated` with allowSimulated and now ≈ issued_at; `failed` otherwise. Keys derived from fixed seeds; hpke_sk/sign_seed included so the TS side can reproduce.",
        "issued_at": ISSUED_AT,
        "hpke_sk": b64u(id.hpke_sk), "sign_seed": b64u(id.sign_key.to_bytes()), "boot_nonce": b64u(id.boot_nonce),
        "runner_version": "0.1.0", "model": id.model, "simulated_measurement": hex::encode(simulated_measurement("0.1.0")),
        "expected_status": "simulated",
        "docs": docs,
    });
    if std::env::var("GPUBNB_WRITE_FIXTURES").map(|v| v == "1").unwrap_or(false) {
        std::fs::create_dir_all(fixtures_dir()).unwrap();
        std::fs::write(&path, serde_json::to_string_pretty(&produced).unwrap() + "\n").unwrap();
    }
    let Ok(text) = std::fs::read_to_string(&path) else {
        eprintln!("fixture missing; run with GPUBNB_WRITE_FIXTURES=1");
        return;
    };
    let v: Value = serde_json::from_str(&text).unwrap();
    // Ed25519 + deterministic inputs ⇒ byte-identical to what we just produced
    assert_eq!(v["docs"], produced["docs"], "simulated-doc.json drifted from the generator");
    for d in v["docs"].as_array().unwrap() {
        let blob: SignedBlob = serde_json::from_value(d["blob"].clone()).unwrap();
        let ch: [u8; 32] = hex_decode_n(d["challenge"].as_str().unwrap()).unwrap();
        let verdict = verify_doc(&blob, ISSUED_AT + 5, Some(&ch), true);
        assert_eq!(verdict.status, "simulated", "{:?}", verdict.checks);
        assert_eq!(verify_doc(&blob, ISSUED_AT + 5, Some(&ch), false).status, "failed");
        assert_eq!(verify_doc(&blob, ISSUED_AT + 3600, Some(&ch), true).status, "failed");
        let doc: AttestationDoc = blob.peek().unwrap();
        assert_eq!(doc.platform.kind, "simulated");
        assert!(doc.snp.is_none() && doc.gpu.is_none() && doc.simulated.is_some());
        assert_eq!(doc.simulated.as_ref().unwrap().kid.as_deref(), Some(DEV_ROOT_KID));
    }
}
