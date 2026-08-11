//! Minimal local preview server: `tiny_http` on 127.0.0.1:8330 serving
//! `dist/` plus an embedded artifact-listing page (a full splat viewer lives
//! in the web app; this is just for sanity-checking a bundle offline).

use crate::workspace::Visit;
use anyhow::{Context, Result};
use std::path::Component;

fn page(visit: &Visit) -> String {
    let mut rows = String::new();
    let dist = visit.dist_dir();
    let mut files = Vec::new();
    let mut stack = vec![dist.clone()];
    while let Some(d) = stack.pop() {
        if let Ok(rd) = std::fs::read_dir(&d) {
            for e in rd.filter_map(|e| e.ok()) {
                let p = e.path();
                if p.is_dir() {
                    stack.push(p);
                } else {
                    files.push(p);
                }
            }
        }
    }
    files.sort();
    for f in files {
        let rel = f
            .strip_prefix(&dist)
            .unwrap_or(&f)
            .to_string_lossy()
            .into_owned();
        let size = f.metadata().map(|m| m.len()).unwrap_or(0);
        rows.push_str(&format!(
            "<li><a href=\"/{rel}\">{rel}</a> <small>({} KB)</small></li>\n",
            size / 1024
        ));
    }
    format!(
        "<!doctype html><meta charset=\"utf-8\">\
         <title>molemap visit {name}</title>\
         <style>body{{font-family:system-ui;margin:2rem;max-width:40rem}}</style>\
         <h1>molemap visit {name}</h1>\
         <p>stage: <b>{stage}</b> — artifacts in <code>dist/</code> \
         (open <code>scene.sog</code> in a splat viewer, e.g. playcanvas.com/supersplat):</p>\
         <ul>{rows}</ul>",
        name = visit.name,
        stage = visit.meta.stage,
    )
}

pub fn serve(visit: &Visit, port: u16) -> Result<()> {
    let addr = format!("127.0.0.1:{port}");
    let server = tiny_http::Server::http(&addr).map_err(|e| anyhow::anyhow!("bind {addr}: {e}"))?;
    println!(
        "previewing visit {} at http://{addr}/ (Ctrl-C to stop)",
        visit.name
    );

    for request in server.incoming_requests() {
        let url = request.url().trim_start_matches('/').to_string();
        if url.is_empty() {
            let html = page(visit);
            let resp = tiny_http::Response::from_string(html).with_header(
                tiny_http::Header::from_bytes(
                    &b"Content-Type"[..],
                    &b"text/html; charset=utf-8"[..],
                )
                .unwrap(),
            );
            let _ = request.respond(resp);
            continue;
        }
        // Path traversal guard: only plain components.
        let rel = std::path::PathBuf::from(&url);
        let safe = rel.components().all(|c| matches!(c, Component::Normal(_)));
        let full = visit.dist_dir().join(&rel);
        if !safe || !full.is_file() {
            let _ = request
                .respond(tiny_http::Response::from_string("not found").with_status_code(404));
            continue;
        }
        let ct = match full.extension().and_then(|e| e.to_str()).unwrap_or("") {
            "jpg" | "jpeg" => "image/jpeg",
            "png" => "image/png",
            "json" => "application/json",
            "html" => "text/html",
            _ => "application/octet-stream",
        };
        let file =
            std::fs::File::open(&full).with_context(|| format!("open {}", full.display()))?;
        let resp = tiny_http::Response::from_file(file).with_header(
            tiny_http::Header::from_bytes(&b"Content-Type"[..], ct.as_bytes()).unwrap(),
        );
        let _ = request.respond(resp);
    }
    Ok(())
}
