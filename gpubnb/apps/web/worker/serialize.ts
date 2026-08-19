import type { HeartbeatRow, ListingRow } from './db';
import { effectiveStatus, type TrustStatus } from './trust';

export interface PublicListing {
  id: string;
  slug: string;
  endpoint_url: string;
  gpu_model: string;
  cpu_tee: string;
  model_id: string;
  model_digest: string | null;
  ctx_len: number;
  price_in_piconero: number;
  price_out_piconero: number;
  region: string;
  simulated: boolean;
  trust_status: TrustStatus;
  runner_version: string | null;
  hpke_pub: string | null;
  sign_pub: string | null;
  attestation: unknown | null;
  verdict: unknown | null;
  verified_at: number | null;
  last_heartbeat: number | null;
  created_at: number;
  stats: HeartbeatRow | null;
  disputes?: number;
}

function parseJson(s: string | null): unknown | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return null;
  }
}

// The public shape. Host user ids never appear here; `slug` is host-chosen
// and public by design (it is in the runner config).
export function publicListing(
  row: ListingRow,
  stats: HeartbeatRow | null,
  now: number,
  extra: { disputes?: number } = {}
): PublicListing {
  return {
    id: row.id,
    slug: row.slug,
    endpoint_url: row.endpoint_url,
    gpu_model: row.gpu_model,
    cpu_tee: row.cpu_tee,
    model_id: row.model_id,
    model_digest: row.model_digest,
    ctx_len: row.ctx_len,
    price_in_piconero: row.price_in_piconero,
    price_out_piconero: row.price_out_piconero,
    region: row.region,
    simulated: row.simulated === 1,
    trust_status: effectiveStatus(row, now),
    runner_version: row.runner_version,
    hpke_pub: row.hpke_pub,
    sign_pub: row.sign_pub,
    attestation: parseJson(row.attestation_doc),
    verdict: parseJson(row.verdict),
    verified_at: row.verified_at,
    last_heartbeat: row.last_heartbeat,
    created_at: row.created_at,
    stats,
    ...(extra.disputes !== undefined ? { disputes: extra.disputes } : {}),
  };
}
