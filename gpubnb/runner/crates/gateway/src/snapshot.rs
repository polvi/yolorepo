//! Ledger snapshots. Simulate mode: plaintext JSON. Real mode: sealed with
//! ChaCha20-Poly1305 under a 32-byte key the caller obtains from
//! `SNP_GET_DERIVED_KEY` (see `gpubnb_attest::snp::SnpNvAttester::derived_key`),
//! so only the same measured image on the same chip can read it back.
//! Format: magic `GBS1` || 12-byte random nonce || ciphertext.

use chacha20poly1305::aead::{Aead, Payload};
use chacha20poly1305::{ChaCha20Poly1305, KeyInit};
use std::path::Path;

const MAGIC: &[u8; 4] = b"GBS1";
const AAD: &[u8] = b"gpubnb-ledger-snapshot-v1";

pub fn seal(key: &[u8; 32], plaintext: &[u8]) -> Vec<u8> {
    let nonce: [u8; 12] = rand::random();
    let ct = ChaCha20Poly1305::new(&(*key).into())
        .encrypt(&nonce.into(), Payload { msg: plaintext, aad: AAD })
        .expect("seal");
    let mut out = Vec::with_capacity(4 + 12 + ct.len());
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ct);
    out
}

pub fn unseal(key: &[u8; 32], bytes: &[u8]) -> anyhow::Result<Vec<u8>> {
    if bytes.len() < 16 || &bytes[..4] != MAGIC {
        anyhow::bail!("not a sealed snapshot");
    }
    let nonce: [u8; 12] = bytes[4..16].try_into().unwrap();
    ChaCha20Poly1305::new(&(*key).into())
        .decrypt(&nonce.into(), Payload { msg: &bytes[16..], aad: AAD })
        .map_err(|_| anyhow::anyhow!("snapshot unseal failed (different key/image?)"))
}

/// Write atomically (tmp + rename).
pub fn write(path: &Path, key: Option<&[u8; 32]>, json: &[u8]) -> anyhow::Result<()> {
    if let Some(p) = path.parent() {
        std::fs::create_dir_all(p)?;
    }
    let bytes = match key {
        Some(k) => seal(k, json),
        None => json.to_vec(),
    };
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

pub fn read(path: &Path, key: Option<&[u8; 32]>) -> anyhow::Result<Option<Vec<u8>>> {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    Ok(Some(match key {
        Some(k) => unseal(k, &bytes)?,
        None => bytes,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn seal_roundtrip() {
        let k = [3u8; 32];
        let s = seal(&k, b"{}");
        assert_eq!(unseal(&k, &s).unwrap(), b"{}");
        assert!(unseal(&[4u8; 32], &s).is_err());
    }
}
