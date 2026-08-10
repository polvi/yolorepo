// All D1 access for tabby. Writes that must be idempotent use client-generated
// UUID primary keys + INSERT OR IGNORE; multi-row writes go through DB.batch,
// which D1 runs atomically.

export interface UserRow {
  id: string;
  display_name: string | null;
  xmr_address: string | null;
}

export interface GroupSummary {
  id: string;
  name: string;
  invite_token: string;
  member_count: number;
  your_net_tab_micro: number;
}

export interface GroupData {
  group: { id: string; name: string; invite_token: string };
  members: UserRow[];
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
  shares: { expense_id: string; user_id: string; share_tab_micro: number }[];
  payments: {
    id: string;
    from_user: string;
    to_user: string;
    amount_tab_micro: number;
    xmr_amount_piconero: number;
    created_at: number;
  }[];
}

export async function upsertUser(db: D1Database, id: string): Promise<void> {
  await db
    .prepare('INSERT OR IGNORE INTO users (id, created_at) VALUES (?, ?)')
    .bind(id, Date.now())
    .run();
}

export async function getUser(db: D1Database, id: string): Promise<UserRow | null> {
  return db
    .prepare('SELECT id, display_name, xmr_address FROM users WHERE id = ?')
    .bind(id)
    .first<UserRow>();
}

export async function updateUser(
  db: D1Database,
  id: string,
  fields: { display_name?: string; xmr_address?: string }
): Promise<void> {
  await db
    .prepare(
      'UPDATE users SET display_name = COALESCE(?, display_name), ' +
        'xmr_address = COALESCE(?, xmr_address) WHERE id = ?'
    )
    .bind(fields.display_name ?? null, fields.xmr_address ?? null, id)
    .run();
}

export async function createGroup(
  db: D1Database,
  args: { id: string; name: string; inviteToken: string; createdBy: string }
): Promise<void> {
  const now = Date.now();
  await db.batch([
    db
      .prepare(
        'INSERT INTO groups (id, name, invite_token, created_by, created_at) VALUES (?, ?, ?, ?, ?)'
      )
      .bind(args.id, args.name, args.inviteToken, args.createdBy, now),
    db
      .prepare('INSERT INTO group_members (group_id, user_id, joined_at) VALUES (?, ?, ?)')
      .bind(args.id, args.createdBy, now),
  ]);
}

export async function groupByToken(
  db: D1Database,
  token: string
): Promise<{ id: string } | null> {
  return db
    .prepare('SELECT id FROM groups WHERE invite_token = ?')
    .bind(token)
    .first<{ id: string }>();
}

export async function addMember(
  db: D1Database,
  groupId: string,
  userId: string
): Promise<void> {
  await db
    .prepare(
      'INSERT OR IGNORE INTO group_members (group_id, user_id, joined_at) VALUES (?, ?, ?)'
    )
    .bind(groupId, userId, Date.now())
    .run();
}

export async function isMember(
  db: D1Database,
  groupId: string,
  userId: string
): Promise<boolean> {
  const row = await db
    .prepare('SELECT 1 AS x FROM group_members WHERE group_id = ? AND user_id = ?')
    .bind(groupId, userId)
    .first();
  return row !== null;
}

export async function listGroups(db: D1Database, userId: string): Promise<GroupSummary[]> {
  const { results } = await db
    .prepare(
      `SELECT g.id, g.name, g.invite_token,
         (SELECT COUNT(*) FROM group_members m WHERE m.group_id = g.id) AS member_count,
         COALESCE((SELECT SUM(e.amount_tab_micro) FROM expenses e
                   WHERE e.group_id = g.id AND e.paid_by = ?1 AND e.deleted_at IS NULL), 0)
       - COALESCE((SELECT SUM(s.share_tab_micro) FROM expense_shares s
                   JOIN expenses e ON e.id = s.expense_id
                   WHERE e.group_id = g.id AND s.user_id = ?1 AND e.deleted_at IS NULL), 0)
       + COALESCE((SELECT SUM(p.amount_tab_micro) FROM payments p
                   WHERE p.group_id = g.id AND p.from_user = ?1), 0)
       - COALESCE((SELECT SUM(p.amount_tab_micro) FROM payments p
                   WHERE p.group_id = g.id AND p.to_user = ?1), 0) AS your_net_tab_micro
       FROM groups g
       JOIN group_members gm ON gm.group_id = g.id AND gm.user_id = ?1
       ORDER BY g.created_at DESC`
    )
    .bind(userId)
    .all<GroupSummary>();
  return results;
}

