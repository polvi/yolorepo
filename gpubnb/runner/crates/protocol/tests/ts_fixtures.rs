//! Cross-check against the TypeScript package's vectors in
//! `gpubnb/fixtures/protocol/`. Skipped (with a note) when that directory is
//! absent.

use gpubnb_protocol::digest::{digest_from_entries, DigestEntry};
use gpubnb_protocol::signed::signing_key_from_seed;
use gpubnb_protocol::*;
use serde_json::Value;
use std::path::PathBuf;

fn ts_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures/protocol")
}

fn load(name: &str) -> Option<Value> {
    let p = ts_dir().join(name);
    match std::fs::read_to_string(&p) {
        Ok(s) => Some(serde_json::from_str(&s).unwrap_or_else(|e| panic!("{}: {e}", p.display()))),
        Err(_) => {
            eprintln!("TS fixture {} absent; skipping", p.display());
            None
        }
    }
}

fn hx<const N: usize>(v: &Value) -> [u8; N] {
    hex_decode_n(v.as_str().expect("hex string")).expect("hex len")
}

#[test]
fn ts_binding() {
    let Some(v) = load("binding.json") else { return };
    let i = &v["inputs"];
    let hp: [u8; 32] = hx(&i["hpke_pub"]);
    let sp: [u8; 32] = hx(&i["sign_pub"]);
    let bn: [u8; 32] = hx(&i["boot_nonce"]);
    let md: [u8; 32] = hx(&i["model_digest"]);
    let rv = i["runner_version"].as_str().unwrap();
    if let Some(h) = v.get("runner_version_sha256") {
        assert_eq!(hex::encode(sha256(rv.as_bytes())), h.as_str().unwrap());
    }
    for vec in v["vectors"].as_array().unwrap() {
        let ch: [u8; 32] = hx(&vec["challenge"]);
        let b = binding(&hp, &sp, &bn, rv, &md);
        assert_eq!(hex::encode(b), vec["binding"].as_str().unwrap(), "binding");
        assert_eq!(hex::encode(report_data(&b, &ch)), vec["report_data"].as_str().unwrap(), "report_data");
        assert_eq!(hex::encode(gpu_nonce(&b, &ch)), vec["gpu_nonce"].as_str().unwrap(), "gpu_nonce");
    }
}

#[test]
fn ts_signed_blob() {
    let Some(v) = load("signed-blob.json") else { return };
    let seed: [u8; 32] = hx(&v["seed"]);
    let sk = signing_key_from_seed(&seed);
    assert_eq!(hex::encode(sk.verifying_key().to_bytes()), v["pub"].as_str().unwrap());
    let payload = v["payload_json"].as_str().unwrap().as_bytes();
    for vec in v["vectors"].as_array().unwrap() {
        let blob: SignedBlob = serde_json::from_value(vec["blob"].clone()).unwrap();
        let domain = vec["domain"].as_str().unwrap();
        assert_eq!(blob.verify_bytes(domain, &sk.verifying_key()).unwrap(), payload, "{domain}");
        let ours = SignedBlob::sign_bytes(domain, payload, &sk, vec.get("kid").and_then(|k| k.as_str()));
        assert_eq!(ours, blob, "deterministic Ed25519 must reproduce the TS blob ({domain})");
    }
    for neg in v["negative"].as_array().unwrap_or(&vec![]) {
        let blob: SignedBlob = serde_json::from_value(neg["blob"].clone()).unwrap();
        let ok = blob.verify_bytes(neg["domain"].as_str().unwrap(), &sk.verifying_key()).is_ok();
        assert_eq!(ok, neg["expect"].as_bool().unwrap(), "{}", neg["_doc"]);
    }
    // pinned roots agree
    assert_eq!(v["dev_root"]["pub_b64u"], DEV_ROOT_PUB_B64U);
    assert_eq!(v["dev_root"]["priv_b64u"], DEV_ROOT_SEED_B64U);
    assert_eq!(v["offline_root"]["pub_b64u"], OFFLINE_ROOT_PUB_B64U);
}

fn check_frames(keys: &ResponseKeys, frames: &[Value], body_hex: Option<&str>) {
    let mut enc = FrameEncoder::new(keys);
    let mut dec = FrameDecoder::new(keys);
    let mut body = Vec::new();
    for f in frames {
        let fin = f["final"].as_bool().unwrap();
        let payload = f["payload_json"].as_str().unwrap().as_bytes();
        let frame = enc.frame(fin, payload);
        assert_eq!(hex::encode(&frame), f["frame_hex"].as_str().unwrap(), "frame {}", f["index"]);
        let got = dec.push(&frame).unwrap();
        assert_eq!(got, vec![(fin, payload.to_vec())]);
        body.extend_from_slice(&frame);
    }
    dec.finish().unwrap();
    if let Some(b) = body_hex {
        assert_eq!(hex::encode(&body), b);
    }
}

