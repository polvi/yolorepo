//! Encodings: base64url without padding for binary fields, lowercase hex for
//! human-read digests.

use crate::{Error, Result};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;

/// base64url, no padding.
pub fn b64u(bytes: impl AsRef<[u8]>) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

/// Decode base64url (padding rejected, per the protocol).
pub fn b64u_decode(s: &str) -> Result<Vec<u8>> {
    URL_SAFE_NO_PAD
        .decode(s)
        .map_err(|e| Error::Encoding(format!("b64u: {e}")))
}

/// Decode base64url into a fixed-size array, rejecting other lengths.
pub fn b64u_decode_n<const N: usize>(s: &str) -> Result<[u8; N]> {
    let v = b64u_decode(s)?;
    v.as_slice()
        .try_into()
        .map_err(|_| Error::Encoding(format!("expected {N} bytes, got {}", v.len())))
}

/// Decode lowercase (or uppercase) hex into a fixed-size array.
pub fn hex_decode_n<const N: usize>(s: &str) -> Result<[u8; N]> {
    let v = hex::decode(s).map_err(|e| Error::Encoding(format!("hex: {e}")))?;
    v.as_slice()
        .try_into()
        .map_err(|_| Error::Encoding(format!("expected {N} bytes, got {}", v.len())))
}

/// Unix seconds now.
pub fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_and_no_padding() {
        let s = b64u([0u8, 1, 2, 3, 4]);
        assert!(!s.contains('='));
        assert_eq!(b64u_decode(&s).unwrap(), vec![0, 1, 2, 3, 4]);
        assert!(b64u_decode("AAEC=").is_err());
        assert!(b64u_decode_n::<3>("AAECAw").is_err());
        assert_eq!(b64u_decode_n::<4>("AAECAw").unwrap(), [0, 1, 2, 3]);
    }
}
