//! Forward a chat request to the local OpenAI-compatible server (vLLM,
//! llama-server) and stream it back as events, collecting `usage`.

use futures_util::StreamExt;
use serde_json::Value;

#[derive(Debug, Clone)]
pub struct Upstream {
    /// Base URL, e.g. `http://127.0.0.1:8080` (we append `/v1/chat/completions`).
    pub url: String,
    /// Model name sent upstream (replaces whatever the renter wrote).
    pub model: String,
    pub client: reqwest::Client,
    pub api_key: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Usage {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
}

pub fn parse_usage(v: &Value) -> Option<Usage> {
    let u = v.get("usage")?;
    if u.is_null() {
        return None;
    }
    Some(Usage {
        prompt_tokens: u.get("prompt_tokens").and_then(|x| x.as_u64()).unwrap_or(0),
        completion_tokens: u.get("completion_tokens").and_then(|x| x.as_u64()).unwrap_or(0),
    })
}

/// Rough prompt token estimate for the reservation: chars/4 + 4 per message.
pub fn estimate_prompt_tokens(req: &Value) -> u64 {
    let mut chars = 0usize;
    let mut msgs = 0u64;
    if let Some(arr) = req.get("messages").and_then(|m| m.as_array()) {
        for m in arr {
            msgs += 1;
            match m.get("content") {
                Some(Value::String(s)) => chars += s.len(),
                Some(Value::Array(parts)) => {
                    for p in parts {
                        if let Some(t) = p.get("text").and_then(|t| t.as_str()) {
                            chars += t.len();
                        }
                    }
                }
                _ => {}
            }
        }
    }
    if let Some(t) = req.get("tools") {
        chars += t.to_string().len();
    }
    (chars as u64).div_ceil(4) + 4 * msgs
}

pub fn requested_max_tokens(req: &Value, default_max: u64) -> u64 {
    req.get("max_completion_tokens")
        .or_else(|| req.get("max_tokens"))
        .and_then(|v| v.as_u64())
        .unwrap_or(default_max)
}

/// Parse SSE text into `data:` JSON values; returns (values, done). Leftover stays in `buf`.
pub fn parse_sse(buf: &mut String) -> (Vec<Value>, bool) {
    let mut out = Vec::new();
    let mut done = false;
    while let Some(pos) = buf.find('\n') {
        let line = buf[..pos].trim_end_matches('\r').to_string();
        buf.drain(..=pos);
        let Some(data) = line.strip_prefix("data:") else { continue };
        let data = data.trim();
        if data == "[DONE]" {
            done = true;
            continue;
        }
        if let Ok(v) = serde_json::from_str::<Value>(data) {
            out.push(v);
        }
    }
    (out, done)
}

pub enum UpstreamItem {
    Chunk(Value),
    Response(Value),
}

impl Upstream {
    pub fn new(url: &str, model: &str, api_key: Option<String>) -> Self {
        Upstream {
            url: url.trim_end_matches('/').to_string(),
            model: model.to_string(),
            client: reqwest::Client::builder().build().expect("reqwest client"),
            api_key,
        }
    }

    /// Send the chat request. `on_item` receives chunks (streaming) or the single
    /// response; returns the usage reported upstream (if any) and the number of
    /// content-bearing chunks seen (fallback for servers that omit usage).
    pub async fn chat<F>(&self, mut req: Value, mut on_item: F) -> anyhow::Result<(Option<Usage>, u64)>
    where
        F: FnMut(UpstreamItem) -> bool, // return false to stop
    {
        let stream = req.get("stream").and_then(|s| s.as_bool()).unwrap_or(false);
        req["model"] = Value::String(self.model.clone());
        if stream {
            // Force usage in the final chunk (OpenAI / vLLM / llama-server all honor this).
            let so = req.get("stream_options").cloned().unwrap_or(Value::Object(Default::default()));
            let mut so = if so.is_object() { so } else { Value::Object(Default::default()) };
            so["include_usage"] = Value::Bool(true);
            req["stream_options"] = so;
        }
        let mut rb = self.client.post(format!("{}/v1/chat/completions", self.url)).json(&req);
        if let Some(k) = &self.api_key {
            rb = rb.bearer_auth(k);
        }
        let resp = rb.send().await?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            anyhow::bail!("upstream {status}: {}", text.chars().take(300).collect::<String>());
        }
        if !stream {
            let v: Value = resp.json().await?;
            let usage = parse_usage(&v);
            on_item(UpstreamItem::Response(v));
            return Ok((usage, 1));
        }
        let mut usage = None;
        let mut content_chunks = 0u64;
        let mut buf = String::new();
        let mut body = resp.bytes_stream();
        'outer: while let Some(chunk) = body.next().await {
            let chunk = chunk?;
            buf.push_str(&String::from_utf8_lossy(&chunk));
            let (vals, done) = parse_sse(&mut buf);
            for v in vals {
                if let Some(u) = parse_usage(&v) {
                    usage = Some(u);
                }
                let has_content = v
                    .get("choices")
                    .and_then(|c| c.as_array())
                    .map(|c| c.iter().any(|ch| ch.pointer("/delta/content").map(|x| !x.is_null()).unwrap_or(false)))
                    .unwrap_or(false);
                if has_content {
                    content_chunks += 1;
                }
                if !on_item(UpstreamItem::Chunk(v)) {
                    break 'outer;
                }
            }
            if done {
                break;
            }
        }
        Ok((usage, content_chunks))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sse_and_estimates() {
        let mut buf = String::from("data: {\"a\":1}\n\ndata: [DONE]\n\nxx");
        let (v, done) = parse_sse(&mut buf);
        assert_eq!(v.len(), 1);
        assert!(done);
        assert_eq!(buf, "xx");
        let req = serde_json::json!({"messages":[{"role":"user","content":"12345678"}], "max_tokens": 5});
        assert_eq!(estimate_prompt_tokens(&req), 6);
        assert_eq!(requested_max_tokens(&req, 100), 5);
        assert_eq!(requested_max_tokens(&serde_json::json!({}), 100), 100);
    }
}
