//! `gpubnbd` — the gpubnb runner. See `runner/README.md`.

mod config;
mod probe;

use anyhow::{bail, Context};
use clap::{Parser, Subcommand};
use config::Config;
use gpubnb_attest::{Attester, Identity, SimulatedAttester};
use gpubnb_gateway::ledger::{Ledger, LedgerState};
use gpubnb_gateway::upstream::Upstream;
use gpubnb_gateway::{snapshot, Gateway};
use gpubnb_protocol::doc::ListingInfo;
use gpubnb_protocol::{Price, SignedBlob};
use gpubnb_xmr::{FreeCredit, SubaddressSource, WalletRpc, Watcher, WatcherConfig};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

pub const RUNNER_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Parser)]
#[command(name = "gpubnbd", version, about = "gpubnb runner: attested, HPKE-sealed, Monero-metered inference endpoint")]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Run the gateway (+ marketplace loop + Monero watcher).
    Run {
        #[arg(long)]
        config: PathBuf,
        /// No hardware: simulated attestation under the dev root; allows xmr.mode="free" and unlisted model digests.
        #[arg(long)]
        simulate: bool,
    },
    /// Print the model digest (§8) of a weights directory.
    Digest { weights_dir: PathBuf },
    /// Renter-side probe: verify the runner's doc (simulated allowed), open a session, print status, stream one chat.
    Probe {
        #[arg(long, default_value = "http://127.0.0.1:8787")]
        url: String,
        #[arg(long, default_value = "Say hello in five words.")]
        prompt: String,
        #[arg(long, default_value_t = 256)]
        max_tokens: u64,
    },
    /// Print a signed attestation doc for a fresh identity (debugging / verifier development).
    Doc {
        #[arg(long)]
        config: PathBuf,
        /// hex32 challenge (default all-zero)
        #[arg(long)]
        challenge: Option<String>,
        #[arg(long)]
        simulate: bool,
    },
}

fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .with_writer(std::io::stderr)
        .init();
    let cli = Cli::parse();
    match cli.cmd {
        Cmd::Digest { weights_dir } => {
            let d = gpubnb_protocol::digest::model_digest(&weights_dir)?;
            println!("{}", hex::encode(d));
            Ok(())
        }
        Cmd::Doc { config, challenge, simulate } => {
            let cfg = Config::load(&config)?;
            let challenge = match challenge {
                Some(c) => gpubnb_protocol::hex_decode_n::<32>(&c)?,
                None => [0u8; 32],
            };
            let (identity, attester) = boot_identity(&cfg, simulate)?;
            let (_doc, blob) = attester.attest_signed(&identity, challenge)?;
            println!("{}", serde_json::to_string_pretty(&blob)?);
            Ok(())
        }
        Cmd::Probe { url, prompt, max_tokens } => {
            let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build()?;
            rt.block_on(probe::run(&url, &prompt, max_tokens))
        }
        Cmd::Run { config, simulate } => {
            let cfg = Config::load(&config)?;
            let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build()?;
            rt.block_on(run(cfg, simulate))
        }
    }
}

/// Model digest + identity + attester, with the refusals §7/§8 require.
fn boot_identity(cfg: &Config, simulate: bool) -> anyhow::Result<(Identity, Arc<dyn Attester>)> {
    let model_digest = match &cfg.listing.weights_dir {
        Some(dir) => {
            tracing::info!(dir = %dir.display(), "hashing model weights");
            gpubnb_protocol::digest::model_digest(dir).with_context(|| format!("model digest of {}", dir.display()))?
        }
        None if simulate => {
            // No weights on a dev box: a stable placeholder derived from the model id.
            use sha2_shim::sha256;
            sha256(format!("gpubnb-simulated-model:{}", cfg.listing.model_id).as_bytes())
        }
        None => bail!("listing.weights_dir is required (only --simulate may omit it)"),
    };
    tracing::info!(model = %cfg.listing.model_id, digest = %hex::encode(model_digest), "model digest");
    if !simulate {
        let models_json = cfg
            .attest
            .models_json
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("attest.models_json is required outside --simulate"))?;
        check_model_listed(models_json, &cfg.listing.model_id, &model_digest)?;
    } else if let Some(p) = &cfg.attest.models_json {
        if let Err(e) = check_model_listed(p, &cfg.listing.model_id, &model_digest) {
            tracing::warn!(error = %e, "model not in catalog (allowed under --simulate)");
        }
    }
    let identity = Identity::generate(RUNNER_VERSION, &cfg.listing.model_id, model_digest, cfg.listing.ctx_len);
    tracing::info!(?identity, "identity generated (RAM only)");
    let attester: Arc<dyn Attester> = if simulate {
        Arc::new(SimulatedAttester::new(RUNNER_VERSION, &cfg.listing.gpu_model))
    } else {
        real_attester(cfg)?
    };
    Ok((identity, attester))
}

