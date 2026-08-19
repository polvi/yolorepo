//! `gpubnbd.toml`.

use serde::Deserialize;
use std::path::PathBuf;

#[derive(Debug, Clone, Deserialize)]
pub struct Config {
    pub listing: Listing,
    pub upstream: Upstream,
    #[serde(default)]
    pub marketplace: Option<Marketplace>,
    pub xmr: Xmr,
    pub server: Server,
    #[serde(default)]
    pub attest: Attest,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Listing {
    pub slug: String,
    pub gpu_model: String,
    #[serde(default = "d_cpu_tee")]
    pub cpu_tee: String,
    pub model_id: String,
    pub weights_dir: Option<PathBuf>,
    #[serde(default = "d_ctx")]
    pub ctx_len: u64,
    #[serde(default)]
    pub region: String,
    pub price_in_piconero: u64,
    pub price_out_piconero: u64,
    /// Public URL renters use (what gets registered).
    pub endpoint_url: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Upstream {
    pub url: String,
    pub model: String,
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default = "d_default_max")]
    pub default_max_tokens: u64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Marketplace {
    pub url: String,
    pub token: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Xmr {
    /// "wallet" | "free" (free only with --simulate)
    #[serde(default = "d_mode")]
    pub mode: String,
    /// "mainnet" | "stagenet" | "testnet"
    #[serde(default = "d_net")]
    pub network: String,
    #[serde(default)]
    pub address: Option<String>,
    #[serde(default)]
    pub view_key: Option<String>,
    #[serde(default)]
    pub node_url: Option<String>,
    /// Existing monero-wallet-rpc to talk to...
    #[serde(default)]
    pub wallet_rpc_url: Option<String>,
    /// ...or a binary to spawn (listening on 127.0.0.1:wallet_rpc_port).
    #[serde(default)]
    pub wallet_rpc_bin: Option<PathBuf>,
    #[serde(default = "d_rpc_port")]
    pub wallet_rpc_port: u16,
    #[serde(default)]
    pub wallet_dir: Option<PathBuf>,
    #[serde(default = "d_wallet_name")]
    pub wallet_name: String,
    #[serde(default)]
    pub restore_height: u64,
    #[serde(default = "d_conf")]
    pub confirmations: u64,
    #[serde(default = "d_poll")]
    pub poll_interval_s: u64,
    #[serde(default = "d_free")]
    pub free_piconero: u64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Server {
    #[serde(default = "d_listen")]
    pub listen: String,
    #[serde(default)]
    pub public_url: Option<String>,
    #[serde(default = "d_state_dir")]
    pub state_dir: PathBuf,
    #[serde(default = "d_snapshot")]
    pub snapshot_interval_s: u64,
    #[serde(default = "d_ttl")]
    pub session_ttl_s: u64,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[cfg_attr(not(feature = "snp"), allow(dead_code))]
pub struct Attest {
    #[serde(default)]
    pub vcek_cache_dir: Option<PathBuf>,
    #[serde(default)]
    pub nv_attestation_cli: Option<PathBuf>,
    #[serde(default)]
    pub nvidia_smi: Option<PathBuf>,
    /// "Genoa" | "Turin" | "Milan" (auto-detected from the report when unset)
    #[serde(default)]
    pub product: Option<String>,
    #[serde(default)]
    pub nras_url: Option<String>,
    /// Signed models catalog (`gpubnb-models-v1`) path; the runner refuses to start
    /// when the configured model's digest is not listed, unless --simulate.
    #[serde(default)]
    pub models_json: Option<PathBuf>,
}

fn d_cpu_tee() -> String { "snp".into() }
fn d_ctx() -> u64 { 32768 }
fn d_default_max() -> u64 { 1024 }
fn d_mode() -> String { "wallet".into() }
fn d_net() -> String { "mainnet".into() }
fn d_rpc_port() -> u16 { 18083 }
fn d_wallet_name() -> String { "gpubnb-view".into() }
fn d_conf() -> u64 { 10 }
fn d_poll() -> u64 { 20 }
fn d_free() -> u64 { 1_000_000_000_000 } // 1 XMR
fn d_listen() -> String { "127.0.0.1:8787".into() }
fn d_state_dir() -> PathBuf { PathBuf::from("./state") }
fn d_snapshot() -> u64 { 30 }
fn d_ttl() -> u64 { 30 * 24 * 3600 }

impl Config {
    pub fn load(path: &std::path::Path) -> anyhow::Result<Config> {
        let text = std::fs::read_to_string(path).map_err(|e| anyhow::anyhow!("read {}: {e}", path.display()))?;
        Ok(toml::from_str(&text)?)
    }
}
