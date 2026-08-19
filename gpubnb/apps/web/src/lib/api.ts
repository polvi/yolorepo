// Typed client for the marketplace's own API (this worker). Renter-side
// traffic to a host's runner never goes through here; that is @gpubnb/client.

export type TrustStatus = 'verified' | 'simulated' | 'stale' | 'failed' | 'offline';

export interface Check {
  id: string;
  ok: boolean;
  detail?: string;
}

export interface Verdict {
  status: 'verified' | 'simulated' | 'failed';
  checks: Check[];
}

export interface SignedBlobJson {
  payload: string;
  sig: string;
  kid?: string;
}

export interface HeartbeatStats {
  at: number;
  sessions_open: number;
  tokens_in_total: number;
  tokens_out_total: number;
  uptime_s: number;
}

// A type alias (not an interface) so it is implicitly indexable and can be
// handed to @gpubnb/client's liberal ListingRecord.
export type Listing = {
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
  attestation: SignedBlobJson | null;
  verdict: Verdict | null;
  verified_at: number | null;
  last_heartbeat: number | null;
  created_at: number;
  stats: HeartbeatStats | null;
  disputes?: number;
};

export type HostListing = Listing & {
  challenge_pending: boolean;
  challenge_issued_at: number | null;
  stored_status: TrustStatus;
};

export interface TokenRow {
  token_hash: string;
  name: string;
  created_at: number;
  last_used_at: number | null;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // keep statusText
    }
    throw new ApiError(res.status, message);
  }
  return res.json() as Promise<T>;
}

export const api = {
  listings: (q: { simulated?: boolean; gpu?: string; model?: string; status?: string } = {}) => {
    const p = new URLSearchParams();
    if (q.simulated) p.set('simulated', '1');
    if (q.gpu) p.set('gpu', q.gpu);
    if (q.model) p.set('model', q.model);
    if (q.status) p.set('status', q.status);
    const qs = p.toString();
    return request<{ listings: Listing[] }>(`/listings${qs ? `?${qs}` : ''}`);
  },
  listing: (id: string) => request<Listing>(`/listings/${encodeURIComponent(id)}`),
  attestations: (id: string) =>
    request<{ attestations: { id: string; received_at: number; status: string; checks: Check[] }[] }>(
      `/listings/${encodeURIComponent(id)}/attestations`
    ),
  golden: () => request<SignedBlobJson>('/golden'),
  models: () => request<SignedBlobJson>('/models'),
  xmrRate: () => request<{ usd_per_xmr_micro: number }>('/rate/xmr'),
  dispute: (body: { listing_id: string; offer: SignedBlobJson; tx_proof: string; note?: string }) =>
    request<{ id: string }>('/disputes', { method: 'POST', body: JSON.stringify(body) }),

  // host (cookie session)
  hostMe: () => request<{ user_id: string; display_name: string; contact: string }>('/host/me'),
  hostListings: () => request<{ listings: HostListing[] }>('/host/listings'),
  deleteListing: (id: string) =>
    request<{ ok: true }>(`/listings/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  tokens: () => request<{ tokens: TokenRow[] }>('/tokens'),
  mintToken: (name: string) =>
    request<{ token: string; token_hash: string; name: string }>('/tokens', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),
  revokeToken: (hash: string) => request<{ ok: true }>(`/tokens/${hash}`, { method: 'DELETE' }),
};