#[cfg(feature = "snp")]
fn real_attester(cfg: &Config) -> anyhow::Result<Arc<dyn Attester>> {
    use gpubnb_attest::snp::{SnpConfig, SnpNvAttester};
    let mut sc = SnpConfig { gpu_model: cfg.listing.gpu_model.clone(), ..SnpConfig::default() };
    sc.vcek_cache_dir = cfg.attest.vcek_cache_dir.clone();
    if let Some(p) = &cfg.attest.nv_attestation_cli {
        sc.nv_attestation_cli = p.clone();
    }
    if let Some(p) = &cfg.attest.nvidia_smi {
        sc.nvidia_smi = p.clone();
    }
    sc.product = cfg.attest.product.clone();
    sc.nras_url = cfg.attest.nras_url.clone();
    Ok(Arc::new(SnpNvAttester::new(sc)?))
}

#[cfg(not(feature = "snp"))]
fn real_attester(_cfg: &Config) -> anyhow::Result<Arc<dyn Attester>> {
    bail!("this gpubnbd was built without the `snp` feature; real attestation is unavailable (use --simulate or rebuild with --features snp)")
}

/// §8: the configured model's digest must appear in the signed catalog.
fn check_model_listed(path: &Path, model_id: &str, digest: &[u8; 32]) -> anyhow::Result<()> {
    let text = std::fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
    let blob: SignedBlob = serde_json::from_str(&text)?;
    let root = gpubnb_protocol::signed::verifying_key_from_b64u(gpubnb_protocol::OFFLINE_ROOT_PUB_B64U)?;
    let payload: serde_json::Value = blob.verify(gpubnb_protocol::DOMAIN_MODELS, &root).context("models.json signature")?;
    let want = hex::encode(digest);
    // Accepted shapes: {"models":{id: digest|{digest}}}, {"entries":[{id,digest}]}, {id: digest}
    let mut found = false;
    if let Some(m) = payload.get("models").and_then(|m| m.as_object()) {
        if let Some(v) = m.get(model_id) {
            found = v.as_str() == Some(&want) || v.get("digest").and_then(|d| d.as_str()) == Some(&want);
        }
    }
    if let Some(arr) = payload.get("entries").and_then(|e| e.as_array()) {
        found |= arr.iter().any(|e| e.get("id").and_then(|i| i.as_str()) == Some(model_id) && e.get("digest").and_then(|d| d.as_str()) == Some(&want));
    }
    if let Some(v) = payload.get(model_id) {
        found |= v.as_str() == Some(&want) || v.get("digest").and_then(|d| d.as_str()) == Some(&want);
    }
    if !found {
        bail!("model {model_id} with digest {want} is not in {}", path.display());
    }
    Ok(())
}

