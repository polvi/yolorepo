//! Minimal monero-wallet-rpc JSON-RPC 2.0 client for a view-only wallet.

use crate::{Error, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone)]
pub struct WalletRpc {
    client: reqwest::Client,
    url: String,
    basic_auth: Option<(String, String)>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct SubaddrIndex {
    pub major: u32,
    pub minor: u32,
}

/// One entry of `get_transfers` (fields the watcher needs).
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct Transfer {
    pub txid: String,
    pub amount: u64,
    #[serde(default)]
    pub height: u64,
    #[serde(default)]
    pub confirmations: u64,
    pub subaddr_index: SubaddrIndex,
    #[serde(default)]
    pub address: String,
    #[serde(default)]
    pub double_spend_seen: bool,
    #[serde(default)]
    pub unlock_time: u64,
    #[serde(default)]
    pub timestamp: u64,
    #[serde(rename = "type", default)]
    pub kind: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct AddressEntry {
    pub address: String,
    pub address_index: u32,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub used: bool,
}

impl WalletRpc {
    /// `url` like `http://127.0.0.1:18083` (the client appends `/json_rpc`).
    pub fn new(url: &str, basic_auth: Option<(String, String)>) -> Self {
        let url = url.trim_end_matches('/').to_string();
        WalletRpc { client: reqwest::Client::new(), url, basic_auth }
    }

    pub async fn call(&self, method: &str, params: Value) -> Result<Value> {
        let body = json!({"jsonrpc": "2.0", "id": "0", "method": method, "params": params});
        let mut req = self.client.post(format!("{}/json_rpc", self.url)).json(&body);
        if let Some((u, p)) = &self.basic_auth {
            req = req.basic_auth(u, Some(p));
        }
        let resp: Value = req.send().await?.error_for_status()?.json().await?;
        if let Some(err) = resp.get("error") {
            return Err(Error::Rpc {
                code: err.get("code").and_then(|c| c.as_i64()).unwrap_or(-1),
                message: err.get("message").and_then(|m| m.as_str()).unwrap_or("").to_string(),
            });
        }
        resp.get("result").cloned().ok_or_else(|| Error::BadResponse("no result".into()))
    }

    /// Create a view-only wallet from the primary address + private view key.
    pub async fn generate_from_keys(
        &self,
        filename: &str,
        address: &str,
        viewkey: &str,
        restore_height: u64,
        password: &str,
    ) -> Result<()> {
        self.call(
            "generate_from_keys",
            json!({"filename": filename, "address": address, "viewkey": viewkey,
                   "restore_height": restore_height, "password": password, "autosave_current": true}),
        )
        .await?;
        Ok(())
    }

    pub async fn open_wallet(&self, filename: &str, password: &str) -> Result<()> {
        self.call("open_wallet", json!({"filename": filename, "password": password})).await?;
        Ok(())
    }

    /// Open the wallet if it exists, else generate it from keys.
    pub async fn open_or_generate(&self, filename: &str, address: &str, viewkey: &str, restore_height: u64, password: &str) -> Result<()> {
        match self.open_wallet(filename, password).await {
            Ok(()) => Ok(()),
            Err(Error::Rpc { .. }) => self.generate_from_keys(filename, address, viewkey, restore_height, password).await,
            Err(e) => Err(e),
        }
    }

    /// `create_address` with `label = session_id`. Returns `(address, minor)`.
    pub async fn create_address(&self, account_index: u32, label: &str) -> Result<(String, u32)> {
        let r = self.call("create_address", json!({"account_index": account_index, "label": label})).await?;
        let address = r.get("address").and_then(|a| a.as_str()).ok_or_else(|| Error::BadResponse("create_address: no address".into()))?;
        let idx = r.get("address_index").and_then(|a| a.as_u64()).ok_or_else(|| Error::BadResponse("create_address: no address_index".into()))?;
        Ok((address.to_string(), idx as u32))
    }

    /// All subaddresses of an account with labels (re-link sessions after restart).
    pub async fn get_address(&self, account_index: u32) -> Result<Vec<AddressEntry>> {
        let r = self.call("get_address", json!({"account_index": account_index})).await?;
        let v = r.get("addresses").cloned().unwrap_or(Value::Array(vec![]));
        serde_json::from_value(v).map_err(|e| Error::BadResponse(format!("get_address: {e}")))
    }

    pub async fn get_height(&self) -> Result<u64> {
        let r = self.call("get_height", json!({})).await?;
        r.get("height").and_then(|h| h.as_u64()).ok_or_else(|| Error::BadResponse("get_height".into()))
    }

    pub async fn refresh(&self) -> Result<()> {
        let _ = self.call("refresh", json!({})).await?;
        Ok(())
    }

    /// `get_transfers {in, pool}` for account 0 (all subaddresses), optionally filtered by height.
    /// Returns `(confirmed_in, pool)`.
    pub async fn get_transfers(&self, min_height: Option<u64>) -> Result<(Vec<Transfer>, Vec<Transfer>)> {
        let mut params = json!({"in": true, "pool": true, "account_index": 0});
        if let Some(h) = min_height {
            params["filter_by_height"] = json!(true);
            params["min_height"] = json!(h);
        }
        let r = self.call("get_transfers", params).await?;
        let parse = |k: &str| -> Result<Vec<Transfer>> {
            match r.get(k) {
                Some(v) if !v.is_null() => serde_json::from_value(v.clone()).map_err(|e| Error::BadResponse(format!("get_transfers.{k}: {e}"))),
                _ => Ok(vec![]),
            }
        };
        Ok((parse("in")?, parse("pool")?))
    }
}
