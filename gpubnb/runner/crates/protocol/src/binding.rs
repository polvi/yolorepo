//! §2 Runner identity and binding.

use sha2::{Digest, Sha256, Sha384, Sha512};

pub const BINDING_DOMAIN: &[u8] = b"gpubnb-binding-v1";
pub const REPORT_DOMAIN: &[u8] = b"gpubnb-report-v1";
pub const GPU_DOMAIN: &[u8] = b"gpubnb-gpu-v1";

/// `binding = SHA256("gpubnb-binding-v1" || hpke_pub || sign_pub || boot_nonce
///                   || SHA256(utf8(runner_version)) || model_digest)`
pub fn binding(
    hpke_pub: &[u8; 32],
    sign_pub: &[u8; 32],
    boot_nonce: &[u8; 32],
    runner_version: &str,
    model_digest: &[u8; 32],
) -> [u8; 32] {
    let ver_hash: [u8; 32] = Sha256::digest(runner_version.as_bytes()).into();
    let mut h = Sha256::new();
    h.update(BINDING_DOMAIN);
    h.update(hpke_pub);
    h.update(sign_pub);
    h.update(boot_nonce);
    h.update(ver_hash);
    h.update(model_digest);
    h.finalize().into()
}

/// `report_data = SHA512("gpubnb-report-v1" || binding || challenge)` → SNP REPORT_DATA.
pub fn report_data(binding: &[u8; 32], challenge: &[u8; 32]) -> [u8; 64] {
    let mut h = Sha512::new();
    h.update(REPORT_DOMAIN);
    h.update(binding);
    h.update(challenge);
    h.finalize().into()
}

/// `gpu_nonce = SHA256("gpubnb-gpu-v1" || binding || challenge)` → GPU attestation nonce.
pub fn gpu_nonce(binding: &[u8; 32], challenge: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(GPU_DOMAIN);
    h.update(binding);
    h.update(challenge);
    h.finalize().into()
}

/// Simulated measurement for a runner version: `sha384("gpubnb-simulated-" + V)` (48 bytes).
pub fn simulated_measurement(runner_version: &str) -> [u8; 48] {
    let mut h = Sha384::new();
    h.update(b"gpubnb-simulated-");
    h.update(runner_version.as_bytes());
    h.finalize().into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deterministic_and_challenge_sensitive() {
        let b = binding(&[1; 32], &[2; 32], &[3; 32], "0.1.0", &[4; 32]);
        let b2 = binding(&[1; 32], &[2; 32], &[3; 32], "0.1.0", &[4; 32]);
        assert_eq!(b, b2);
        assert_ne!(b, binding(&[1; 32], &[2; 32], &[3; 32], "0.1.1", &[4; 32]));
        let rd0 = report_data(&b, &[0; 32]);
        let rd1 = report_data(&b, &[1; 32]);
        assert_ne!(rd0, rd1);
        assert_ne!(gpu_nonce(&b, &[0; 32]), gpu_nonce(&b, &[1; 32]));
        assert_eq!(simulated_measurement("0.1.0").len(), 48);
    }
}
