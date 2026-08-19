//! Test vectors shared with the TypeScript package. Run with
//! `GPUBNB_WRITE_FIXTURES=1 cargo test -p gpubnb-protocol` to (re)write
//! `gpubnb/fixtures/runner/*.json`; without the env var the test verifies the
//! checked-in files.

use gpubnb_protocol::digest::{digest_from_entries, DigestEntry};
use gpubnb_protocol::signed::signing_key_from_seed;
use gpubnb_protocol::*;
use serde_json::{json, Value};
use std::path::PathBuf;

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures/runner")
}

fn writing() -> bool {
    std::env::var("GPUBNB_WRITE_FIXTURES").map(|v| v == "1").unwrap_or(false)
}

fn load_or_write(name: &str, produce: impl FnOnce() -> Value) -> Option<Value> {
    let path = fixtures_dir().join(name);
    if writing() {
        let v = produce();
        std::fs::create_dir_all(fixtures_dir()).unwrap();
        std::fs::write(&path, serde_json::to_string_pretty(&v).unwrap() + "\n").unwrap();
        eprintln!("wrote {}", path.display());
        return Some(v);
    }
    match std::fs::read_to_string(&path) {
        Ok(s) => Some(serde_json::from_str(&s).unwrap()),
        Err(_) => {
            eprintln!("fixture {} missing; run with GPUBNB_WRITE_FIXTURES=1", path.display());
            None
        }
    }
}

fn h32(x: u8) -> [u8; 32] {
    let mut a = [0u8; 32];
    for (i, b) in a.iter_mut().enumerate() {
        *b = x.wrapping_add(i as u8);
    }
    a
}

#[test]
fn binding_fixture() {
    let produce = || {
        let mut vectors = Vec::new();
        for (i, challenge) in [[0u8; 32], h32(0x40)].iter().enumerate() {
            let hpke_pub = h32(0x10 + i as u8);
            let sign_pub = h32(0x20);
            let boot_nonce = h32(0x30);
            let model_digest = h32(0x50);
            let rv = "0.1.0";
            let b = binding(&hpke_pub, &sign_pub, &boot_nonce, rv, &model_digest);
            vectors.push(json!({
                "hpke_pub": b64u(hpke_pub), "sign_pub": b64u(sign_pub), "boot_nonce": b64u(boot_nonce),
                "runner_version": rv, "model_digest": hex::encode(model_digest), "challenge": hex::encode(challenge),
                "binding": hex::encode(b),
                "report_data": hex::encode(report_data(&b, challenge)),
                "gpu_nonce": hex::encode(gpu_nonce(&b, challenge)),
                "simulated_measurement": hex::encode(simulated_measurement(rv)),
            }));
        }
        json!({ "note": "§2 binding/report_data/gpu_nonce and the simulated measurement for runner_version", "vectors": vectors })
    };
    let Some(v) = load_or_write("binding.json", produce) else { return };
    for vec in v["vectors"].as_array().unwrap() {
        let hp: [u8; 32] = b64u_decode_n(vec["hpke_pub"].as_str().unwrap()).unwrap();
        let sp: [u8; 32] = b64u_decode_n(vec["sign_pub"].as_str().unwrap()).unwrap();
        let bn: [u8; 32] = b64u_decode_n(vec["boot_nonce"].as_str().unwrap()).unwrap();
        let md: [u8; 32] = hex_decode_n(vec["model_digest"].as_str().unwrap()).unwrap();
        let ch: [u8; 32] = hex_decode_n(vec["challenge"].as_str().unwrap()).unwrap();
        let rv = vec["runner_version"].as_str().unwrap();
        let b = binding(&hp, &sp, &bn, rv, &md);
        assert_eq!(hex::encode(b), vec["binding"]);
        assert_eq!(hex::encode(report_data(&b, &ch)), vec["report_data"]);
        assert_eq!(hex::encode(gpu_nonce(&b, &ch)), vec["gpu_nonce"]);
        assert_eq!(hex::encode(simulated_measurement(rv)), vec["simulated_measurement"]);
    }
}

