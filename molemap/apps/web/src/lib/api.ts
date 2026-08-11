export interface Me {
  user_id: string;
}

export interface Visit {
  id: string;
  captured_at: number;
  status: 'uploaded' | 'ready';
  alignment: string; // JSON: column-major 4x4
  manifest: string | null;
  created_at: number;
  artifact_count: number;
}

export interface Artifact {
  visit_id: string;
  sha256: string;
  kind: 'splat' | 'pointcloud' | 'crop' | 'preview' | 'manifest' | 'detections';
  size: number;
  label: string;
}

export interface Observation {
  id: string;
  visit_id: string;
  captured_at: number;
  crop_sha256: string | null;
  note: string | null;
  diameter_mm: number | null;
  confidence: number | null;
  created_at: number;
  change_score: number | null;
}

export interface Mole {
  id: string;
  label: string;
  canonical_x: number;
  canonical_y: number;
  canonical_z: number;
  source: 'manual' | 'detected';
  status: 'confirmed' | 'proposed' | 'dismissed';
  created_at: number;
  retired_at: number | null;
  latest: Observation | null;
  change_score: number | null;
  observation_count: number;
}

export interface ApiToken {
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

// Same-origin, so the session cookie rides along (splat/point cloud/crop
// loads included).
export function artifactUrl(sha256: string): string {
  return `/api/artifacts/${sha256}`;
}

export const api = {
  me: () => request<Me>('/me'),
  visits: () => request<{ visits: Visit[] }>('/visits'),
  visit: (id: string) => request<{ visit: Visit; artifacts: Artifact[] }>(`/visits/${id}`),
  setAlignment: (id: string, alignment: number[]) =>
    request<{ ok: true }>(`/visits/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ alignment }),
    }),
  moles: () => request<{ moles: Mole[] }>('/moles'),
  mole: (id: string) => request<{ mole: Mole; observations: Observation[] }>(`/moles/${id}`),
  createMole: (position: [number, number, number], label?: string) =>
    request<{ mole: Mole }>('/moles', {
      method: 'POST',
      body: JSON.stringify({ position, ...(label ? { label } : {}) }),
    }),
  patchMole: (id: string, fields: { label?: string; status?: 'confirmed' | 'dismissed'; retired?: boolean }) =>
    request<{ ok: true }>(`/moles/${id}`, { method: 'PATCH', body: JSON.stringify(fields) }),
  putObservation: (
    moleId: string,
    visitId: string,
    fields: { crop_sha256?: string; note?: string; diameter_mm?: number }
  ) =>
    request<{ ok: true }>(`/moles/${moleId}/observations/${visitId}`, {
      method: 'PUT',
      body: JSON.stringify(fields),
    }),
  deleteObservation: (moleId: string, visitId: string) =>
    request<{ ok: true }>(`/moles/${moleId}/observations/${visitId}`, { method: 'DELETE' }),
  tokens: () => request<{ tokens: ApiToken[] }>('/tokens'),
  mintToken: (name: string) =>
    request<{ token: string; token_hash: string; name: string }>('/tokens', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),
  revokeToken: (hash: string) => request<{ ok: true }>(`/tokens/${hash}`, { method: 'DELETE' }),
};
