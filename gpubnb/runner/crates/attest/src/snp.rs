//! Real attester: AMD SEV-SNP guest report + NVIDIA GPU detached EAT.
//!
//! Written to spec and unit-tested for the parts that need no hardware
//! (report field parsing, KDS URL building, nvattest output parsing, claims
//! self-check). The device paths (`/dev/sev-guest`, `nvattest`, `nvidia-smi`)
//! are validated on hardware later. Linux only: on other targets
//! [`SnpNvAttester::new`] returns `Error::Unsupported`.
//!
//! Flow per attestation:
//! 1. `REPORT_DATA = SHA512("gpubnb-report-v1" || binding || challenge)` →
//!    `SNP_GET_REPORT` (VMPL 0) via the `sev` crate.
//! 2. VCEK chain: `<vcek_cache_dir>/{vcek,ask,ark}.pem` if present, else AMD KDS
//!    (`/vcek/v1/<product>/<hwid>?<tcb SPLs>` + `/cert_chain`), cached afterwards.
//! 3. `nvattest attest --device gpu --verifier remote --nonce <hex gpu_nonce> --format json`
//!    → `{ detached_eat: [["JWT", overall], {"GPU-0": jwt}] }`.
//! 4. Self-check of EAT claims (§4 item 13, decoded without signature
//!    verification here: nvattest already verified against NRAS, and every
//!    verifier re-checks signatures) and `eat_nonce == gpu_nonce`.
//! 5. Only then `nvidia-smi conf-compute -srs 1` (GPU ready state). A GPU that
//!    failed attestation never serves.

use crate::{Attester, Error, Evidence, Result};
use gpubnb_protocol::doc::{GpuPart, Platform, SnpPart};
use gpubnb_protocol::{gpu_nonce, report_data};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct SnpConfig {
    /// Directory holding (or receiving) `vcek.pem`, `ask.pem`, `ark.pem`.
    pub vcek_cache_dir: Option<PathBuf>,
    /// Path to the nv-attestation-cli binary (`nvattest`).
    pub nv_attestation_cli: PathBuf,
    /// Path to `nvidia-smi`.
    pub nvidia_smi: PathBuf,
    /// GPU model string for the doc (informational; verifiers use the EAT `hwmodel`).
    pub gpu_model: String,
    /// AMD product line for KDS: "Genoa" | "Turin" | "Milan". Auto-detected from the report when `None`.
    pub product: Option<String>,
    /// Optional NRAS URL override for `nvattest --nras-url`.
    pub nras_url: Option<String>,
    /// KDS base URL (override for tests/mirrors).
    pub kds_url: String,
    /// Set the GPU ready state after a successful self-check.
    pub set_ready_state: bool,
}

impl Default for SnpConfig {
    fn default() -> Self {
        SnpConfig {
            vcek_cache_dir: None,
            nv_attestation_cli: "nvattest".into(),
            nvidia_smi: "nvidia-smi".into(),
            gpu_model: "NVIDIA RTX PRO 6000 Blackwell Server Edition".into(),
            product: None,
            nras_url: None,
            kds_url: "https://kdsintf.amd.com".into(),
            set_ready_state: true,
        }
    }
}

pub struct SnpNvAttester {
    pub cfg: SnpConfig,
}

/// Fields of a 1184-byte SNP report the runner needs for KDS lookups.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReportFields {
    pub version: u32,
    pub chip_id: [u8; 64],
    pub reported_tcb: [u8; 8],
    pub cpuid_family: u8,
    pub cpuid_model: u8,
    pub report_data: [u8; 64],
}

pub const REPORT_LEN: usize = 1184;

/// Parse the fields above out of a raw report (layout per AMD SEV-SNP ABI, Table 22).
pub fn parse_report(report: &[u8]) -> Result<ReportFields> {
    if report.len() != REPORT_LEN {
        return Err(Error::Platform(format!("report length {} != {REPORT_LEN}", report.len())));
    }
    let version = u32::from_le_bytes(report[0..4].try_into().unwrap());
    let mut chip_id = [0u8; 64];
    chip_id.copy_from_slice(&report[0x1A0..0x1E0]);
    let mut reported_tcb = [0u8; 8];
    reported_tcb.copy_from_slice(&report[0x180..0x188]);
    let mut rd = [0u8; 64];
    rd.copy_from_slice(&report[0x50..0x90]);
    Ok(ReportFields {
        version,
        chip_id,
        reported_tcb,
        cpuid_family: report[0x188],
        cpuid_model: report[0x189],
        report_data: rd,
    })
}

