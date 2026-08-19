// Pure trust-status rules and request schemas. No D1 here so the rules are
// unit-testable; listings.ts / attest.ts / heartbeat.ts / public.ts apply them.
import { z } from 'zod';

export type TrustStatus = 'verified' | 'simulated' | 'stale' | 'failed' | 'offline';
export type VerdictStatus = 'verified' | 'simulated' | 'failed';

export const HEARTBEAT_STALE_MS = 15 * 60 * 1000;
export const HEARTBEAT_OFFLINE_MS = 60 * 60 * 1000;
export const CHALLENGE_TTL_MS = 10 * 60 * 1000;
export const REATTEST_EVERY_MS = 6 * 60 * 60 * 1000;

export interface TrustInputs {
  trust_status: TrustStatus;
  simulated: number;
  verified_at: number | null;
  last_heartbeat: number | null;
  challenge: string | null;
  challenge_issued_at: number | null;
}

// Stored status after an attestation verdict lands. A simulated doc is only
// ever "simulated" on a listing that declared itself simulated; on a real
// listing it is a failure (the host claimed hardware it could not prove).
export function statusAfterAttest(verdict: VerdictStatus, listingSimulated: boolean): TrustStatus {
  if (verdict === 'verified') return 'verified';
  if (verdict === 'simulated') return listingSimulated ? 'simulated' : 'failed';
  return 'failed';
}

// Effective status at read time. Stored status is what the last attestation
// said; liveness (heartbeats, answered challenges) is derived here so a dead
// runner decays to stale → offline without anyone writing to the row.
export function effectiveStatus(row: TrustInputs, now: number): TrustStatus {
  if (row.trust_status === 'failed') return 'failed';
  if (row.last_heartbeat === null || now - row.last_heartbeat > HEARTBEAT_OFFLINE_MS) {
    return 'offline';
  }
  if (now - row.last_heartbeat > HEARTBEAT_STALE_MS) return 'stale';
  if (row.verified_at === null) return 'stale';
  if (
    row.challenge !== null &&
    row.challenge_issued_at !== null &&
    now - row.challenge_issued_at > CHALLENGE_TTL_MS
  ) {
    return 'stale';
  }
  if (row.trust_status === 'verified' || row.trust_status === 'simulated') return row.trust_status;
  // Stored stale/offline with a fresh heartbeat and verification: the
  // attest handler always writes verified/simulated/failed, so this branch
  // only covers rows that were never attested (caught above) or hand-edited.
  return 'stale';
}

// Heartbeat-side challenge decision. Returns the challenge the heartbeat
// response should carry: the pending one while it is still fresh, a new one
// when (re)attestation is due, or null when nothing is needed.
export function challengeDecision(
  row: Pick<TrustInputs, 'verified_at' | 'challenge' | 'challenge_issued_at'>,
  now: number,
  fresh: () => string
): { challenge: string | null; issue: boolean } {
  const pendingFresh =
    row.challenge !== null &&
    row.challenge_issued_at !== null &&
    now - row.challenge_issued_at <= CHALLENGE_TTL_MS;
  if (pendingFresh) return { challenge: row.challenge, issue: false };
  const due = row.verified_at === null || now - row.verified_at > REATTEST_EVERY_MS;
  if (due || row.challenge !== null) return { challenge: fresh(), issue: true };
  return { challenge: null, issue: false };
}

export function randomChallengeHex(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const ZERO_CHALLENGE = '0'.repeat(64);

// ---------------------------------------------------------------- schemas

const HEX32 = /^[0-9a-f]{64}$/;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export const slugSchema = z.string().regex(SLUG, 'slug: lowercase letters, digits, dashes');

export const listingUpsertSchema = z.object({
  endpoint_url: z
    .string()
    .url()
    .max(300)
    .refine((u) => /^https?:\/\//.test(u), 'endpoint_url must be http(s)'),
  gpu_model: z.string().trim().min(1).max(120),
  cpu_tee: z.enum(['snp', 'tdx', 'simulated']).default('snp'), // tdx: verifier not shipped yet; listing only
  model_id: z.string().trim().min(1).max(200),
  ctx_len: z.number().int().positive().max(10_000_000),
  price_in_piconero: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  price_out_piconero: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  region: z.string().trim().max(80).default(''),
  simulated: z.union([z.boolean(), z.literal(0), z.literal(1)]).default(false),
});
export type ListingUpsert = z.infer<typeof listingUpsertSchema>;

export const signedBlobSchema = z.object({
  payload: z.string().min(1).max(200_000),
  sig: z.string().min(1).max(200),
  kid: z.string().max(64).optional(),
});
export type SignedBlobJson = z.infer<typeof signedBlobSchema>;

export const heartbeatSchema = z.object({
  sessions_open: z.number().int().min(0).max(1_000_000),
  tokens_in_total: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  tokens_out_total: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  uptime_s: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});

// Disputes are unauthenticated, so the only defence against junk is size:
// an offer is a short signed blob, a tx proof is a tx key / proof string.
export const DISPUTE_OFFER_MAX = 4096;
export const DISPUTE_PROOF_MAX = 4096;
export const DISPUTE_NOTE_MAX = 500;
export const DISPUTES_PER_LISTING_PER_DAY = 50;

export const disputeSchema = z.object({
  listing_id: z.string().min(1).max(64),
  offer: z
    .object({
      payload: z.string().min(1).max(DISPUTE_OFFER_MAX),
      sig: z.string().min(1).max(200),
      kid: z.string().max(64).optional(),
    })
    .strict(),
  tx_proof: z.string().trim().min(1).max(DISPUTE_PROOF_MAX),
  note: z.string().trim().max(DISPUTE_NOTE_MAX).default(''),
});

export function isHex32(s: string): boolean {
  return HEX32.test(s);
}

// Decode a signed blob's payload without verifying it; only used to peek at
// the challenge so the verifier can be told what to expect.
export function peekPayload(blob: { payload: string }): Record<string, unknown> | null {
  try {
    const b64 = blob.payload.replaceAll('-', '+').replaceAll('_', '/');
    const bin = atob(b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '='));
    const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  } catch {
    return null;
  }
}