async fn run(cfg: Config, simulate: bool) -> anyhow::Result<()> {
    if simulate {
        tracing::warn!("SIMULATE MODE: no hardware protection; docs verify as `simulated` only");
    }
    if cfg.xmr.mode == "free" && !simulate {
        bail!("xmr.mode = \"free\" is refused unless --simulate");
    }
    if cfg.xmr.mode != "free" && cfg.xmr.mode != "wallet" {
        bail!("xmr.mode must be \"wallet\" or \"free\"");
    }
    let (identity, attester) = boot_identity(&cfg, simulate)?;

    // Ledger: restore snapshot if present.
    let snap_path = cfg.server.state_dir.join("ledger.json");
    let snap_key: Option<[u8; 32]> = if simulate { None } else { Some(derived_snapshot_key()?) };
    let price = Price { in_per_m: cfg.listing.price_in_piconero, out_per_m: cfg.listing.price_out_piconero };
    let ledger = match snapshot::read(&snap_path, snap_key.as_ref())? {
        Some(bytes) => {
            let st: LedgerState = serde_json::from_slice(&bytes).context("parse ledger snapshot")?;
            tracing::info!(sessions = st.sessions.len(), credits = st.credits.len(), "ledger restored from snapshot");
            Arc::new(Ledger::restore(price, st))
        }
        None => Arc::new(Ledger::new(price)),
    };

    // Monero.
    let mut wallet_child: Option<tokio::process::Child> = None;
    let (subaddrs, free): (Arc<dyn SubaddressSource>, Option<u64>) = if cfg.xmr.mode == "free" {
        tracing::warn!(piconero = cfg.xmr.free_piconero, "xmr.mode=free: every session is credited for free");
        (Arc::new(FreeCredit::new(cfg.xmr.address.clone())), Some(cfg.xmr.free_piconero))
    } else {
        let address = cfg.xmr.address.clone().ok_or_else(|| anyhow::anyhow!("xmr.address required"))?;
        let view_key = cfg.xmr.view_key.clone().ok_or_else(|| anyhow::anyhow!("xmr.view_key required"))?;
        let rpc_url = match (&cfg.xmr.wallet_rpc_url, &cfg.xmr.wallet_rpc_bin) {
            (Some(u), _) => u.clone(),
            (None, Some(bin)) => {
                let node = cfg.xmr.node_url.clone().ok_or_else(|| anyhow::anyhow!("xmr.node_url required to spawn wallet-rpc"))?;
                let wallet_dir = cfg.xmr.wallet_dir.clone().unwrap_or_else(|| cfg.server.state_dir.join("wallet"));
                std::fs::create_dir_all(&wallet_dir)?;
                let mut cmd = tokio::process::Command::new(bin);
                if let Some(flag) = net_flag(&cfg.xmr.network) {
                    cmd.arg(flag);
                }
                cmd.arg("--daemon-address").arg(&node)
                    .arg("--trusted-daemon")
                    .arg("--rpc-bind-port").arg(cfg.xmr.wallet_rpc_port.to_string())
                    .arg("--rpc-bind-ip").arg("127.0.0.1")
                    .arg("--disable-rpc-login")
                    .arg("--wallet-dir").arg(&wallet_dir)
                    .arg("--log-level").arg("0");
                tracing::info!(bin = %bin.display(), port = cfg.xmr.wallet_rpc_port, "spawning monero-wallet-rpc");
                wallet_child = Some(cmd.spawn().context("spawn monero-wallet-rpc")?);
                format!("http://127.0.0.1:{}", cfg.xmr.wallet_rpc_port)
            }
            (None, None) => bail!("xmr.wallet_rpc_url or xmr.wallet_rpc_bin required in wallet mode"),
        };
        let rpc = WalletRpc::new(&rpc_url, None);
        // wait for rpc
        let mut ok = false;
        for _ in 0..60 {
            if rpc.call("get_version", serde_json::json!({})).await.is_ok() {
                ok = true;
                break;
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
        if !ok {
            bail!("monero-wallet-rpc at {rpc_url} did not answer");
        }
        rpc.open_or_generate(&cfg.xmr.wallet_name, &address, &view_key, cfg.xmr.restore_height, "")
            .await
            .context("open/generate view-only wallet")?;
        tracing::info!(network = %cfg.xmr.network, "view-only wallet open");
        // Re-link sessions after a restart: label == session_id.
        if let Ok(addrs) = rpc.get_address(0).await {
            let st = ledger.state.lock();
            for a in addrs.iter().filter(|a| !a.label.is_empty()) {
                match st.sessions.get(&a.label) {
                    Some(s) if s.minor != a.address_index => tracing::warn!(session = %a.label, snapshot = s.minor, wallet = a.address_index, "subaddress index mismatch"),
                    _ => {}
                }
            }
        }
        let watcher = Watcher::new(
            rpc.clone(),
            WatcherConfig { confirmations: cfg.xmr.confirmations, poll_interval: Duration::from_secs(cfg.xmr.poll_interval_s), ..Default::default() },
        );
        let sink: Arc<dyn gpubnb_xmr::CreditSink> = ledger.clone();
        tokio::spawn(watcher.run(sink));
        (Arc::new(WalletSubaddrs { rpc }), None)
    };

    let listing = ListingInfo {
        slug: cfg.listing.slug.clone(),
        gpu_model: cfg.listing.gpu_model.clone(),
        cpu_tee: if simulate { "simulated".into() } else { cfg.listing.cpu_tee.clone() },
        region: cfg.listing.region.clone(),
        simulated: simulate,
    };
    let gw = Arc::new(Gateway {
        identity,
        attester,
        ledger: ledger.clone(),
        subaddrs,
        upstream: Upstream::new(&cfg.upstream.url, &cfg.upstream.model, cfg.upstream.api_key.clone()),
        listing,
        price,
        free_piconero: free,
        session_ttl_s: cfg.server.session_ttl_s,
        default_max_tokens: cfg.upstream.default_max_tokens,
        boot_doc: Default::default(),
        started: std::time::Instant::now(),
    });

    // Boot attestation before serving: in real mode this is also what sets the GPU ready state.
    let boot = gw.boot_doc().await.context("boot attestation")?;
    let verdict = gpubnb_attest::verify::verify_doc(&boot, gpubnb_protocol::enc::now_unix(), Some(&[0u8; 32]), true);
    tracing::info!(status = %verdict.status, "boot attestation doc self-check");
    if verdict.status == "failed" && simulate {
        bail!("simulated boot doc failed self-check: {:?}", verdict.checks);
    }

    // Snapshot loop.
    {
        let gw = gw.clone();
        let path = snap_path.clone();
        let every = Duration::from_secs(cfg.server.snapshot_interval_s.max(1));
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(every).await;
                if let Err(e) = snapshot::write(&path, snap_key.as_ref(), &gw.ledger.snapshot_json()) {
                    tracing::warn!(error = %e, "snapshot failed");
                }
            }
        });
    }

    // Marketplace loop.
    if let Some(mp) = &cfg.marketplace {
        let client = gpubnb_marketplace::Marketplace::new(&mp.url, &mp.token);
        let upsert = gpubnb_marketplace::ListingUpsert {
            endpoint_url: cfg.server.public_url.clone().unwrap_or_else(|| cfg.listing.endpoint_url.clone()),
            gpu_model: cfg.listing.gpu_model.clone(),
            cpu_tee: if simulate { "simulated".into() } else { cfg.listing.cpu_tee.clone() },
            model_id: cfg.listing.model_id.clone(),
            ctx_len: cfg.listing.ctx_len,
            price_in_piconero: cfg.listing.price_in_piconero,
            price_out_piconero: cfg.listing.price_out_piconero,
            region: cfg.listing.region.clone(),
            simulated: simulate,
        };
        tokio::spawn(gpubnb_marketplace::run_loop(gw.clone(), client, cfg.listing.slug.clone(), upsert));
    } else {
        tracing::warn!("no [marketplace] section: running unlisted");
    }

    let app = gpubnb_gateway::router(gw.clone());
    let listener = tokio::net::TcpListener::bind(&cfg.server.listen).await.with_context(|| format!("bind {}", cfg.server.listen))?;
    tracing::info!(listen = %cfg.server.listen, "gpubnbd serving");
    let serve = axum::serve(listener, app).with_graceful_shutdown(shutdown_signal());
    let res = serve.await;
    // final snapshot
    if let Err(e) = snapshot::write(&snap_path, snap_key.as_ref(), &gw.ledger.snapshot_json()) {
        tracing::warn!(error = %e, "final snapshot failed");
    }
    if let Some(mut c) = wallet_child.take() {
        let _ = c.kill().await;
    }
    res.map_err(Into::into)
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("SIGTERM handler");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = term.recv() => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

