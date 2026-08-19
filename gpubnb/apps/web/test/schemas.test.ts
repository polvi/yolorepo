import { describe, expect, it } from 'vitest';
import {
  DISPUTE_NOTE_MAX,
  DISPUTE_OFFER_MAX,
  DISPUTE_PROOF_MAX,
  disputeSchema,
  heartbeatSchema,
  listingUpsertSchema,
  signedBlobSchema,
  slugSchema,
} from '../worker/trust';
import { publicListing } from '../worker/serialize';
import type { ListingRow } from '../worker/db';

const validListing = {
  endpoint_url: 'https://gpu1.example.net',
  gpu_model: 'NVIDIA RTX PRO 6000 Blackwell Server Edition',
  cpu_tee: 'snp',
  model_id: 'Qwen/Qwen3-8B',
  ctx_len: 32768,
  price_in_piconero: 1_000_000_000,
  price_out_piconero: 4_000_000_000,
  region: 'us-west',
  simulated: false,
};

describe('listing upsert validation', () => {
  it('accepts a well-formed body and defaults the optionals', () => {
    const { cpu_tee: _c, region: _r, simulated: _s, ...minimal } = validListing;
    const parsed = listingUpsertSchema.safeParse(minimal);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.cpu_tee).toBe('snp');
      expect(parsed.data.region).toBe('');
      expect(parsed.data.simulated).toBe(false);
    }
  });
  it('accepts simulated as 0/1 as well as booleans', () => {
    expect(listingUpsertSchema.safeParse({ ...validListing, simulated: 1 }).success).toBe(true);
    expect(listingUpsertSchema.safeParse({ ...validListing, simulated: 2 }).success).toBe(false);
  });
  it('rejects non-http endpoints, negative prices, fractional ctx, unknown TEEs', () => {
    expect(listingUpsertSchema.safeParse({ ...validListing, endpoint_url: 'ftp://x' }).success).toBe(false);
    expect(listingUpsertSchema.safeParse({ ...validListing, endpoint_url: 'not a url' }).success).toBe(false);
    expect(listingUpsertSchema.safeParse({ ...validListing, price_in_piconero: -1 }).success).toBe(false);
    expect(listingUpsertSchema.safeParse({ ...validListing, ctx_len: 1.5 }).success).toBe(false);
    expect(listingUpsertSchema.safeParse({ ...validListing, cpu_tee: 'tdx' }).success).toBe(false);
    expect(listingUpsertSchema.safeParse({ ...validListing, gpu_model: '' }).success).toBe(false);
  });
  it('slugs are lowercase dns-ish labels', () => {
    expect(slugSchema.safeParse('gpu-1').success).toBe(true);
    expect(slugSchema.safeParse('a').success).toBe(true);
    expect(slugSchema.safeParse('-gpu').success).toBe(false);
    expect(slugSchema.safeParse('GPU').success).toBe(false);
    expect(slugSchema.safeParse('a'.repeat(65)).success).toBe(false);
    expect(slugSchema.safeParse('x y').success).toBe(false);
  });
});

describe('heartbeat + signed blob schemas', () => {
  it('heartbeat needs all four non-negative integers', () => {
    expect(
      heartbeatSchema.safeParse({ sessions_open: 2, tokens_in_total: 10, tokens_out_total: 20, uptime_s: 300 })
        .success
    ).toBe(true);
    expect(heartbeatSchema.safeParse({ sessions_open: -1, tokens_in_total: 0, tokens_out_total: 0, uptime_s: 0 }).success).toBe(false);
    expect(heartbeatSchema.safeParse({ sessions_open: 0 }).success).toBe(false);
  });
  it('signed blobs are payload+sig with optional kid', () => {
    expect(signedBlobSchema.safeParse({ payload: 'eyJ9', sig: 'abc' }).success).toBe(true);
    expect(signedBlobSchema.safeParse({ payload: 'eyJ9', sig: 'abc', kid: 'k' }).success).toBe(true);
    expect(signedBlobSchema.safeParse({ payload: 'eyJ9' }).success).toBe(false);
  });
});

describe('dispute size caps', () => {
  const ok = {
    listing_id: 'abc123',
    offer: { payload: 'eyJ9', sig: 'c2ln', kid: 'k' },
    tx_proof: 'OutProofV2...',
    note: 'paid, got nothing',
  };
  it('accepts a small dispute and defaults the note', () => {
    const { note: _n, ...noNote } = ok;
    const parsed = disputeSchema.safeParse(noNote);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.note).toBe('');
  });
  it('caps the offer payload, tx proof, and note', () => {
    expect(
      disputeSchema.safeParse({ ...ok, offer: { ...ok.offer, payload: 'a'.repeat(DISPUTE_OFFER_MAX + 1) } })
        .success
    ).toBe(false);
    expect(disputeSchema.safeParse({ ...ok, tx_proof: 'a'.repeat(DISPUTE_PROOF_MAX + 1) }).success).toBe(false);
    expect(disputeSchema.safeParse({ ...ok, note: 'a'.repeat(DISPUTE_NOTE_MAX + 1) }).success).toBe(false);
    expect(disputeSchema.safeParse({ ...ok, tx_proof: 'a'.repeat(DISPUTE_PROOF_MAX) }).success).toBe(true);
  });
  it('rejects offers with extra keys (anything beyond a signed blob)', () => {
    expect(
      disputeSchema.safeParse({ ...ok, offer: { ...ok.offer, extra: 'x'.repeat(10_000) } }).success
    ).toBe(false);
  });
  it('requires a tx proof', () => {
    expect(disputeSchema.safeParse({ ...ok, tx_proof: '   ' }).success).toBe(false);
  });
});

describe('publicListing', () => {
  const row: ListingRow = {
    id: 'l1',
    host_id: 'user-secret',
    slug: 'gpu-1',
    endpoint_url: 'https://gpu1.example.net',
    gpu_model: 'NVIDIA RTX PRO 6000 Blackwell Server Edition',
    cpu_tee: 'snp',
    model_id: 'Qwen/Qwen3-8B',
    model_digest: 'ab'.repeat(32),
    ctx_len: 32768,
    price_in_piconero: 1,
    price_out_piconero: 2,
    region: 'eu',
    simulated: 0,
    trust_status: 'verified',
    runner_version: '0.1.0',
    hpke_pub: 'hp',
    sign_pub: 'sp',
    attestation_doc: JSON.stringify({ payload: 'p', sig: 's' }),
    verdict: JSON.stringify({ status: 'verified', checks: [] }),
    verified_at: 1000,
    last_heartbeat: 2000,
    challenge: 'ff'.repeat(32),
    challenge_issued_at: 1500,
    created_at: 1,
    updated_at: 2,
  };
  it('never leaks the host id or pending challenge and parses the JSON columns', () => {
    const pub = publicListing(row, null, 2000 + 60_000) as unknown as Record<string, unknown>;
    expect(pub).not.toHaveProperty('host_id');
    expect(pub).not.toHaveProperty('challenge');
    expect(pub).not.toHaveProperty('challenge_issued_at');
    expect(pub.attestation).toEqual({ payload: 'p', sig: 's' });
    expect(pub.verdict).toEqual({ status: 'verified', checks: [] });
    expect(pub.simulated).toBe(false);
    expect(pub.trust_status).toBe('verified');
  });
  it('derives the effective status from time', () => {
    expect(publicListing(row, null, 2000 + 2 * 3600_000).trust_status).toBe('offline');
  });
});