/// Product line from CPUID family/model (report version >= 3 carries them; older reports need config).
pub fn product_from_cpuid(family: u8, model: u8) -> Option<&'static str> {
    match (family, model) {
        (0x19, 0x00..=0x0f) => Some("Milan"),
        (0x19, 0x10..=0x1f) => Some("Genoa"),
        (0x19, 0xa0..=0xaf) => Some("Genoa"), // Bergamo/Siena share the Genoa KDS endpoint
        (0x1a, _) => Some("Turin"),
        _ => None,
    }
}

/// KDS VCEK URL for a report. TCB byte layout: Milan/Genoa `bl|tee|rsvd*4|snp|ucode`,
/// Turin `fmc|bl|tee|rsvd*3|snp|ucode`.
pub fn kds_vcek_url(base: &str, product: &str, chip_id: &[u8; 64], tcb: &[u8; 8]) -> String {
    let hwid = hex::encode(chip_id);
    if product.eq_ignore_ascii_case("turin") {
        format!(
            "{base}/vcek/v1/Turin/{hwid}?fmcSPL={:02}&blSPL={:02}&teeSPL={:02}&snpSPL={:02}&ucodeSPL={:02}",
            tcb[0], tcb[1], tcb[2], tcb[6], tcb[7]
        )
    } else {
        format!(
            "{base}/vcek/v1/{product}/{hwid}?blSPL={:02}&teeSPL={:02}&snpSPL={:02}&ucodeSPL={:02}",
            tcb[0], tcb[1], tcb[6], tcb[7]
        )
    }
}

pub fn kds_chain_url(base: &str, product: &str) -> String {
    format!("{base}/vcek/v1/{product}/cert_chain")
}

/// DER → PEM.
pub fn der_to_pem(der: &[u8]) -> String {
    use base64::Engine;
    let b = base64::engine::general_purpose::STANDARD.encode(der);
    let mut out = String::from("-----BEGIN CERTIFICATE-----\n");
    for chunk in b.as_bytes().chunks(64) {
        out.push_str(std::str::from_utf8(chunk).unwrap());
        out.push('\n');
    }
    out.push_str("-----END CERTIFICATE-----\n");
    out
}

/// Split a PEM bundle into individual certificates.
pub fn split_pem(bundle: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut inside = false;
    for line in bundle.lines() {
        if line.starts_with("-----BEGIN CERTIFICATE-----") {
            inside = true;
            cur.clear();
        }
        if inside {
            cur.push_str(line.trim_end());
            cur.push('\n');
        }
        if line.starts_with("-----END CERTIFICATE-----") {
            inside = false;
            out.push(cur.clone());
        }
    }
    out
}

/// Parsed `nvattest attest --format json` output.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NvAttestOutput {
    pub overall_jwt: String,
    pub device_jwts: BTreeMap<String, String>,
    pub result_code: i64,
    pub result_message: String,
    pub claims: Vec<serde_json::Value>,
}

/// Parse `{ claims: [...], detached_eat: [["JWT", overall], {"GPU-0": jwt, ...}], result_code, result_message }`.
pub fn parse_nvattest_output(json: &str) -> Result<NvAttestOutput> {
    let v: serde_json::Value = serde_json::from_str(json)?;
    let eat = v
        .get("detached_eat")
        .and_then(|e| e.as_array())
        .ok_or_else(|| Error::GpuSelfCheck("missing detached_eat".into()))?;
    let overall = eat
        .first()
        .and_then(|o| o.as_array())
        .filter(|o| o.len() == 2 && o[0].as_str() == Some("JWT"))
        .and_then(|o| o[1].as_str())
        .ok_or_else(|| Error::GpuSelfCheck("detached_eat[0] is not [\"JWT\", <jwt>]".into()))?
        .to_string();
    let mut device_jwts = BTreeMap::new();
    if let Some(map) = eat.get(1).and_then(|d| d.as_object()) {
        for (k, j) in map {
            if let Some(s) = j.as_str() {
                device_jwts.insert(k.clone(), s.to_string());
            }
        }
    }
    if device_jwts.is_empty() {
        return Err(Error::GpuSelfCheck("no per-device JWTs in detached_eat[1]".into()));
    }
    Ok(NvAttestOutput {
        overall_jwt: overall,
        device_jwts,
        result_code: v.get("result_code").and_then(|c| c.as_i64()).unwrap_or(-1),
        result_message: v.get("result_message").and_then(|m| m.as_str()).unwrap_or("").to_string(),
        claims: v.get("claims").and_then(|c| c.as_array()).cloned().unwrap_or_default(),
    })
}

