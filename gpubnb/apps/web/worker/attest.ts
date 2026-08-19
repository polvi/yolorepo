import { fetchNrasJwks, hex, verifyAttestationDoc } from '@gpubnb/protocol';
import type { AttestResult, ListingRow } from './db';
import { golden, models } from './golden';
import {
  CHALLENGE_TTL_MS,
  ZERO_CHALLENGE,
  peekPayload,
  statusAfterAttest,
  type SignedBlobJson,
  type VerdictStatus,
} from './trust';

const JWKS_TTL_SECONDS = 3600;

// NVIDIA's NRAS JWKS rarely rotates; one fetch per hour per colo is plenty and
// keeps attestation verification independent of NRAS availability blips.
export async function cachedNrasJwks(): Promise<JsonWebKey[]> {
  const cacheKey = new Request('https://gpubnb-jwks-cache.internal/nras');
  const cache = (caches as unknown as { default: Cache }).default;
  const hit = await cache.match(cacheKey);
  if (hit) return (await hit.json()) as JsonWebKey[];
  const jwks = await fetchNrasJwks();
  await cache.put(
    cacheKey,
    new Response(JSON.stringify(jwks), {
      headers: {
        'content-type': 'application/json',
        'cache-control': `max-age=${JWKS_TTL_SECONDS}`,
      },
    })
  );
  return jwks;
}

// Run the shared verifier on a doc POSTed by a host's runner and fold the
// verdict into what the listing row should become. Pure apart from the
// verifier's own network use (NRAS JWKS, cached above).
export async function judgeAttestation(
  listing: ListingRow,
  blob: SignedBlobJson,
  now: number
): Promise<AttestResult> {
  const payload = peekPayload(blob);
  const docChallenge = typeof payload?.challenge === 'string' ? payload.challenge : null;

  // A pending marketplace challenge must be answered exactly, except that a
  // freshly booted runner legitimately sends its boot doc (all-zero
  // challenge); doc.fresh still bounds that to ±10 min of now.
  const pending =
    listing.challenge &&
    listing.challenge_issued_at !== null &&
    now - listing.challenge_issued_at <= CHALLENGE_TTL_MS
      ? listing.challenge
      : null;
  const expectedChallenge = pending && docChallenge !== ZERO_CHALLENGE ? pending : undefined;

  const allowSimulated = listing.simulated === 1;
  const [goldenSet, catalog] = await Promise.all([golden(), models()]);
  const verdict = await verifyAttestationDoc(blob, {
    golden: goldenSet,
    models: catalog,
    allowSimulated,
    ...(expectedChallenge ? { expectedChallenge: hex.decode(expectedChallenge) } : {}),
    now,
    fetchJwks: cachedNrasJwks,
  });

  const status = verdict.status as VerdictStatus;
  const trust = statusAfterAttest(status, allowSimulated);
  const doc = (verdict.doc ?? payload ?? {}) as Record<string, unknown>;
  const model = (doc.model ?? {}) as Record<string, unknown>;
  const ok = trust === 'verified' || trust === 'simulated';
  return {
    status,
    trust,
    checks: verdict.checks,
    docJson: JSON.stringify({ payload: blob.payload, sig: blob.sig, ...(blob.kid ? { kid: blob.kid } : {}) }),
    // Identity fields come only from a doc that passed: a failed doc must not
    // be able to swap the keys renters will encrypt to.
    fromDoc: ok
      ? {
          ...(typeof doc.runner_version === 'string' ? { runner_version: doc.runner_version } : {}),
          ...(typeof doc.hpke_pub === 'string' ? { hpke_pub: doc.hpke_pub } : {}),
          ...(typeof doc.sign_pub === 'string' ? { sign_pub: doc.sign_pub } : {}),
          ...(typeof model.id === 'string' ? { model_id: model.id } : {}),
          ...(typeof model.digest === 'string' ? { model_digest: model.digest } : {}),
          ...(typeof model.ctx_len === 'number' ? { ctx_len: model.ctx_len } : {}),
        }
      : {},
  };
}
