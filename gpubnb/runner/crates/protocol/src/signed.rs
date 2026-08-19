//! §1 Signed blobs: `{ payload: b64u(JSON bytes), sig: b64u(Ed25519), kid? }`,
//! signature over `DOMAIN || payload_bytes`. No canonical JSON: the payload
//! bytes are whatever the signer serialized, and verifiers parse after
//! checking the signature.

use crate::enc::{b64u, b64u_decode, b64u_decode_n};
use crate::{Error, Result};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use serde::{de::DeserializeOwned, Deserialize, Serialize};

pub const DOMAIN_ATTDOC: &str = "gpubnb-attdoc-v1";
pub const DOMAIN_OFFER: &str = "gpubnb-offer-v1";
pub const DOMAIN_RECEIPT: &str = "gpubnb-receipt-v1";
pub const DOMAIN_GOLDEN: &str = "gpubnb-golden-v1";
pub const DOMAIN_MODELS: &str = "gpubnb-models-v1";
pub const DOMAIN_SIMULATED: &str = "gpubnb-simulated-v1";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SignedBlob {
    pub payload: String,
    pub sig: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kid: Option<String>,
}

/// The message actually signed: `DOMAIN || payload_bytes`.
pub fn signing_input(domain: &str, payload: &[u8]) -> Vec<u8> {
    let mut m = Vec::with_capacity(domain.len() + payload.len());
    m.extend_from_slice(domain.as_bytes());
    m.extend_from_slice(payload);
    m
}

impl SignedBlob {
    /// Sign raw payload bytes (the exact bytes that get base64url-encoded).
    pub fn sign_bytes(domain: &str, payload: &[u8], sk: &SigningKey, kid: Option<&str>) -> Self {
        let sig = sk.sign(&signing_input(domain, payload));
        SignedBlob {
            payload: b64u(payload),
            sig: b64u(sig.to_bytes()),
            kid: kid.map(str::to_string),
        }
    }

    /// Serialize `value` with serde_json (compact) and sign those bytes.
    pub fn sign<T: Serialize>(domain: &str, value: &T, sk: &SigningKey, kid: Option<&str>) -> Result<Self> {
        let bytes = serde_json::to_vec(value)?;
        Ok(Self::sign_bytes(domain, &bytes, sk, kid))
    }

    /// Decoded payload bytes (no signature check).
    pub fn payload_bytes(&self) -> Result<Vec<u8>> {
        b64u_decode(&self.payload)
    }

    /// Parse the payload without verifying. Use only to read `sign_pub` etc. before
    /// verifying under the key found inside (self-signed docs).
    pub fn peek<T: DeserializeOwned>(&self) -> Result<T> {
        Ok(serde_json::from_slice(&self.payload_bytes()?)?)
    }

    /// Verify under `pk` and return the payload bytes.
    pub fn verify_bytes(&self, domain: &str, pk: &VerifyingKey) -> Result<Vec<u8>> {
        let payload = self.payload_bytes()?;
        let sig_bytes: [u8; 64] = b64u_decode_n(&self.sig)?;
        let sig = Signature::from_bytes(&sig_bytes);
        pk.verify(&signing_input(domain, &payload), &sig)
            .map_err(|_| Error::Signature)?;
        Ok(payload)
    }

    /// Verify under `pk` and parse the payload.
    pub fn verify<T: DeserializeOwned>(&self, domain: &str, pk: &VerifyingKey) -> Result<T> {
        let payload = self.verify_bytes(domain, pk)?;
        Ok(serde_json::from_slice(&payload)?)
    }
}

/// Ed25519 signing key from a 32-byte seed.
pub fn signing_key_from_seed(seed: &[u8; 32]) -> SigningKey {
    SigningKey::from_bytes(seed)
}

/// Ed25519 signing key from a b64u seed.
pub fn signing_key_from_b64u(seed: &str) -> Result<SigningKey> {
    Ok(SigningKey::from_bytes(&b64u_decode_n::<32>(seed)?))
}

/// Ed25519 verifying key from b64u public bytes.
pub fn verifying_key_from_b64u(pk: &str) -> Result<VerifyingKey> {
    VerifyingKey::from_bytes(&b64u_decode_n::<32>(pk)?).map_err(|_| Error::Signature)
}

/// Ed25519 verifying key from raw public bytes.
pub fn verifying_key_from_bytes(pk: &[u8; 32]) -> Result<VerifyingKey> {
    VerifyingKey::from_bytes(pk).map_err(|_| Error::Signature)
}

/// The dev root signing key (public knowledge).
pub fn dev_root_signing_key() -> SigningKey {
    signing_key_from_b64u(crate::DEV_ROOT_SEED_B64U).expect("dev root seed is valid")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dev_root_pub_matches_constant() {
        let sk = dev_root_signing_key();
        assert_eq!(b64u(sk.verifying_key().to_bytes()), crate::DEV_ROOT_PUB_B64U);
    }

    #[test]
    fn sign_verify_roundtrip_and_domain_separation() {
        let sk = signing_key_from_seed(&[7u8; 32]);
        let blob = SignedBlob::sign(DOMAIN_OFFER, &serde_json::json!({"a": 1}), &sk, None).unwrap();
        let v: serde_json::Value = blob.verify(DOMAIN_OFFER, &sk.verifying_key()).unwrap();
        assert_eq!(v["a"], 1);
        assert!(blob.verify_bytes(DOMAIN_RECEIPT, &sk.verifying_key()).is_err());
        let other = signing_key_from_seed(&[8u8; 32]);
        assert!(blob.verify_bytes(DOMAIN_OFFER, &other.verifying_key()).is_err());
        // payload bytes are exactly what was serialized
        assert_eq!(blob.payload_bytes().unwrap(), br#"{"a":1}"#.to_vec());
    }
}
