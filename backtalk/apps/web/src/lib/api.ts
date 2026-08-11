export interface Me {
  user_id: string;
}

export interface Project {
  id: string;
  name: string;
  public_key: string;
  allowed_origins: string;
  created_at: number;
  new_feedback?: number;
  open_errors?: number;
}

export interface ProjectCounts {
  feedback: Record<string, number>;
  errors: Record<string, number>;
}

export type FeedbackStatus = 'new' | 'seen' | 'planned' | 'done' | 'declined';
export type ErrorStatus = 'open' | 'resolved' | 'regressed';

export interface FeedbackItem {
  id: string;
  project_id: string;
  kind: 'bug' | 'idea' | 'feedback';
  message: string;
  page_url: string | null;
  viewport: string | null;
  ua: string | null;
  tz: string | null;
  metadata: string | null;
  breadcrumbs: string | null;
  release: string | null;
  status: FeedbackStatus;
  resolution_note: string | null;
  created_at: number;
  updated_at: number;
}

export interface ErrorGroup {
  id: string;
  project_id: string;
  title: string;
  status: ErrorStatus;
  resolution_note: string | null;
  resolved_at: number | null;
  event_count: number;
  first_seen: number;
  last_seen: number;
  first_release: string | null;
  last_release: string | null;
  resolved_in_release: string | null;
}

export interface ErrorEvent {
  id: string;
  group_id: string;
  message: string | null;
  stack: string | null;
  page_url: string | null;
  ua: string | null;
  release: string | null;
  breadcrumbs: string | null;
  created_at: number;
}

export interface VitalsRow {
  day: string;
  path: string;
  metric: 'LCP' | 'INP' | 'CLS';
  count: number;
  sum_value: number;
  good: number;
  needs: number;
  poor: number;
}

export interface PageviewsRow {
  day: string;
  path: string;
  count: number;
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

export const api = {
  me: () => request<Me>('/me'),

  projects: () => request<{ projects: Project[] }>('/projects'),
  createProject: (name: string) =>
    request<{ id: string; public_key: string }>('/projects', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),
  project: (id: string) =>
    request<{ project: Project; counts: ProjectCounts }>(`/projects/${id}`),
  patchProject: (id: string, fields: { name?: string; allowed_origins?: string }) =>
    request<{ ok: true }>(`/projects/${id}`, { method: 'PATCH', body: JSON.stringify(fields) }),
  deleteProject: (id: string) => request<{ ok: true }>(`/projects/${id}`, { method: 'DELETE' }),

  feedback: (projectId: string, status?: string) =>
    request<{ items: FeedbackItem[] }>(
      `/projects/${projectId}/feedback${status ? `?status=${status}` : ''}`
    ),
  patchFeedback: (id: string, status: FeedbackStatus, note?: string) =>
    request<{ ok: true }>(`/feedback/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status, ...(note ? { note } : {}) }),
    }),

  errors: (projectId: string, status?: string) =>
    request<{ groups: ErrorGroup[] }>(
      `/projects/${projectId}/errors${status ? `?status=${status}` : ''}`
    ),
  errorGroup: (gid: string) =>
    request<{ group: ErrorGroup; samples: ErrorEvent[] }>(`/errors/${gid}`),
  patchError: (gid: string, status: 'resolved' | 'open', note?: string) =>
    request<{ ok: true }>(`/errors/${gid}`, {
      method: 'PATCH',
      body: JSON.stringify({ status, ...(note ? { note } : {}) }),
    }),

  stats: (projectId: string, days = 14) =>
    request<{ vitals: VitalsRow[]; pageviews: PageviewsRow[] }>(
      `/projects/${projectId}/stats?days=${days}`
    ),

  tokens: () => request<{ tokens: ApiToken[] }>('/tokens'),
  mintToken: (name: string) =>
    request<{ token: string; token_hash: string; name: string }>('/tokens', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),
  revokeToken: (hash: string) => request<{ ok: true }>(`/tokens/${hash}`, { method: 'DELETE' }),
};