export async function loadGroup(db: D1Database, groupId: string): Promise<GroupData | null> {
  const group = await db
    .prepare('SELECT id, name, invite_token FROM groups WHERE id = ?')
    .bind(groupId)
    .first<{ id: string; name: string; invite_token: string }>();
  if (!group) return null;

  const [members, expenses, shares, payments] = (await db.batch([
    db
      .prepare(
        `SELECT u.id, u.display_name, u.xmr_address FROM users u
         JOIN group_members gm ON gm.user_id = u.id WHERE gm.group_id = ?
         ORDER BY gm.joined_at`
      )
      .bind(groupId),
    db
      .prepare(
        `SELECT id, description, paid_by, currency, amount_minor, amount_tab_micro, created_at
         FROM expenses WHERE group_id = ? AND deleted_at IS NULL ORDER BY created_at DESC`
      )
      .bind(groupId),
    db
      .prepare(
        `SELECT s.expense_id, s.user_id, s.share_tab_micro FROM expense_shares s
         JOIN expenses e ON e.id = s.expense_id
         WHERE e.group_id = ? AND e.deleted_at IS NULL`
      )
      .bind(groupId),
    db
      .prepare(
        `SELECT id, from_user, to_user, amount_tab_micro, xmr_amount_piconero, created_at
         FROM payments WHERE group_id = ? ORDER BY created_at DESC`
      )
      .bind(groupId),
  ])) as [D1Result, D1Result, D1Result, D1Result];

  const shareRows = shares.results as GroupData['shares'];
  const byExpense = new Map<string, string[]>();
  for (const s of shareRows) {
    const list = byExpense.get(s.expense_id) ?? [];
    list.push(s.user_id);
    byExpense.set(s.expense_id, list);
  }

  return {
    group,
    members: members.results as UserRow[],
    expenses: (expenses.results as Omit<GroupData['expenses'][number], 'participants'>[]).map(
      (e) => ({ ...e, participants: byExpense.get(e.id) ?? [] })
    ),
    shares: shareRows,
    payments: payments.results as GroupData['payments'],
  };
}

export async function insertExpense(
  db: D1Database,
  args: {
    id: string;
    groupId: string;
    description: string;
    paidBy: string;
    currency: string;
    amountMinor: number;
    tabMicroPerUnit: number;
    amountTabMicro: number;
    createdBy: string;
    shares: Map<string, number>;
  }
): Promise<void> {
  const stmts = [
    db
      .prepare(
        `INSERT OR IGNORE INTO expenses
         (id, group_id, description, paid_by, currency, amount_minor,
          tab_micro_per_unit, amount_tab_micro, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        args.id,
        args.groupId,
        args.description,
        args.paidBy,
        args.currency,
        args.amountMinor,
        args.tabMicroPerUnit,
        args.amountTabMicro,
        args.createdBy,
        Date.now()
      ),
  ];
  for (const [userId, share] of args.shares) {
    stmts.push(
      db
        .prepare(
          'INSERT OR IGNORE INTO expense_shares (expense_id, user_id, share_tab_micro) VALUES (?, ?, ?)'
        )
        .bind(args.id, userId, share)
    );
  }
  await db.batch(stmts);
}

export async function softDeleteExpense(
  db: D1Database,
  groupId: string,
  expenseId: string
): Promise<boolean> {
  const res = await db
    .prepare(
      'UPDATE expenses SET deleted_at = ? WHERE id = ? AND group_id = ? AND deleted_at IS NULL'
    )
    .bind(Date.now(), expenseId, groupId)
    .run();
  return res.meta.changes > 0;
}

export async function insertPayment(
  db: D1Database,
  args: {
    id: string;
    groupId: string;
    fromUser: string;
    toUser: string;
    amountTabMicro: number;
    xmrAmountPiconero: number;
    xmrRateTabMicro: number;
  }
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO payments
       (id, group_id, from_user, to_user, amount_tab_micro,
        xmr_amount_piconero, xmr_rate_tab_micro, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      args.id,
      args.groupId,
      args.fromUser,
      args.toUser,
      args.amountTabMicro,
      args.xmrAmountPiconero,
      args.xmrRateTabMicro,
      Date.now()
    )
    .run();
}
