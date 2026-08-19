//! Simulated attester: `platform.kind = "simulated"`, inner report signed by
//! the checked-in dev root (`kid = gpubnb-dev-root`, DOMAIN `gpubnb-simulated-v1`).

use crate::{Attester, Evidence, Result};
use gpubnb_protocol::doc::{Platform, SimulatedReport};
use gpubnb_protocol::signed::dev_root_signing_key;
use gpubnb_protocol::{gpu_nonce, report_data, simulated_measurement, SignedBlob, DEV_ROOT_KID, DOMAIN_SIMULATED};

pub const SIM_HWMODEL: &str = "SIMULATED";

pub struct SimulatedAttester {
    pub runner_version: String,
    pub gpu_model: String,
}

impl SimulatedAttester {
    pub fn new(runner_version: &str, gpu_model: &str) -> Self {
        SimulatedAttester { runner_version: runner_version.to_string(), gpu_model: gpu_model.to_string() }
    }
}

impl Attester for SimulatedAttester {
    fn evidence(&self, binding: &[u8; 32], challenge: &[u8; 32], issued_at: u64) -> Result<Evidence> {
        let report = SimulatedReport {
            report_data: hex::encode(report_data(binding, challenge)),
            gpu_nonce: hex::encode(gpu_nonce(binding, challenge)),
            measurement: hex::encode(simulated_measurement(&self.runner_version)),
            hwmodel: SIM_HWMODEL.to_string(),
            issued_at,
        };
        let blob = SignedBlob::sign(DOMAIN_SIMULATED, &report, &dev_root_signing_key(), Some(DEV_ROOT_KID))?;
        Ok(Evidence {
            platform: Platform {
                kind: "simulated".into(),
                cpu: SIM_HWMODEL.into(),
                gpu_model: self.gpu_model.clone(),
                cc_mode: "simulated".into(),
            },
            snp: None,
            gpu: None,
            simulated: Some(blob),
        })
    }

    fn is_simulated(&self) -> bool {
        true
    }
}
