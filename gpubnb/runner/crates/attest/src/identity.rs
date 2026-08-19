//! §2 runner identity: RAM-only HPKE + signing keys, boot nonce, binding.

use ed25519_dalek::SigningKey;
use gpubnb_protocol::doc::ModelInfo;
use gpubnb_protocol::hpke::{derive_hpke_keypair, gen_hpke_keypair};

pub struct Identity {
    pub hpke_sk: [u8; 32],
    pub hpke_pub: [u8; 32],
    pub sign_key: SigningKey,
    pub boot_nonce: [u8; 32],
    pub runner_version: String,
    pub model: ModelInfo,
    pub model_digest: [u8; 32],
    pub binding: [u8; 32],
}

impl std::fmt::Debug for Identity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Identity")
            .field("hpke_pub", &hex::encode(self.hpke_pub))
            .field("sign_pub", &hex::encode(self.sign_pub()))
            .field("binding", &hex::encode(self.binding))
            .field("runner_version", &self.runner_version)
            .field("model", &self.model)
            .finish()
    }
}

impl Identity {
    /// Fresh random identity (what `gpubnbd run` does at boot).
    pub fn generate(runner_version: &str, model_id: &str, model_digest: [u8; 32], ctx_len: u64) -> Self {
        let (hpke_sk, hpke_pub) = gen_hpke_keypair();
        let seed: [u8; 32] = rand::random();
        let boot_nonce: [u8; 32] = rand::random();
        Self::from_parts(hpke_sk, hpke_pub, SigningKey::from_bytes(&seed), boot_nonce, runner_version, model_id, model_digest, ctx_len)
    }

    /// Deterministic identity from seeds (tests and fixtures only).
    pub fn from_seeds(
        hpke_ikm: &[u8],
        sign_seed: &[u8; 32],
        boot_nonce: [u8; 32],
        runner_version: &str,
        model_id: &str,
        model_digest: [u8; 32],
        ctx_len: u64,
    ) -> Self {
        let (hpke_sk, hpke_pub) = derive_hpke_keypair(hpke_ikm);
        Self::from_parts(hpke_sk, hpke_pub, SigningKey::from_bytes(sign_seed), boot_nonce, runner_version, model_id, model_digest, ctx_len)
    }

    #[allow(clippy::too_many_arguments)]
    fn from_parts(
        hpke_sk: [u8; 32],
        hpke_pub: [u8; 32],
        sign_key: SigningKey,
        boot_nonce: [u8; 32],
        runner_version: &str,
        model_id: &str,
        model_digest: [u8; 32],
        ctx_len: u64,
    ) -> Self {
        let sign_pub = sign_key.verifying_key().to_bytes();
        let binding = gpubnb_protocol::binding(&hpke_pub, &sign_pub, &boot_nonce, runner_version, &model_digest);
        Identity {
            hpke_sk,
            hpke_pub,
            sign_key,
            boot_nonce,
            runner_version: runner_version.to_string(),
            model: ModelInfo { id: model_id.to_string(), digest: hex::encode(model_digest), ctx_len },
            model_digest,
            binding,
        }
    }

    pub fn sign_pub(&self) -> [u8; 32] {
        self.sign_key.verifying_key().to_bytes()
    }
}