/// monero-wallet-rpc network flag (mainnet is the default and has no flag).
fn net_flag(network: &str) -> Option<&'static str> {
    match network {
        "stagenet" => Some("--stagenet"),
        "testnet" => Some("--testnet"),
        _ => None,
    }
}

/// Real mode: ledger snapshots are sealed under `SNP_GET_DERIVED_KEY`.
#[cfg(feature = "snp")]
fn derived_snapshot_key() -> anyhow::Result<[u8; 32]> {
    Ok(gpubnb_attest::snp::SnpNvAttester::derived_key()?)
}

#[cfg(not(feature = "snp"))]
fn derived_snapshot_key() -> anyhow::Result<[u8; 32]> {
    bail!("sealed snapshots need the `snp` feature")
}

struct WalletSubaddrs {
    rpc: WalletRpc,
}

#[async_trait_shim::async_trait]
impl SubaddressSource for WalletSubaddrs {
    async fn subaddress_for(&self, session_id: &str) -> gpubnb_xmr::Result<(String, u32)> {
        self.rpc.create_address(0, session_id).await
    }
}

mod async_trait_shim {
    pub use gpubnb_xmr::async_trait::async_trait;
}

mod sha2_shim {
    pub fn sha256(b: &[u8]) -> [u8; 32] {
        gpubnb_protocol::sha256(b)
    }
}