#[test]
fn signed_blob_fixture() {
    let produce = || {
        let mut vectors = Vec::new();
        let cases: Vec<(&str, [u8; 32], Option<&str>, String)> = vec![
            (DOMAIN_OFFER, h32(1), None, json!({"session_id":"AAAAAAAAAAAAAAAAAAAAAA","subaddress":"5test","price":{"in_per_m":1,"out_per_m":2},"hpke_pub":"x","created_at":1,"expires_at":2}).to_string()),
            (DOMAIN_RECEIPT, h32(1), None, json!({"session_id":"AAAAAAAAAAAAAAAAAAAAAA","seq":1,"tokens_in":7,"tokens_out":3,"debit_piconero":10,"cumulative_debit_piconero":10,"balance_piconero":990,"ts":1755600000}).to_string()),
            (DOMAIN_SIMULATED, b64u_decode_n(DEV_ROOT_SEED_B64U).unwrap(), Some(DEV_ROOT_KID), json!({"report_data":"00","gpu_nonce":"11","measurement":"22","hwmodel":"SIMULATED","issued_at":1755600000}).to_string()),
            // payload bytes are signed verbatim: whitespace matters, no canonicalization
            (DOMAIN_GOLDEN, h32(2), Some("gpubnb-test-kid"), "{ \"v\": 1 , \"entries\" : [] }".to_string()),
        ];
        for (domain, seed, kid, payload) in cases {
            let sk = signing_key_from_seed(&seed);
            let blob = SignedBlob::sign_bytes(domain, payload.as_bytes(), &sk, kid);
            vectors.push(json!({
                "domain": domain, "seed": b64u(seed), "pub": b64u(sk.verifying_key().to_bytes()), "kid": kid,
                "payload_json": payload, "blob": blob,
            }));
        }
        json!({ "note": "§1 signed blobs: sig = Ed25519(DOMAIN || payload_bytes); payload = b64u(payload_bytes) verbatim", "vectors": vectors })
    };
    let Some(v) = load_or_write("signed-blob.json", produce) else { return };
    for vec in v["vectors"].as_array().unwrap() {
        let seed: [u8; 32] = b64u_decode_n(vec["seed"].as_str().unwrap()).unwrap();
        let sk = signing_key_from_seed(&seed);
        assert_eq!(b64u(sk.verifying_key().to_bytes()), vec["pub"]);
        let blob: SignedBlob = serde_json::from_value(vec["blob"].clone()).unwrap();
        let domain = vec["domain"].as_str().unwrap();
        let payload = blob.verify_bytes(domain, &sk.verifying_key()).unwrap();
        assert_eq!(payload, vec["payload_json"].as_str().unwrap().as_bytes());
        // Ed25519 is deterministic: re-signing gives the identical blob
        let again = SignedBlob::sign_bytes(domain, &payload, &sk, vec["kid"].as_str());
        assert_eq!(again, blob);
    }
}

