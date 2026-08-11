//! CLI configuration (`~/.config/molemap/config.json`) and credentials
//! (`credentials.json`, mode 0600).

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub const DEFAULT_API_ORIGIN: &str = "https://molemap.proc.io";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub api_origin: String,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            api_origin: DEFAULT_API_ORIGIN.into(),
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Credentials {
    api_key: String,
}

pub fn config_dir() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("molemap")
}

/// Load config; env `MOLEMAP_API` overrides the stored/default origin.
pub fn load_config() -> Config {
    let mut cfg: Config = std::fs::read_to_string(config_dir().join("config.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    if let Ok(origin) = std::env::var("MOLEMAP_API") {
        if !origin.is_empty() {
            cfg.api_origin = origin;
        }
    }
    cfg
}

pub fn save_api_key(key: &str) -> Result<PathBuf> {
    let dir = config_dir();
    std::fs::create_dir_all(&dir).with_context(|| format!("create {}", dir.display()))?;
    let path = dir.join("credentials.json");
    let body = serde_json::to_string_pretty(&Credentials {
        api_key: key.to_string(),
    })?;
    std::fs::write(&path, body).with_context(|| format!("write {}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(path)
}

pub fn load_api_key() -> Result<String> {
    let path = config_dir().join("credentials.json");
    let body = std::fs::read_to_string(&path).with_context(|| {
        format!(
            "no credentials at {} — run `molemap login` first",
            path.display()
        )
    })?;
    let creds: Credentials =
        serde_json::from_str(&body).with_context(|| format!("parse {}", path.display()))?;
    Ok(creds.api_key)
}
