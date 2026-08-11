export interface Me {
  user_id: string;
  display_name: string | null;
  xmr_address: string | null;
  pref_currency: 'TAB' | 'USD' | 'CAD';
}

export interface GroupSummary {
  id: string;
  name: string;
  invite_token: string;
  member_count: number;
  your_net_tab_micro: number;
}

export interface Member {
  id: string;
  display_name: string | null;
  xmr_address: string | null;
  is_ghost: number;
}

export interface GroupDetail {
  group: { id: string; name: string; invite_token: string };
  members: Member[];
  nets: { user_id: string; net_tab_micro: number }[];
  transfers: { from: string; to: string; amount_tab_micro: number }[];
  expenses: {
    id: string;
    description: string;
    paid_by: string;
    currency: string;
    amount_minor: number;
    amount_tab_micro: number;
    created_at: number;
    participants: string[];
  }[];
  payments: {
    id: string;
    from_user: string;
    to_user: string;
    amount_tab_micro: number;
    xmr_amount_piconero: number;
    created_at: number;
  }[];
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
  updateMe: (fields: { display_name?: string; xmr_address?: string; pref_currency?: string }) =>
    request<Me>('/me', { method: 'PUT', body: JSON.stringify(fields) }),
  groups: () => request<{ groups: GroupSummary[] }>('/groups'),
  createGroup: (name: string) =>
    request<{ id: string; invite_token: string }>('/groups', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),
  group: (id: string) => request<GroupDetail>(`/groups/${id}`),
  addExpense: (
    groupId: string,
    expense: {
      id: string;
      description: string;
      currency: string;
      amount_minor: number;
      paid_by: string;
      participant_ids: string[];
    }
  ) =>
    request<{ ok: true }>(`/groups/${groupId}/expenses`, {
      method: 'POST',
      body: JSON.stringify(expense),
    }),
  updateExpense: (
    groupId: string,
    expenseId: string,
    expense: {
      description: string;
      currency: string;
      amount_minor: number;
      paid_by: string;
      participant_ids: string[];
    }
  ) =>
    request<{ ok: true }>(`/groups/${groupId}/expenses/${expenseId}`, {
      method: 'PUT',
      body: JSON.stringify(expense),
    }),
  deleteExpense: (groupId: string, expenseId: string) =>
    request<{ ok: true }>(`/groups/${groupId}/expenses/${expenseId}`, { method: 'DELETE' }),
  addPayment: (
    groupId: string,
    payment: {
      id: string;
      to_user: string;
      amount_tab_micro: number;
      xmr_amount_piconero: number;
      xmr_rate_tab_micro: number;
    }
  ) =>
    request<{ ok: true }>(`/groups/${groupId}/payments`, {
      method: 'POST',
      body: JSON.stringify(payment),
    }),
  xmrRate: () => request<{ xmr_rate_tab_micro: number; usd_per_cad?: number }>('/rate/xmr'),
  join: (token: string) => request<{ group_id: string }>(`/join/${token}`, { method: 'POST' }),
  addGhost: (groupId: string, name: string) =>
    request<{ user_id: string }>(`/groups/${groupId}/members`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),
  claimGhost: (groupId: string, ghostId: string) =>
    request<{ ok: true }>(`/groups/${groupId}/claim`, {
      method: 'POST',
      body: JSON.stringify({ ghost_id: ghostId }),
    }),
};
