import { b64u, hex, randomBytes, verifyAttestationDoc, verifyGolden, verifyModels, type Check, type GoldenSet, type ModelCatalog, type SignedBlob, type Verdict } from "@gpubnb/protocol";

/** What the marketplace returns for a listing. Deliberately liberal: only `endpoint_url` is required here. */
export interface ListingRecord {
  id?: string;
  slug?: string;
  endpoint_url: string;
  hpke_pub?: string | null;
  sign_pub?: string | null;
  attestation?: SignedBlob | null;
  attestation_doc?: SignedBlob | null;
  trust_status?: "verified" | "simulated" | "stale" | "failed" | "offline" | (string & {});
  simulated?: boolean | number;
  model_id?: string;
  model_digest?: string | null;
  ctx_len?: number;
  gpu_model?: string;
  cpu_tee?: string;
  region?: string;
  runner_version?: string;
  price_in_piconero?: number | string;
  price_out_piconero?: number | string;
  last_heartbeat?: number | string | null;
  verified_at?: number | string | null;
  [k: string]: unknown;
}

export const ATTESTATION_PATH = "/.well-known/gpubnb/attestation";
export const INFO_PATH = "/.well-known/gpubnb/info";

export function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, "") + path;
}

export async function fetchGolden(marketplaceOrigin: string, f: typeof fetch = fetch): Promise<GoldenSet> {
  const r = await f(joinUrl(marketplaceOrigin, "/api/golden"), { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`GET /api/golden: HTTP ${r.status}`);
  return verifyGolden((await r.json()) as SignedBlob);
}

export async function fetchModels(marketplaceOrigin: string, f: typeof fetch = fetch): Promise<ModelCatalog> {
  const r = await f(joinUrl(marketplaceOrigin, "/api/models"), { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`GET /api/models: HTTP ${r.status}`);
  return verifyModels((await r.json()) as SignedBlob);
}

export async function fetchListings(marketplaceOrigin: string, opts: { simulated?: boolean; gpu?: string; model?: string; fetch?: typeof fetch } = {}): Promise<ListingRecord[]> {
  const u = new URL(joinUrl(marketplaceOrigin, "/api/listings"));
  if (opts.simulated) u.searchParams.set("simulated", "1");
  if (opts.gpu) u.searchParams.set("gpu", opts.gpu);
  if (opts.model) u.searchParams.set("model", opts.model);
  const r = await (opts.fetch ?? fetch)(u, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`GET /api/listings: HTTP ${r.status}`);
  const j = (await r.json()) as { listings?: ListingRecord[] } | ListingRecord[];
  return Array.isArray(j) ? j : (j.listings ?? []);
}

export async function fetchListing(marketplaceOrigin: string, id: string, f: typeof fetch = fetch): Promise<ListingRecord> {
  const r = await f(joinUrl(marketplaceOrigin, `/api/listings/${encodeURIComponent(id)}`), { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`GET /api/listings/${id}: HTTP ${r.status}`);
  const j = (await r.json()) as { listing?: ListingRecord } & ListingRecord;
  return j.listing ?? j;
}

/** Fetch a signed attestation doc straight from the runner, with a caller-chosen challenge. */
export async function fetchAttestation(endpointUrl: string, challenge?: Uint8Array, f: typeof fetch = fetch): Promise<SignedBlob> {
  const u = new URL(joinUrl(endpointUrl, ATTESTATION_PATH));
  if (challenge) u.searchParams.set("challenge", hex.encode(challenge));
  const r = await f(u, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`GET ${ATTESTATION_PATH}: HTTP ${r.status}`);
  const blob = (await r.json()) as SignedBlob;
  if (!blob || typeof blob.payload !== "string" || typeof blob.sig !== "string") throw new Error("attestation endpoint did not return a signed blob");
  return blob;
}

export interface VerifyListingOptions {
  golden: GoldenSet;
  allowSimulated?: boolean;
  /** Fetch a fresh doc from the runner with a random 32-byte challenge instead of trusting the marketplace's stored doc. */
  challenge?: boolean;
  models?: ModelCatalog;
  fetch?: typeof fetch;
  fetchJwks?: () => Promise<JsonWebKey[]>;
  now?: number;
}

/**
 * Re-run the protocol verifier locally on a listing. With `challenge: true` the doc is fetched from the
 * runner with a fresh random challenge (proves liveness and key possession right now); otherwise the
 * doc embedded in the listing is verified. When the listing carries `hpke_pub`/`sign_pub`, an extra
 * `listing.keys` check confirms the doc speaks for the same runner identity the marketplace shows.
 */
export async function verifyListing(listing: ListingRecord, opts: VerifyListingOptions): Promise<Verdict> {
  const f = opts.fetch ?? fetch;
  let blob: SignedBlob | null | undefined;
  let challenge: Uint8Array | undefined;
  const pre: Check[] = [];
  if (opts.challenge) {
    challenge = randomBytes(32);
    try { blob = await fetchAttestation(listing.endpoint_url, challenge, f); }
    catch (e) { return { status: "failed", checks: [{ id: "listing.fetch", ok: false, detail: `cannot fetch fresh attestation: ${(e as Error).message}` }] }; }
  } else {
    blob = listing.attestation ?? listing.attestation_doc;
    if (!blob) return { status: "failed", checks: [{ id: "listing.doc", ok: false, detail: "listing carries no attestation doc (use challenge: true to fetch one)" }] };
  }
  const verdict = await verifyAttestationDoc(blob, { golden: opts.golden, allowSimulated: opts.allowSimulated, expectedChallenge: challenge, models: opts.models, fetch: f, fetchJwks: opts.fetchJwks, now: opts.now });
  if (verdict.doc && (listing.hpke_pub || listing.sign_pub)) {
    const problems: string[] = [];
    if (listing.hpke_pub && !sameKey(listing.hpke_pub, verdict.doc.hpke_pub)) problems.push("hpke_pub differs from listing");
    if (listing.sign_pub && !sameKey(listing.sign_pub, verdict.doc.sign_pub)) problems.push("sign_pub differs from listing");
    const ok = problems.length === 0;
    verdict.checks.push({ id: "listing.keys", ok, detail: ok ? "doc keys match the listing" : problems.join("; ") });
    if (!ok) verdict.status = "failed";
  }
  verdict.checks.unshift(...pre);
  return verdict;
}

function sameKey(a: string, b: string): boolean {
  try { return hex.encode(decodeAny(a)) === hex.encode(decodeAny(b)); } catch { return false; }
}
function decodeAny(s: string): Uint8Array {
  if (/^[0-9a-fA-F]{64}$/.test(s)) return hex.decode(s);
  return b64u.decode(s);
}
