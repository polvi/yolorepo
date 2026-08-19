// The signed golden set and model catalog ship inside @gpubnb/protocol
// (GOLDEN_BLOB / MODELS_BLOB, generated from golden/*.json by the package's
// sign-golden script) and are served verbatim by /api/golden and /api/models.
// The worker verifies both once per isolate under the pinned offline root
// before using them to judge attestations, the same way a renter's client
// does: the blob is data, the pinned key is the trust.
import {
  GOLDEN_BLOB,
  MODELS_BLOB,
  verifyGolden,
  verifyModels,
  type GoldenSet,
  type ModelCatalog,
  type SignedBlob,
} from '@gpubnb/protocol';

export const goldenBlob: SignedBlob = GOLDEN_BLOB;
export const modelsBlob: SignedBlob = MODELS_BLOB;

let goldenPromise: Promise<GoldenSet> | null = null;
let modelsPromise: Promise<ModelCatalog> | null = null;

export function golden(): Promise<GoldenSet> {
  if (!goldenPromise) {
    goldenPromise = verifyGolden(goldenBlob).catch((err) => {
      goldenPromise = null;
      throw err;
    });
  }
  return goldenPromise;
}

export function models(): Promise<ModelCatalog> {
  if (!modelsPromise) {
    modelsPromise = verifyModels(modelsBlob).catch((err) => {
      modelsPromise = null;
      throw err;
    });
  }
  return modelsPromise;
}