/// Decode a JWT's payload (no signature check; see module docs).
pub fn jwt_claims(jwt: &str) -> Result<serde_json::Value> {
    use base64::Engine;
    let mut parts = jwt.split('.');
    let (_h, p) = (parts.next(), parts.next().ok_or_else(|| Error::GpuSelfCheck("jwt has no payload".into()))?);
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(p.trim_end_matches('='))
        .map_err(|e| Error::GpuSelfCheck(format!("jwt payload b64: {e}")))?;
    Ok(serde_json::from_slice(&bytes)?)
}

/// `hwmodel` allowlist prefixes (§4 item 13).
pub const HWMODEL_ALLOW: &[&str] = &["RTX PRO 6000 Blackwell Server Edition", "H100", "H200", "B200", "B300"];

pub fn hwmodel_allowed(hwmodel: &str) -> bool {
    let h = hwmodel.trim();
    HWMODEL_ALLOW.iter().any(|p| h.starts_with(p) || h.strip_prefix("NVIDIA ").map(|s| s.starts_with(p)).unwrap_or(false))
}

/// §4 item 12+13 self-check on decoded claims. `now` for `exp`.
pub fn self_check(out: &NvAttestOutput, expected_nonce_hex: &str, now: u64) -> Result<()> {
    if out.result_code != 0 {
        return Err(Error::GpuSelfCheck(format!("nvattest result_code={} ({})", out.result_code, out.result_message)));
    }
    let overall = jwt_claims(&out.overall_jwt)?;
    if overall.get("x-nvidia-overall-att-result").and_then(|b| b.as_bool()) != Some(true) {
        return Err(Error::GpuSelfCheck("overall x-nvidia-overall-att-result != true".into()));
    }
    if let Some(exp) = overall.get("exp").and_then(|e| e.as_u64()) {
        if exp <= now {
            return Err(Error::GpuSelfCheck("overall JWT expired".into()));
        }
    }
    if let Some(n) = overall.get("eat_nonce").and_then(|n| n.as_str()) {
        if !n.eq_ignore_ascii_case(expected_nonce_hex) {
            return Err(Error::GpuSelfCheck("overall eat_nonce mismatch".into()));
        }
    }
    for (dev, jwt) in &out.device_jwts {
        let c = jwt_claims(jwt)?;
        let fail = |what: &str| Error::GpuSelfCheck(format!("{dev}: {what}"));
        if c.get("eat_nonce").and_then(|n| n.as_str()).map(|n| n.eq_ignore_ascii_case(expected_nonce_hex)) != Some(true) {
            return Err(fail("eat_nonce mismatch"));
        }
        if c.get("measres").and_then(|m| m.as_str()).map(|m| m.eq_ignore_ascii_case("success")) != Some(true) {
            return Err(fail("measres != success"));
        }
        if c.get("dbgstat").and_then(|m| m.as_str()).map(|m| m.eq_ignore_ascii_case("disabled")) != Some(true) {
            return Err(fail("dbgstat != disabled"));
        }
        if c.get("secboot").and_then(|b| b.as_bool()) != Some(true) {
            return Err(fail("secboot != true"));
        }
        let hw = c.get("hwmodel").and_then(|h| h.as_str()).unwrap_or("");
        if !hwmodel_allowed(hw) {
            return Err(fail(&format!("hwmodel not allowed: {hw:?}")));
        }
        if let Some(exp) = c.get("exp").and_then(|e| e.as_u64()) {
            if exp <= now {
                return Err(fail("device JWT expired"));
            }
        }
    }
    Ok(())
}

