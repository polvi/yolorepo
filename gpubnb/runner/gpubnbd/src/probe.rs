//! `gpubnbd probe`: a minimal renter for demos and smoke tests. The real
//! renter SDK/CLI is `packages/client` (TypeScript); this one exists so the
//! simulate demo needs nothing but cargo.

use anyhow::{bail, Context};
use futures_util::StreamExt;
use gpubnb_attest::verify::verify_doc;
use gpubnb_protocol::doc::AttestationDoc;
use gpubnb_protocol::signed::verifying_key_from_b64u;
use gpubnb_protocol::*;
use std::io::Write;

async fn sealed(
    http: &reqwest::Client,
    url: &str,
    hpke_pub: &[u8; 32],
    mode: HpkeMode<'_>,
    ctr: u64,
    pt: &[u8],
    mut on_event: impl FnMut(Event),
) -> anyhow::Result<()> {
    let (env, keys) = seal_envelope(hpke_pub, pt, mode, ctr)?;
    let resp = http.post(url).json(&env).send().await?;
    if !resp.status().is_success() {
        bail!("{url}: HTTP {} {}", resp.status(), resp.text().await.unwrap_or_default());
    }
    let mut dec = FrameDecoder::new(&keys);
    let mut body = resp.bytes_stream();
    while let Some(chunk) = body.next().await {
        for (_fin, payload) in dec.push(&chunk?)? {
            on_event(serde_json::from_slice(&payload).context("event json")?);
        }
    }
    dec.finish()?;
    Ok(())
}

pub async fn run(base: &str, prompt: &str, max_tokens: u64) -> anyhow::Result<()> {
    let base = base.trim_end_matches('/');
    let http = reqwest::Client::new();
    let challenge: [u8; 32] = rand::random();
    let blob: SignedBlob = http
        .get(format!("{base}/.well-known/gpubnb/attestation?challenge={}", hex::encode(challenge)))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let verdict = verify_doc(&blob, enc::now_unix(), Some(&challenge), true);
    for c in &verdict.checks {
        println!("  [{}] {:<18} {}", if c.ok { "ok" } else { "XX" }, c.id, c.detail);
    }
    println!("attestation: {}", verdict.status);
    if verdict.status == "failed" {
        bail!("attestation failed");
    }
    if verdict.status == "simulated" {
        println!("WARNING: SIMULATED attestation, no hardware protection");
    }
    let doc: AttestationDoc = verdict.doc.unwrap();
    let hpke_pub: [u8; 32] = b64u_decode_n(&doc.hpke_pub)?;
    let sign_pub = verifying_key_from_b64u(&doc.sign_pub)?;
    println!("runner {} model {} ({}) ctx {}", doc.runner_version, doc.model.id, &doc.model.digest[..16], doc.model.ctx_len);

    // open
    let nonce: [u8; 32] = rand::random();
    let mut opened = None;
    sealed(&http, &format!("{base}/v1/sessions"), &hpke_pub, HpkeMode::Open, 0, serde_json::json!({"client_nonce": b64u(nonce)}).to_string().as_bytes(), |e| {
        if let Event::Open { session_id, session_key, subaddress, price, offer } = e {
            opened = Some((session_id, session_key, subaddress, price, offer));
        }
    })
    .await?;
    let (sid_b64, key_b64, subaddress, price, offer) = opened.context("no open event")?;
    let offer_p: OfferPayload = offer.verify(DOMAIN_OFFER, &sign_pub).context("offer signature")?;
    println!("session {sid_b64}\n  pay-to subaddress: {subaddress}\n  price: {} in / {} out piconero per 1M tokens\n  offer valid until {}", price.in_per_m, price.out_per_m, offer_p.expires_at);
    let sid: [u8; 16] = b64u_decode_n(&sid_b64)?;
    let key: [u8; 32] = b64u_decode_n(&key_b64)?;
    let psk = HpkeMode::Psk { session_key: &key, session_id: &sid };
    let mut ctr = 1u64;

    sealed(&http, &format!("{base}/v1/sessions/status"), &hpke_pub, psk, ctr, b"{}", |e| {
        if let Event::Status { balance_piconero, credited_piconero, pending_piconero, .. } = e {
            println!("balance {balance_piconero} piconero (credited {credited_piconero}, pending {pending_piconero})");
        }
    })
    .await?;
    ctr += 1;

    let req = serde_json::json!({"model": doc.model.id, "stream": true, "max_tokens": max_tokens, "messages": [{"role": "user", "content": prompt}]});
    println!("--- assistant ---");
    let mut receipt = None;
    let mut error = None;
    sealed(&http, &format!("{base}/v1/chat/completions"), &hpke_pub, psk, ctr, req.to_string().as_bytes(), |e| match e {
        Event::Chunk { data } => {
            if let Some(t) = data.pointer("/choices/0/delta/content").and_then(|c| c.as_str()) {
                print!("{t}");
                let _ = std::io::stdout().flush();
            }
        }
        Event::Response { data } => {
            if let Some(t) = data.pointer("/choices/0/message/content").and_then(|c| c.as_str()) {
                println!("{t}");
            }
        }
        Event::Receipt { receipt: r } => receipt = Some(r),
        Event::Error { code, message } => error = Some(format!("{code:?}: {message}")),
        _ => {}
    })
    .await?;
    println!("\n--- end ---");
    if let Some(e) = error {
        println!("error: {e}");
    }
    let r = receipt.context("no receipt")?;
    let rp: ReceiptPayload = r.verify(DOMAIN_RECEIPT, &sign_pub).context("receipt signature")?;
    println!("receipt #{}: {} in + {} out tokens = {} piconero (cumulative {}, balance {}) signature ok", rp.seq, rp.tokens_in, rp.tokens_out, rp.debit_piconero, rp.cumulative_debit_piconero, rp.balance_piconero);
    Ok(())
}
