//! Runner-side verifier for the checks that need no hardware roots: `doc.sig`,
//! `doc.binding`, `doc.fresh` and `sim.*` (§4). The full verifier (SNP chain,
//! NRAS JWKS) lives in `packages/protocol`; this one exists so the runner can
//! self-check what it is about to publish and so tests can assert on docs.

use gpubnb_protocol::doc::{AttestationDoc, SimulatedReport};
use gpubnb_protocol::signed::{verifying_key_from_b64u, verifying_key_from_bytes};
use gpubnb_protocol::{b64u_decode_n, binding, gpu_nonce, hex_decode_n, report_data, simulated_measurement, SignedBlob, DEV_ROOT_PUB_B64U, DOMAIN_ATTDOC, DOMAIN_SIMULATED};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Check {
    pub id: String,
    pub ok: bool,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Verdict {
    /// "verified" | "simulated" | "failed"
    pub status: String,
    pub checks: Vec<Check>,
    pub doc: Option<AttestationDoc>,
}

pub const FRESH_SKEW_S: u64 = 600;

fn push(checks: &mut Vec<Check>, id: &str, ok: bool, detail: impl Into<String>) -> bool {
    checks.push(Check { id: id.into(), ok, detail: detail.into() });
    ok
}

/// Verify a signed doc. `expected_challenge`: the caller's challenge if it supplied one.
/// Only simulated docs can reach a non-`failed` status here (real docs need the
/// SNP/NRAS checks this crate does not perform; they come back `failed` with a
/// `not-implemented` detail on `snp.parse`).
pub fn verify_doc(blob: &SignedBlob, now: u64, expected_challenge: Option<&[u8; 32]>, allow_simulated: bool) -> Verdict {
    let mut checks = Vec::new();
    let doc: AttestationDoc = match blob.peek() {
        Ok(d) => d,
        Err(e) => {
            push(&mut checks, "doc.sig", false, format!("unparseable payload: {e}"));
            return Verdict { status: "failed".into(), checks, doc: None };
        }
    };
    let sig_ok = (|| -> Option<()> {
        let pk = verifying_key_from_b64u(&doc.sign_pub).ok()?;
        blob.verify_bytes(DOMAIN_ATTDOC, &pk).ok()?;
        Some(())
    })()
    .is_some();
    push(&mut checks, "doc.sig", sig_ok, if sig_ok { "self-signed under sign_pub" } else { "bad signature" });

    let bind_ok = (|| -> Option<bool> {
        let hp: [u8; 32] = b64u_decode_n(&doc.hpke_pub).ok()?;
        let sp: [u8; 32] = b64u_decode_n(&doc.sign_pub).ok()?;
        let bn: [u8; 32] = b64u_decode_n(&doc.boot_nonce).ok()?;
        let md: [u8; 32] = hex_decode_n(&doc.model.digest).ok()?;
        let b = binding(&hp, &sp, &bn, &doc.runner_version, &md);
        Some(hex::encode(b) == doc.binding)
    })()
    .unwrap_or(false);
    push(&mut checks, "doc.binding", bind_ok, if bind_ok { "recomputed" } else { "mismatch" });

    let fresh_ok = doc.issued_at.abs_diff(now) <= FRESH_SKEW_S
        && expected_challenge.map(|c| hex::encode(c) == doc.challenge).unwrap_or(true);
    push(&mut checks, "doc.fresh", fresh_ok, format!("issued_at={} now={}", doc.issued_at, now));

    let mut status = "failed";
    if doc.platform.kind == "simulated" {
        let sim_ok = match &doc.simulated {
            Some(sim) => {
                let dev = verifying_key_from_b64u(DEV_ROOT_PUB_B64U).expect("dev root pub");
                match sim.verify::<SimulatedReport>(DOMAIN_SIMULATED, &dev) {
                    Ok(r) => {
                        push(&mut checks, "sim.sig", true, "dev root");
                        let (rd_ok, gn_ok) = match (hex_decode_n::<32>(&doc.binding), hex_decode_n::<32>(&doc.challenge)) {
                            (Ok(b), Ok(c)) => (
                                hex::encode(report_data(&b, &c)) == r.report_data,
                                hex::encode(gpu_nonce(&b, &c)) == r.gpu_nonce,
                            ),
                            _ => (false, false),
                        };
                        push(&mut checks, "sim.report_data", rd_ok, "");
                        push(&mut checks, "sim.gpu_nonce", gn_ok, "");
                        let m_ok = hex::encode(simulated_measurement(&doc.runner_version)) == r.measurement;
                        push(&mut checks, "sim.measurement", m_ok, "golden(simulated)");
                        rd_ok && gn_ok && m_ok
                    }
                    Err(_) => push(&mut checks, "sim.sig", false, "dev root signature invalid"),
                }
            }
            None => push(&mut checks, "sim.sig", false, "missing simulated report"),
        };
        if sig_ok && bind_ok && fresh_ok && sim_ok && allow_simulated {
            status = "simulated";
        }
    } else {
        push(&mut checks, "snp.parse", false, "not-implemented in runner self-verifier");
    }
    let _ = verifying_key_from_bytes;
    Verdict { status: status.into(), checks, doc: Some(doc) }
}