#[test]
fn frames_fixture() {
    let produce = || {
        let mut vectors = Vec::new();
        let keys = ResponseKeys { resp_key: h32(0x60), resp_base: h32(0x70)[..12].try_into().unwrap(), req_hash: h32(0x80) };
        let payloads = [
            (false, r#"{"t":"chunk","data":{"id":"c1","choices":[{"index":0,"delta":{"content":"Hel"}}]}}"#),
            (false, r#"{"t":"chunk","data":{"id":"c1","choices":[{"index":0,"delta":{"content":"lo"}}]}}"#),
            (true, r#"{"t":"receipt","receipt":{"payload":"e30","sig":"AA"}}"#),
        ];
        let mut enc = FrameEncoder::new(&keys);
        let mut frames = Vec::new();
        let mut stream = Vec::new();
        for (i, (fin, p)) in payloads.iter().enumerate() {
            let f = enc.frame(*fin, p.as_bytes());
            stream.extend_from_slice(&f);
            frames.push(json!({"i": i, "final": fin, "payload": p, "frame": hex::encode(&f)}));
        }
        vectors.push(json!({
            "resp_key": hex::encode(keys.resp_key), "resp_base": hex::encode(keys.resp_base), "req_hash": hex::encode(keys.req_hash),
            "frames": frames, "stream": hex::encode(stream),
        }));
        // single final frame (open/status shape)
        let keys2 = ResponseKeys { resp_key: h32(0x90), resp_base: [0u8; 12], req_hash: [0u8; 32] };
        let mut enc2 = FrameEncoder::new(&keys2);
        let p = r#"{"t":"status","balance_piconero":0,"credited_piconero":0,"pending_piconero":0,"subaddress":"5x","cumulative_debit_piconero":0}"#;
        let f = enc2.frame(true, p.as_bytes());
        vectors.push(json!({
            "resp_key": hex::encode(keys2.resp_key), "resp_base": hex::encode(keys2.resp_base), "req_hash": hex::encode(keys2.req_hash),
            "frames": [{"i": 0, "final": true, "payload": p, "frame": hex::encode(&f)}], "stream": hex::encode(&f),
        }));
        json!({ "note": "§5.2 frames: u32_be(len) || ChaCha20Poly1305(resp_key, resp_base XOR u96_be(i), aad=req_hash, flags||payload); flags bit0 = final", "vectors": vectors })
    };
    let Some(v) = load_or_write("frames.json", produce) else { return };
    for vec in v["vectors"].as_array().unwrap() {
        let keys = ResponseKeys {
            resp_key: hex_decode_n(vec["resp_key"].as_str().unwrap()).unwrap(),
            resp_base: hex_decode_n(vec["resp_base"].as_str().unwrap()).unwrap(),
            req_hash: hex_decode_n(vec["req_hash"].as_str().unwrap()).unwrap(),
        };
        let mut enc = FrameEncoder::new(&keys);
        let mut dec = FrameDecoder::new(&keys);
        for f in vec["frames"].as_array().unwrap() {
            let fin = f["final"].as_bool().unwrap();
            let payload = f["payload"].as_str().unwrap();
            let frame = enc.frame(fin, payload.as_bytes());
            assert_eq!(hex::encode(&frame), f["frame"]);
            let got = dec.push(&frame).unwrap();
            assert_eq!(got, vec![(fin, payload.as_bytes().to_vec())]);
        }
        dec.finish().unwrap();
    }
}

#[test]
fn model_digest_fixture() {
    let produce = || {
        let files = [("b.safetensors", b"bbbb".to_vec()), ("a.safetensors", b"aaa".to_vec()), ("config.json", b"{}".to_vec()), ("sub/dir/tokenizer.json", vec![]), ("README.md", b"# m\n".to_vec())];
        let mut entries: Vec<DigestEntry> = files.iter().map(|(p, c)| DigestEntry { path: p.to_string(), sha256: sha256(c) }).collect();
        entries.sort_by(|a, b| a.path.as_bytes().cmp(b.path.as_bytes()));
        let d = digest_from_entries(&entries);
        json!({
            "note": "§8 model digest: SHA256 over sorted (path || 0x00 || sha256(file) || 0x0a); paths relative, '/'-separated, byte-order sorted",
            "files": files.iter().map(|(p, c)| json!({"path": p, "content_b64u": b64u(c)})).collect::<Vec<_>>(),
            "entries": entries.iter().map(|e| json!({"path": e.path, "sha256": hex::encode(e.sha256)})).collect::<Vec<_>>(),
            "digest": hex::encode(d),
        })
    };
    let Some(v) = load_or_write("model-digest.json", produce) else { return };
    // recompute from files via the real directory walker
    let tmp = std::env::temp_dir().join(format!("gpubnb-fixture-digest-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    for f in v["files"].as_array().unwrap() {
        let p = tmp.join(f["path"].as_str().unwrap());
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, b64u_decode(f["content_b64u"].as_str().unwrap()).unwrap()).unwrap();
    }
    let d = digest::model_digest(&tmp).unwrap();
    assert_eq!(hex::encode(d), v["digest"]);
    let entries = digest::model_digest_entries(&tmp).unwrap();
    let want: Vec<(String, String)> = v["entries"].as_array().unwrap().iter().map(|e| (e["path"].as_str().unwrap().to_string(), e["sha256"].as_str().unwrap().to_string())).collect();
    assert_eq!(entries.iter().map(|e| (e.path.clone(), hex::encode(e.sha256))).collect::<Vec<_>>(), want);
    let _ = std::fs::remove_dir_all(&tmp);
}

#[test]
fn hpke_envelope_fixture() {
    let produce = || {
        let (sk, pk) = hpke::derive_hpke_keypair(b"gpubnb-fixture-recipient-ikm");
        let mut vectors = Vec::new();
        let open_pt = json!({"client_nonce": b64u(h32(0xa0))}).to_string();
        let (env, keys) = seal_envelope(&pk, open_pt.as_bytes(), HpkeMode::Open, 0).unwrap();
        vectors.push(json!({"mode":"open","ctr":0,"session_id":null,"session_key":null,"plaintext":open_pt,"envelope":env,
            "resp_key":hex::encode(keys.resp_key),"resp_base":hex::encode(keys.resp_base),"req_hash":hex::encode(keys.req_hash)}));
        let sid: [u8; 16] = h32(0xb0)[..16].try_into().unwrap();
        let key = h32(0xc0);
        let pt = json!({"model":"m","messages":[{"role":"user","content":"hi"}],"stream":true}).to_string();
        let (env, keys) = seal_envelope(&pk, pt.as_bytes(), HpkeMode::Psk { session_key: &key, session_id: &sid }, 7).unwrap();
        vectors.push(json!({"mode":"psk","ctr":7,"session_id":b64u(sid),"session_key":b64u(key),"plaintext":pt,"envelope":env,
            "resp_key":hex::encode(keys.resp_key),"resp_base":hex::encode(keys.resp_base),"req_hash":hex::encode(keys.req_hash)}));
        json!({
            "note": "§5.1 envelopes sealed by the Rust side (enc is ephemeral, so these are decrypt-only vectors). Suite DHKEM(X25519,HKDF-SHA256)/HKDF-SHA256/ChaCha20Poly1305. open: base mode, info=aad='gpubnb-open-v1'. psk: psk=session_key, psk_id=session_id bytes, info='gpubnb-req-v1', aad='gpubnb-req-v1'||session_id||u64be(ctr). resp_key=export('gpubnb-resp-key-v1',32), resp_base=export('gpubnb-resp-nonce-v1',12), req_hash=sha256(enc||ct)",
            "recipient_sk": b64u(sk), "recipient_pub": b64u(pk), "vectors": vectors
        })
    };
    let Some(v) = load_or_write("hpke-envelope.json", produce) else { return };
    verify_envelope_fixture(&v);
}

/// Shared verifier for our own and the TS-produced envelope fixtures.
pub fn verify_envelope_fixture(v: &Value) {
    let sk: [u8; 32] = b64u_decode_n(v["recipient_sk"].as_str().unwrap()).unwrap();
    assert_eq!(b64u(hpke::hpke_pub_from_sk(&sk).unwrap()), v["recipient_pub"]);
    for vec in v["vectors"].as_array().unwrap() {
        let env: Envelope = serde_json::from_value(vec["envelope"].clone()).unwrap();
        let opened = match vec["mode"].as_str().unwrap() {
            "open" => open_envelope(&sk, &env, HpkeMode::Open).unwrap(),
            "psk" => {
                let sid: [u8; 16] = b64u_decode_n(vec["session_id"].as_str().unwrap()).unwrap();
                let key: [u8; 32] = b64u_decode_n(vec["session_key"].as_str().unwrap()).unwrap();
                open_envelope(&sk, &env, HpkeMode::Psk { session_key: &key, session_id: &sid }).unwrap()
            }
            m => panic!("mode {m}"),
        };
        assert_eq!(opened.plaintext, vec["plaintext"].as_str().unwrap().as_bytes());
        assert_eq!(hex::encode(opened.keys.resp_key), vec["resp_key"]);
        assert_eq!(hex::encode(opened.keys.resp_base), vec["resp_base"]);
        assert_eq!(hex::encode(opened.keys.req_hash), vec["req_hash"]);
    }
}