/// Parse `nvidia-smi conf-compute -f` output into "on" | "devtools" | "off".
pub fn parse_cc_mode(s: &str) -> String {
    let l = s.to_ascii_lowercase();
    if l.contains("devtools") {
        "devtools".into()
    } else if l.contains(": on") || l.contains("mode: on") || l.trim_end().ends_with("on") {
        "on".into()
    } else {
        "off".into()
    }
}

impl SnpNvAttester {
    #[cfg(target_os = "linux")]
    pub fn new(cfg: SnpConfig) -> Result<Self> {
        // Fail fast when the guest device is missing: this binary is not in a CVM.
        if !Path::new("/dev/sev-guest").exists() {
            return Err(Error::Platform("/dev/sev-guest not present (not an SEV-SNP guest)".into()));
        }
        Ok(SnpNvAttester { cfg })
    }

    #[cfg(not(target_os = "linux"))]
    pub fn new(_cfg: SnpConfig) -> Result<Self> {
        Err(Error::Unsupported("SnpNvAttester requires Linux (/dev/sev-guest)".into()))
    }

    /// Read (or fetch + cache) the VCEK chain as PEM strings: [vcek, ask, ark].
    fn vcek_chain(&self, fields: &ReportFields) -> Result<Vec<String>> {
        if let Some(dir) = &self.cfg.vcek_cache_dir {
            if let Some(chain) = read_cached_chain(dir) {
                return Ok(chain);
            }
        }
        let product = self
            .cfg
            .product
            .clone()
            .or_else(|| product_from_cpuid(fields.cpuid_family, fields.cpuid_model).map(str::to_string))
            .ok_or_else(|| Error::Platform("cannot determine AMD product; set attest.product".into()))?;
        let vcek_url = kds_vcek_url(&self.cfg.kds_url, &product, &fields.chip_id, &fields.reported_tcb);
        let chain_url = kds_chain_url(&self.cfg.kds_url, &product);
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| Error::Platform(e.to_string()))?;
        let vcek_der = client
            .get(&vcek_url)
            .send()
            .and_then(|r| r.error_for_status())
            .and_then(|r| r.bytes())
            .map_err(|e| Error::Platform(format!("KDS vcek: {e}")))?;
        let chain_pem = client
            .get(&chain_url)
            .send()
            .and_then(|r| r.error_for_status())
            .and_then(|r| r.text())
            .map_err(|e| Error::Platform(format!("KDS cert_chain: {e}")))?;
        let mut chain = vec![der_to_pem(&vcek_der)];
        let rest = split_pem(&chain_pem); // ASK then ARK
        if rest.len() != 2 {
            return Err(Error::Platform(format!("KDS cert_chain had {} certs, expected 2", rest.len())));
        }
        chain.extend(rest);
        if let Some(dir) = &self.cfg.vcek_cache_dir {
            let _ = std::fs::create_dir_all(dir);
            let _ = std::fs::write(dir.join("vcek.pem"), &chain[0]);
            let _ = std::fs::write(dir.join("ask.pem"), &chain[1]);
            let _ = std::fs::write(dir.join("ark.pem"), &chain[2]);
        }
        Ok(chain)
    }

    fn run_nvattest(&self, nonce_hex: &str) -> Result<NvAttestOutput> {
        let mut cmd = std::process::Command::new(&self.cfg.nv_attestation_cli);
        cmd.args(["--format", "json", "attest", "--device", "gpu", "--verifier", "remote", "--nonce", nonce_hex]);
        if let Some(u) = &self.cfg.nras_url {
            cmd.args(["--nras-url", u]);
        }
        let out = cmd.output().map_err(|e| Error::Platform(format!("spawn nvattest: {e}")))?;
        let stdout = String::from_utf8_lossy(&out.stdout);
        // nvattest may exit non-zero on policy mismatch but still print JSON; parse first.
        let parsed = parse_nvattest_output(&stdout).map_err(|e| {
            Error::GpuSelfCheck(format!("{e}; exit={:?}; stderr={}", out.status.code(), String::from_utf8_lossy(&out.stderr)))
        })?;
        Ok(parsed)
    }

    fn cc_mode(&self) -> String {
        std::process::Command::new(&self.cfg.nvidia_smi)
            .args(["conf-compute", "-f"])
            .output()
            .ok()
            .map(|o| parse_cc_mode(&String::from_utf8_lossy(&o.stdout)))
            .unwrap_or_else(|| "off".into())
    }

    fn set_ready_state(&self) -> Result<()> {
        let st = std::process::Command::new(&self.cfg.nvidia_smi)
            .args(["conf-compute", "-srs", "1"])
            .status()
            .map_err(|e| Error::Platform(format!("nvidia-smi: {e}")))?;
        if !st.success() {
            return Err(Error::Platform(format!("nvidia-smi conf-compute -srs 1 exited {st}")));
        }
        Ok(())
    }

    /// 32-byte key from `SNP_GET_DERIVED_KEY` (VCEK root, mixes measurement + guest policy),
    /// used to seal the ledger snapshot. Same image + policy on the same chip → same key.
    #[cfg(target_os = "linux")]
    pub fn derived_key() -> Result<[u8; 32]> {
        use sev::firmware::guest::{DerivedKey, Firmware, GuestFieldSelect};
        let mut fw = Firmware::open()?;
        let mut sel = GuestFieldSelect::default();
        sel.set_measurement(true);
        sel.set_guest_policy(true);
        let req = DerivedKey::new(false, sel, 0, 0, 0, Some(0));
        fw.get_derived_key(None, req).map_err(|e| Error::Platform(format!("derived key: {e:?}")))
    }

    #[cfg(not(target_os = "linux"))]
    pub fn derived_key() -> Result<[u8; 32]> {
        Err(Error::Unsupported("derived key requires Linux".into()))
    }

    #[cfg(target_os = "linux")]
    fn get_report(&self, rd: [u8; 64]) -> Result<Vec<u8>> {
        use sev::firmware::guest::Firmware;
        let mut fw = Firmware::open()?;
        fw.get_report(None, Some(rd), Some(0)).map_err(|e| Error::Platform(format!("SNP_GET_REPORT: {e:?}")))
    }

    #[cfg(not(target_os = "linux"))]
    fn get_report(&self, _rd: [u8; 64]) -> Result<Vec<u8>> {
        Err(Error::Unsupported("SNP report requires Linux".into()))
    }
}