#[test]
fn ts_frames() {
    let Some(v) = load("frames.json") else { return };
    let keys = ResponseKeys { resp_key: hx(&v["resp_key"]), resp_base: hx(&v["resp_nonce_base"]), req_hash: hx(&v["req_hash"]) };
    check_frames(&keys, v["frames"].as_array().unwrap(), v["body_hex"].as_str());
    // tampered body rejected, truncated body lacks a final frame
    let tampered = hex::decode(v["tampered_body_hex"].as_str().unwrap()).unwrap();
    let mut d = FrameDecoder::new(&keys);
    assert!(d.push(&tampered).is_err() || d.finish().is_err());
    let truncated = hex::decode(v["truncated_body_hex"].as_str().unwrap()).unwrap();
    let mut d = FrameDecoder::new(&keys);
    d.push(&truncated).unwrap();
    assert!(d.finish().is_err());
    // nonce examples
    for ex in v["nonce_examples"].as_array().unwrap_or(&vec![]) {
        let i = ex["i"].as_u64().unwrap() as u32;
        let mut n = keys.resp_base;
        for (k, b) in i.to_be_bytes().iter().enumerate() {
            n[8 + k] ^= b;
        }
        assert_eq!(hex::encode(n), ex["nonce"].as_str().unwrap(), "nonce i={i}");
    }
}

fn check_hpke(v: &Value, mode_psk: bool) {
    let sk: [u8; 32] = hx(&v["recipient_priv"]);
    assert_eq!(hex::encode(hpke::hpke_pub_from_sk(&sk).unwrap()), v["recipient_pub"].as_str().unwrap());
    let env: Envelope = serde_json::from_value(v["envelope"].clone()).unwrap();
    let opened = if mode_psk {
        let sid: [u8; 16] = hx(&v["session_id"]);
        let key: [u8; 32] = hx(&v["session_key"]);
        assert_eq!(env.session_id.as_deref(), Some(b64u(sid).as_str()));
        assert_eq!(env.ctr, v["ctr"].as_u64().unwrap());
        open_envelope(&sk, &env, HpkeMode::Psk { session_key: &key, session_id: &sid }).expect("psk unseal")
    } else {
        open_envelope(&sk, &env, HpkeMode::Open).expect("open unseal")
    };
    assert_eq!(opened.plaintext, v["plaintext_json"].as_str().unwrap().as_bytes());
    let r = &v["response"];
    assert_eq!(hex::encode(opened.keys.resp_key), r["resp_key"].as_str().unwrap(), "resp_key");
    assert_eq!(hex::encode(opened.keys.resp_base), r["resp_nonce_base"].as_str().unwrap(), "resp_base");
    assert_eq!(hex::encode(opened.keys.req_hash), r["req_hash"].as_str().unwrap(), "req_hash");
    check_frames(&opened.keys, r["frames"].as_array().unwrap(), r["body_hex"].as_str());
}

#[test]
fn ts_hpke_open() {
    let Some(v) = load("hpke-open.json") else { return };
    check_hpke(&v, false);
}

#[test]
fn ts_hpke_request() {
    let Some(v) = load("hpke-request.json") else { return };
    check_hpke(&v, true);
}

#[test]
fn ts_model_digest() {
    let Some(v) = load("model-digest.json") else { return };
    let mut entries: Vec<DigestEntry> = v["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| DigestEntry { path: e["path"].as_str().unwrap().to_string(), sha256: hx(&e["sha256"]) })
        .collect();
    entries.sort_by(|a, b| a.path.as_bytes().cmp(b.path.as_bytes()));
    let sorted: Vec<&str> = v["sorted_paths"].as_array().unwrap().iter().map(|p| p.as_str().unwrap()).collect();
    assert_eq!(entries.iter().map(|e| e.path.as_str()).collect::<Vec<_>>(), sorted);
    assert_eq!(hex::encode(digest_from_entries(&entries)), v["digest"].as_str().unwrap());
    assert_eq!(hex::encode(digest_from_entries(&[])), v["empty_digest"].as_str().unwrap());
}
