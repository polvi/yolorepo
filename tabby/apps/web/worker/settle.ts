// Greedy minimal-transfer settlement over integer µTAB nets. Mirrors the
// Greedy operator in specs/Ledger.tla. Deterministic: ties broken by user id.

export interface Transfer {
  from: string;
  to: string;
  amountTabMicro: number;
}

// nets: user id -> net balance in µTAB (positive = owed money). Must sum to 0.
export function settle(nets: Map<string, number>): Transfer[] {
  const creditors: { id: string; bal: number }[] = [];
  const debtors: { id: string; bal: number }[] = [];
  for (const [id, bal] of nets) {
    if (bal > 0) creditors.push({ id, bal });
    else if (bal < 0) debtors.push({ id, bal });
  }
  const byCredit = (a: { id: string; bal: number }, b: { id: string; bal: number }) =>
    b.bal - a.bal || (a.id < b.id ? -1 : 1);
  const byDebt = (a: { id: string; bal: number }, b: { id: string; bal: number }) =>
    a.bal - b.bal || (a.id < b.id ? -1 : 1);

  const out: Transfer[] = [];
  while (creditors.length > 0 && debtors.length > 0) {
    creditors.sort(byCredit);
    debtors.sort(byDebt);
    const c = creditors[0]!;
    const d = debtors[0]!;
    const amount = Math.min(c.bal, -d.bal);
    out.push({ from: d.id, to: c.id, amountTabMicro: amount });
    c.bal -= amount;
    d.bal += amount;
    if (c.bal === 0) creditors.shift();
    if (d.bal === 0) debtors.shift();
  }
  return out;
}

// Derives nets from ledger rows; the double-entry construction guarantees
// the result sums to zero.
export interface LedgerRows {
  expenses: { paidBy: string; amountTabMicro: number }[];
  shares: { userId: string; shareTabMicro: number }[];
  payments: { fromUser: string; toUser: string; amountTabMicro: number }[];
}

export function computeNets(memberIds: string[], rows: LedgerRows): Map<string, number> {
  const nets = new Map<string, number>(memberIds.map((id) => [id, 0]));
  const add = (id: string, delta: number) => nets.set(id, (nets.get(id) ?? 0) + delta);
  for (const e of rows.expenses) add(e.paidBy, e.amountTabMicro);
  for (const s of rows.shares) add(s.userId, -s.shareTabMicro);
  for (const p of rows.payments) {
    add(p.fromUser, p.amountTabMicro);
    add(p.toUser, -p.amountTabMicro);
  }
  return nets;
}