fn read_cached_chain(dir: &Path) -> Option<Vec<String>> {
    let v = std::fs::read_to_string(dir.join("vcek.pem")).ok()?;
    let a = std::fs::read_to_string(dir.join("ask.pem")).ok()?;
    let r = std::fs::read_to_string(dir.join("ark.pem")).ok()?;
    Some(vec![v, a, r])
}

fn cpu_model() -> String {
    std::fs::read_to_string("/proc/cpuinfo")
        .ok()
        .and_then(|s| {
            s.lines()
                .find(|l| l.starts_with("model name"))
                .and_then(|l| l.split(':').nth(1))
                .map(|m| m.trim().to_string())
        })
        .unwrap_or_else(|| "unknown".into())
}

impl Attester for SnpNvAttester {
    fn evidence(&self, binding: &[u8; 32], challenge: &[u8; 32], issued_at: u64) -> Result<Evidence> {
        let rd = report_data(binding, challenge);
        let report = self.get_report(rd)?;
        let fields = parse_report(&report)?;
        if fields.report_data != rd {
            return Err(Error::Platform("report REPORT_DATA mismatch".into()));
        }
        let chain = self.vcek_chain(&fields)?;
        let nonce_hex = hex::encode(gpu_nonce(binding, challenge));
        let nv = self.run_nvattest(&nonce_hex)?;
        self_check(&nv, &nonce_hex, issued_at)?;
        let cc_mode = self.cc_mode();
        if cc_mode != "on" {
            return Err(Error::GpuSelfCheck(format!("GPU CC mode is {cc_mode:?}, need \"on\"")));
        }
        if self.cfg.set_ready_state {
            self.set_ready_state()?;
        }
        Ok(Evidence {
            platform: Platform { kind: "snp".into(), cpu: cpu_model(), gpu_model: self.cfg.gpu_model.clone(), cc_mode },
            snp: Some(SnpPart { report: gpubnb_protocol::b64u(&report), vcek_chain: chain }),
            gpu: Some(GpuPart { overall: nv.overall_jwt, devices: nv.device_jwts }),
            simulated: None,
        })
    }

