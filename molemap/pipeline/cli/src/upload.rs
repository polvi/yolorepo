//! Upload the bundle to the molemap API. Protocol contract with the worker:
//!
//! 1. `POST /api/visits` `{id, captured_at, manifest}` — idempotent create.
//! 2. Per artifact (manifest entries + the manifest itself):
//!    `POST /api/visits/:id/artifacts` `{sha256, kind, size, label, detectionId?}`
//!    -> `{needed: bool}`; when needed,
//!    `PUT /api/visits/:id/artifacts/:sha256` with the raw bytes.
//! 3. `POST /api/visits/:id/finalize`.
//!
//! Resume support = just rerun: the begin call returns `needed: false` for
//! blobs the server already has. Finalize is idempotent server-side (200 for
//! a same-manifest rerun); a 409 means the visit was finalized with a
//! DIFFERENT manifest and is a real conflict, not a benign rerun.
//!
//! Auth: `Authorization: Bearer <mm_...>` API key from `molemap login`.

use crate::config::Config;

/// "YYYY-MM-DD" (or "YYYY-MM-DD-b" collision suffix) -> epoch millis at UTC
/// midnight; the worker stores epoch-millis INTEGER timestamps.
fn capture_date_millis(date: &str) -> i64 {
    let d = date.get(..10).unwrap_or(date);
    chrono::NaiveDate::parse_from_str(d, "%Y-%m-%d")
        .map(|nd| nd.and_hms_opt(0, 0, 0).unwrap().and_utc().timestamp_millis())
        .unwrap_or(0)
}
use crate::manifest::{role_to_kind, Manifest};
use crate::workspace::Visit;
use anyhow::{bail, Context, Result};
use serde_json::json;

fn body_snippet(resp: ureq::Response) -> String {
    resp.into_string()
        .unwrap_or_default()
        .chars()
        .take(300)
        .collect()
}

fn post_json(
    agent: &ureq::Agent,
    key: &str,
    url: &str,
    body: serde_json::Value,
) -> Result<serde_json::Value, ureq::Error> {
    let resp = agent
        .post(url)
        .set("Authorization", &format!("Bearer {key}"))
        .send_json(body)?;
    Ok(resp.into_json().unwrap_or(serde_json::Value::Null))
}

pub fn upload(visit: &mut Visit, cfg: &Config, key: &str) -> Result<()> {
    let manifest_path = visit.dist_dir().join("manifest.json");
    let manifest_body = std::fs::read_to_string(&manifest_path).with_context(|| {
        format!(
            "no {} — run `molemap bundle` first",
            manifest_path.display()
        )
    })?;
    let manifest: Manifest = serde_json::from_str(&manifest_body)
        .with_context(|| format!("parse {}", manifest_path.display()))?;

    let base = cfg.api_origin.trim_end_matches('/');
    let vid = &manifest.visit_id;
    let agent = ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(300))
        .build();

    println!("uploading visit {} to {base}", visit.name);
    post_json(
        &agent,
        key,
        &format!("{base}/api/visits"),
        json!({
            "id": vid,
            "captured_at": capture_date_millis(&manifest.capture_date),
            "manifest": serde_json::from_str::<serde_json::Value>(&manifest_body)?,
        }),
    )
    .map_err(|e| describe(e, "create visit"))?;

    // Manifest itself is uploaded as an artifact too (kind "manifest").
    let (manifest_sha, manifest_size) = crate::bundle::sha256_file(&manifest_path)?;
    struct Item {
        sha256: String,
        kind: &'static str,
        size: u64,
        label: String,
        content_type: String,
        detection_id: Option<String>,
        rel: String,
    }
    let mut items: Vec<Item> = manifest
        .artifacts
        .iter()
        .map(|a| Item {
            sha256: a.sha256.clone(),
            kind: role_to_kind(&a.role),
            size: a.size,
            label: a.path.clone(),
            content_type: a.content_type.clone(),
            detection_id: a.detection_id.clone(),
            rel: a.path.clone(),
        })
        .collect();
    items.push(Item {
        sha256: manifest_sha,
        kind: "manifest",
        size: manifest_size,
        label: "manifest.json".into(),
        content_type: "application/json".into(),
        detection_id: None,
        rel: "manifest.json".into(),
    });

    let total = items.len();
    for (i, item) in items.iter().enumerate() {
        let mut begin = json!({
            "sha256": item.sha256,
            "kind": item.kind,
            "size": item.size,
            "label": item.label,
        });
        if let Some(det) = &item.detection_id {
            begin["detectionId"] = json!(det);
        }
        let resp = post_json(
            &agent,
            key,
            &format!("{base}/api/visits/{vid}/artifacts"),
            begin,
        )
        .map_err(|e| describe(e, &format!("begin artifact {}", item.label)))?;
        let needed = resp.get("needed").and_then(|v| v.as_bool()).unwrap_or(true);
        if !needed {
            println!("  [{}/{total}] {} — already on server", i + 1, item.label);
            continue;
        }
        let path = visit.dist_dir().join(&item.rel);
        let file =
            std::fs::File::open(&path).with_context(|| format!("open {}", path.display()))?;
        agent
            .put(&format!(
                "{base}/api/visits/{vid}/artifacts/{}",
                item.sha256
            ))
            .set("Authorization", &format!("Bearer {key}"))
            .set("Content-Type", &item.content_type)
            .set("Content-Length", &item.size.to_string())
            .send(file)
            .map_err(|e| describe(e, &format!("upload {}", item.label)))?;
        println!(
            "  [{}/{total}] {} — uploaded ({} KB)",
            i + 1,
            item.label,
            item.size / 1024
        );
    }

    match post_json(
        &agent,
        key,
        &format!("{base}/api/visits/{vid}/finalize"),
        json!({}),
    ) {
        Ok(_) => println!("finalized visit {vid}"),
        Err(ureq::Error::Status(409, resp)) => {
            anyhow::bail!(
                "visit {vid} is already finalized on the server with a DIFFERENT manifest: {}\n\
                 The local bundle no longer matches what was uploaded. Either re-ingest as a \
                 new visit (same day gets a -b suffix) or delete the server visit first.",
                body_snippet(resp)
            );
        }
        Err(e) => return Err(describe(e, "finalize")),
    }
    Ok(())
}

fn describe(e: ureq::Error, step: &str) -> anyhow::Error {
    match e {
        ureq::Error::Status(code, resp) => {
            let body = body_snippet(resp);
            match code {
                401 | 403 => anyhow::anyhow!(
                    "{step}: HTTP {code} — API key rejected; run `molemap login` with a fresh mm_ key. {body}"
                ),
                _ => anyhow::anyhow!("{step}: HTTP {code}: {body}"),
            }
        }
        other => anyhow::anyhow!("{step}: {other}"),
    }
}

/// Sanity-check for stage gating in main.
pub fn validate_key(key: &str) -> Result<()> {
    if key.trim().is_empty() {
        bail!("empty API key");
    }
    Ok(())
}
