//! Cross-check the TypeScript simulated-doc fixture with the runner's
//! self-verifier (doc.sig/doc.binding/doc.fresh/sim.*).

use gpubnb_attest::verify::verify_doc;
use gpubnb_protocol::*;
use serde_json::Value;
use std::path::PathBuf;

#[test]
fn ts_simulated_doc() {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures/protocol/simulated-doc.json");
    let Ok(text) = std::fs::read_to_string(&p) else {
        eprintln!("TS fixture {} absent; skipping", p.display());
        return;
    };
    let v: Value = serde_json::from_str(&text).unwrap();
    let now = v["issued_at"].as_u64().unwrap();
    assert_eq!(hex::encode(simulated_measurement(v["runner_version"].as_str().unwrap())), v["simulated_measurement"].as_str().unwrap());
    for exp in v["expected"].as_array().unwrap() {
        let name = exp["doc"].as_str().unwrap();
        let d = &v["docs"][name];
        let blob: SignedBlob = serde_json::from_value(d["doc"].clone()).unwrap();
        let allow = exp["options"]["allowSimulated"].as_bool().unwrap_or(false);
        let expected_ch: Option<[u8; 32]> = exp["options"].get("expectedChallenge").and_then(|c| c.as_str()).map(|c| hex_decode_n(c).unwrap());
        let verdict = verify_doc(&blob, now, expected_ch.as_ref(), allow);
        assert_eq!(verdict.status, exp["status"].as_str().unwrap(), "doc={name} options={} checks={:?}", exp["options"], verdict.checks);
        let failed: Vec<&str> = verdict.checks.iter().filter(|c| !c.ok).map(|c| c.id.as_str()).collect();
        for want in exp["failed_checks"].as_array().unwrap() {
            let want = want.as_str().unwrap();
            // `sim.allowed` is how the TS verifier reports the opt-in; ours folds it into the status.
            if want == "sim.allowed" {
                continue;
            }
            assert!(failed.contains(&want), "doc={name}: expected failing check {want}, got {failed:?}");
        }
    }
}