    fn is_simulated(&self) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;

    fn jwt(payload: serde_json::Value) -> String {
        let b = base64::engine::general_purpose::URL_SAFE_NO_PAD;
        format!("{}.{}.{}", b.encode(r#"{"alg":"ES384"}"#), b.encode(payload.to_string()), b.encode("sig"))
    }

    #[test]
    fn parses_nvattest_json_and_self_checks() {
        let nonce = "ab".repeat(32);
        let overall = jwt(serde_json::json!({"x-nvidia-overall-att-result": true, "eat_nonce": nonce, "exp": 4_000_000_000u64}));
        let dev = jwt(serde_json::json!({"eat_nonce": nonce, "measres": "success", "dbgstat": "disabled", "secboot": true,
            "hwmodel": "NVIDIA RTX PRO 6000 Blackwell Server Edition", "exp": 4_000_000_000u64}));
        let out = serde_json::json!({
            "claims": [{"x-nvidia-device-type": "gpu"}],
            "detached_eat": [["JWT", overall], {"GPU-0": dev}],
            "result_code": 0, "result_message": "Ok"
        });
        let p = parse_nvattest_output(&out.to_string()).unwrap();
        assert_eq!(p.device_jwts.len(), 1);
        self_check(&p, &nonce, 1_700_000_000).unwrap();
        assert!(self_check(&p, &"cd".repeat(32), 1_700_000_000).is_err());

        // devtools / debug enabled must fail
        let bad = jwt(serde_json::json!({"eat_nonce": nonce, "measres": "success", "dbgstat": "enabled", "secboot": true, "hwmodel": "H100"}));
        let out2 = serde_json::json!({"detached_eat": [["JWT", p.overall_jwt], {"GPU-0": bad}], "result_code": 0});
        let p2 = parse_nvattest_output(&out2.to_string()).unwrap();
        assert!(self_check(&p2, &nonce, 1_700_000_000).is_err());
    }

    #[test]
    fn report_fields_and_kds_urls() {
        let mut r = vec![0u8; REPORT_LEN];
        r[0] = 3;
        r[0x188] = 0x19;
        r[0x189] = 0x11;
        r[0x180] = 7; // bl
        r[0x181] = 0; // tee
        r[0x186] = 14; // snp
        r[0x187] = 209; // ucode
        for (i, b) in r[0x1A0..0x1E0].iter_mut().enumerate() {
            *b = i as u8;
        }
        let f = parse_report(&r).unwrap();
        assert_eq!(product_from_cpuid(f.cpuid_family, f.cpuid_model), Some("Genoa"));
        let u = kds_vcek_url("https://kdsintf.amd.com", "Genoa", &f.chip_id, &f.reported_tcb);
        assert!(u.starts_with("https://kdsintf.amd.com/vcek/v1/Genoa/000102"));
        assert!(u.ends_with("?blSPL=07&teeSPL=00&snpSPL=14&ucodeSPL=209"));
        assert!(kds_vcek_url("x", "Turin", &f.chip_id, &f.reported_tcb).contains("fmcSPL="));
        assert!(parse_report(&r[..100]).is_err());
    }

    #[test]
    fn pem_helpers() {
        let pem = der_to_pem(&[1, 2, 3]);
        assert!(pem.starts_with("-----BEGIN CERTIFICATE-----\nAQID\n"));
        let two = format!("{pem}{pem}");
        assert_eq!(split_pem(&two).len(), 2);
        assert!(hwmodel_allowed("NVIDIA H100 80GB HBM3"));
        assert!(hwmodel_allowed("RTX PRO 6000 Blackwell Server Edition"));
        assert!(!hwmodel_allowed("RTX PRO 6000 Blackwell Workstation Edition"));
        assert_eq!(parse_cc_mode("CC status: DEVTOOLS\n"), "devtools");
        assert_eq!(parse_cc_mode("CC status: ON\n"), "on");
        assert_eq!(parse_cc_mode("CC status: OFF\n"), "off");
    }
}
