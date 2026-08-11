//! Detection-crop embeddings.
//!
//! With the `embed` feature: DINOv2 ViT-S/14 via candle (Metal on Apple
//! Silicon, CPU fallback), weights fetched once from the Hugging Face hub
//! (`lmz/candle-dinov2`). The embedding is the model's output vector for the
//! 518x518 ImageNet-normalized crop; it is only used for nearest-neighbor
//! similarity, so any consistent representation works.
//!
//! Without the feature: a no-op embedder; `detections.json` records
//! `embedding: null`.

use std::path::Path;

pub struct Embedder {
    #[cfg(feature = "embed")]
    inner: Option<real::Inner>,
}

impl Embedder {
    pub fn new() -> Embedder {
        #[cfg(feature = "embed")]
        {
            match real::Inner::new() {
                Ok(inner) => return Embedder { inner: Some(inner) },
                Err(e) => {
                    eprintln!("[embed] embedding disabled: {e}");
                    return Embedder { inner: None };
                }
            }
        }
        #[cfg(not(feature = "embed"))]
        Embedder {}
    }

    /// None when embedding is unavailable or fails for this image.
    pub fn embed_image(&self, path: &Path) -> Option<Vec<f32>> {
        #[cfg(feature = "embed")]
        {
            let inner = self.inner.as_ref()?;
            match inner.embed(path) {
                Ok(v) => Some(v),
                Err(e) => {
                    eprintln!("[embed] failed on {}: {e}", path.display());
                    None
                }
            }
        }
        #[cfg(not(feature = "embed"))]
        {
            let _ = path;
            None
        }
    }
}

impl Default for Embedder {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(feature = "embed")]
mod real {
    use anyhow::{Context, Result};
    use candle_core::{DType, Device, Module, Tensor};
    use candle_nn::VarBuilder;
    use candle_transformers::models::dinov2;
    use std::path::Path;

    const IMG: usize = 518;
    const MEAN: [f32; 3] = [0.485, 0.456, 0.406];
    const STD: [f32; 3] = [0.229, 0.224, 0.225];

    pub struct Inner {
        model: dinov2::DinoVisionTransformer,
        device: Device,
    }

    impl Inner {
        pub fn new() -> Result<Inner> {
            // candle 0.9's Metal backend has no layer-norm kernel for this
            // model, so run on CPU — ViT-S over a few dozen crops is seconds.
            // TODO: forward() returns the 1000-d ImageNet head logits; switch
            // to the 384-d backbone features (CLS before head) for a cleaner
            // fingerprint once candle exposes it here.
            let device = Device::Cpu;
            let api = hf_hub::api::sync::Api::new().context("hf-hub api")?;
            let weights = api
                .model("lmz/candle-dino-v2".to_string())
                .get("dinov2_vits14.safetensors")
                .context("download dinov2_vits14.safetensors")?;
            let vb =
                unsafe { VarBuilder::from_mmaped_safetensors(&[weights], DType::F32, &device)? };
            let model = dinov2::vit_small(vb)?;
            Ok(Inner { model, device })
        }

        pub fn embed(&self, path: &Path) -> Result<Vec<f32>> {
            let img = image::open(path)?
                .resize_exact(
                    IMG as u32,
                    IMG as u32,
                    image::imageops::FilterType::CatmullRom,
                )
                .to_rgb8();
            let mut data = vec![0f32; 3 * IMG * IMG];
            for (y, row) in img.rows().enumerate() {
                for (x, p) in row.enumerate() {
                    for c in 0..3 {
                        data[c * IMG * IMG + y * IMG + x] =
                            (p.0[c] as f32 / 255.0 - MEAN[c]) / STD[c];
                    }
                }
            }
            let xs = Tensor::from_vec(data, (1, 3, IMG, IMG), &self.device)?;
            let ys = self.model.forward(&xs)?;
            let flat = ys.flatten_all()?.to_dtype(DType::F32)?;
            Ok(flat.to_vec1::<f32>()?)
        }
    }
}
