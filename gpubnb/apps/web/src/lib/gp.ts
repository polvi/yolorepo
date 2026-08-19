// Thin adapter over @gpubnb/client + @gpubnb/protocol so the views depend on
// one small surface. Verification happens HERE, in the renter's browser, with
// the AMD/NVIDIA roots and the offline golden-signing key pinned inside the
// packages; the marketplace's own verdict is shown for comparison only.
import { GpubnbClient, verifyListing as sdkVerifyListing, type SessionJSON } from '@gpubnb/client';
import {
  peekBlob,
  verifyGolden,
  verifyModels,
  type GoldenSet,
  type ModelCatalog,
  type Receipt,
  type SignedBlob,
  type Verdict,
} from '@gpubnb/protocol';
import { api, type Listing } from './api';

let goldenPromise: Promise<GoldenSet> | null = null;
let modelsPromise: Promise<ModelCatalog> | null = null;

// The blobs come from the marketplace, but they are only trusted because they
// verify under the root key pinned in @gpubnb/protocol.
export function golden(): Promise<GoldenSet> {
  if (!goldenPromise) {
    goldenPromise = api
      .golden()
      .then((blob) => verifyGolden(blob as SignedBlob))
      .catch((err) => {
        goldenPromise = null;
        throw err;
      });
  }
  return goldenPromise;
}

export function models(): Promise<ModelCatalog> {
  if (!modelsPromise) {
    modelsPromise = api
      .models()
      .then((blob) => verifyModels(blob as SignedBlob))
      .catch((err) => {
        modelsPromise = null;
        throw err;
      });
  }
  return modelsPromise;
}

export async function verifyListingInBrowser(listing: Listing): Promise<Verdict> {
  const [g, m] = await Promise.all([golden(), models()]);
  // ListingRecord says runner_version?: string; ours may be null before the
  // first attestation. Strip the nulls the SDK does not model.
  const record = { ...listing, runner_version: listing.runner_version ?? undefined };
  return sdkVerifyListing(record, {
    golden: g,
    models: m,
    allowSimulated: listing.simulated,
    challenge: true,
  });
}

export type Client = GpubnbClient;
export type { SessionJSON };

// Connect = fetch a fresh doc with our own challenge, verify it, and bind the
// client to the attested hpke_pub/sign_pub. Throws NotVerifiedError on failure.
export async function connect(listing: Listing): Promise<{ client: GpubnbClient; verdict: Verdict }> {
  const [g, m] = await Promise.all([golden(), models()]);
  const { client, verdict } = await GpubnbClient.connect({
    endpointUrl: listing.endpoint_url,
    golden: g,
    models: m,
    allowSimulated: listing.simulated,
  });
  return { client, verdict };
}

// Restore a stored session onto a freshly connected client. Throws if the
// stored session was for a different endpoint or is malformed.
export function restore(client: GpubnbClient, json: unknown): void {
  client.restoreSession(GpubnbClient.importSession(json as SessionJSON));
}

// Receipts are verified by the client before they are yielded; this only
// decodes the payload for display.
export function receiptPayload(blob: SignedBlob): Receipt | null {
  return peekBlob<Receipt>(blob);
}
