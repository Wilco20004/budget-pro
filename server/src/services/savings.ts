import { v4 as uuid } from 'uuid';
import { db, now } from '../db';
import { splitPatterns } from './categorize';
import { currentPeriod, nextPeriod, Period } from './periods';

// Savings goals — see the savings_goals comment in db.ts for physical vs
// virtual. The balance is derived, never stored, so it can't drift.

export interface GoalRow {
  id: string;
  name: string;
  icon: string | null;
  target: number | null;
  target_date: string | null;
  account_id: string | null;
  tracks_account: number;
  category_id: string | null;
  topup: number;
  match_pattern: string | null;
  opening_balance: number;
  archived: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

function r2(n: number) {
  return Math.round(n * 100) / 100;
}

function accountHasTransactions(accountId: string): boolean {
  return Boolean(db.prepare('SELECT 1 FROM transactions WHERE account_id = ? LIMIT 1').get(accountId));
}

/** Physical goals follow their account once it has imported transactions;
 *  until then (or for virtual goals) the movements count. */
export function balanceSource(g: GoalRow): 'account' | 'movements' {
  return g.tracks_account && g.account_id && accountHasTransactions(g.account_id) ? 'account' : 'movements';
}

export function accountBalance(accountId: string): number {
  const last = db
    .prepare('SELECT balance FROM transactions WHERE account_id = ? AND balance IS NOT NULL ORDER BY date DESC, created_at DESC LIMIT 1')
    .get(accountId) as { balance: number } | undefined;
  if (last) return r2(last.balance);
  // No running balance on the statement: sum what was imported.
  return r2((db.prepare('SELECT COALESCE(SUM(amount), 0) AS s FROM transactions WHERE account_id = ? AND ignored = 0').get(accountId) as { s: number }).s);
}

export function goalBalance(g: GoalRow): number {
  if (balanceSource(g) === 'account') return accountBalance(g.account_id!);
  const s = db.prepare('SELECT COALESCE(SUM(amount), 0) AS s FROM savings_movements WHERE goal_id = ?').get(g.id) as { s: number };
  return r2(g.opening_balance + s.s);
}

/** Money in and out of the goal during a period. */
function periodFlow(g: GoalRow, period: Period): { added: number; withdrawn: number } {
  const row =
    balanceSource(g) === 'account'
      ? db
          .prepare(
            `SELECT COALESCE(SUM(CASE WHEN amount > 0 THEN amount END), 0) AS added, COALESCE(-SUM(CASE WHEN amount < 0 THEN amount END), 0) AS withdrawn
             FROM transactions WHERE account_id = ? AND ignored = 0 AND date BETWEEN ? AND ?`
          )
          .get(g.account_id, period.start, period.end)
      : db
          .prepare(
            `SELECT COALESCE(SUM(CASE WHEN amount > 0 THEN amount END), 0) AS added, COALESCE(-SUM(CASE WHEN amount < 0 THEN amount END), 0) AS withdrawn
             FROM savings_movements WHERE goal_id = ? AND date BETWEEN ? AND ?`
          )
          .get(g.id, period.start, period.end);
  const r = row as { added: number; withdrawn: number };
  return { added: r2(r.added), withdrawn: r2(r.withdrawn) };
}

/** Budget periods from the current one up to and including the one the
 *  target date falls in. */
function periodsUntil(date: string): number {
  let p = currentPeriod();
  let n = 0;
  while (p.start <= date && n < 600) {
    n++;
    p = nextPeriod(p);
  }
  return n;
}

/** Whether the goal still wants its planned top-up. */
function stillSaving(g: GoalRow, balance: number): boolean {
  return !g.archived && (g.target === null || balance < g.target - 0.005);
}

export function describeGoal(g: GoalRow, period: Period = currentPeriod()) {
  const balance = goalBalance(g);
  const acc = g.account_id
    ? (db.prepare('SELECT name FROM accounts WHERE id = ?').get(g.account_id) as { name: string } | undefined)
    : undefined;
  const remaining = g.target !== null ? r2(Math.max(0, g.target - balance)) : null;
  const periodsLeft = g.target_date ? periodsUntil(g.target_date) : null;
  const needed = remaining && periodsLeft ? r2(remaining / periodsLeft) : remaining === 0 ? 0 : null;
  const status =
    g.target === null
      ? 'no_target'
      : remaining === 0
        ? 'reached'
        : needed === null
          ? 'saving'
          : periodsLeft === 0
            ? 'behind'
            : g.topup >= needed - 0.5
              ? 'on_track'
              : 'behind';
  return {
    ...g,
    kind: g.tracks_account ? 'physical' : 'virtual',
    account_name: acc?.name ?? null,
    balance_source: balanceSource(g),
    balance,
    remaining,
    pct: g.target ? r2(Math.min(100, (balance / g.target) * 100)) : null,
    periods_left: periodsLeft,
    /** Per period from now to reach the target by target_date. */
    needed_per_period: needed,
    status,
    planned_this_period: stillSaving(g, balance) ? g.topup : 0,
    this_period: periodFlow(g, period),
  };
}

export function getGoal(id: string): GoalRow | undefined {
  return db.prepare('SELECT * FROM savings_goals WHERE id = ?').get(id) as GoalRow | undefined;
}

/** Goals plus, per account holding goals, how much of the account's balance
 *  isn't assigned to any goal yet. */
export function savingsOverview(period: Period = currentPeriod(), includeArchived = false) {
  const goals = (
    db.prepare(`SELECT * FROM savings_goals ${includeArchived ? '' : 'WHERE archived = 0'} ORDER BY sort_order, name`).all() as GoalRow[]
  ).map((g) => describeGoal(g, period));
  const accountIds = [...new Set(goals.filter((g) => g.account_id).map((g) => g.account_id!))];
  const accounts = accountIds.map((id) => {
    const name = (db.prepare('SELECT name FROM accounts WHERE id = ?').get(id) as { name: string } | undefined)?.name ?? '';
    const imported = accountHasTransactions(id);
    const onIt = goals.filter((g) => g.account_id === id);
    const assigned = r2(onIt.reduce((a, g) => a + g.balance, 0));
    const balance = imported ? accountBalance(id) : null;
    return {
      account_id: id,
      name,
      balance,
      assigned,
      // Only meaningful when the account's balance is known and it holds pots.
      unassigned: balance !== null && !onIt.some((g) => g.balance_source === 'account') ? r2(balance - assigned) : null,
    };
  });
  const total = r2(goals.reduce((a, g) => a + g.balance, 0));
  return { period, total, goals, accounts };
}

/** What goals add to each category's budget (their planned top-ups). */
export function goalBudget(): Map<string, number> {
  const out = new Map<string, number>();
  for (const g of db.prepare('SELECT * FROM savings_goals WHERE archived = 0 AND category_id IS NOT NULL AND topup > 0').all() as GoalRow[]) {
    if (!stillSaving(g, goalBalance(g))) continue;
    out.set(g.category_id!, r2((out.get(g.category_id!) ?? 0) + g.topup));
  }
  return out;
}

/** Sign of a goal movement from a transaction: money leaving another account
 *  goes into the goal; on the goal's own account the transaction's own sign. */
function movementSign(g: GoalRow, tx: { account_id: string; amount: number }): number {
  const s = tx.amount < 0 ? -1 : 1;
  return g.account_id && tx.account_id === g.account_id ? s : -s;
}

/** Links transactions whose description contains a goal's match pattern
 *  (e.g. "VACATION POCKET") as a movement of that goal. Account-backed goals
 *  are skipped — their account already shows the money. */
export function linkSavings(transactionIds?: string[]): number {
  const goals = (db.prepare('SELECT * FROM savings_goals WHERE archived = 0 AND match_pattern IS NOT NULL').all() as GoalRow[])
    .filter((g) => balanceSource(g) === 'movements')
    .map((g) => ({ g, patterns: splitPatterns(g.match_pattern ?? '') }))
    .filter((x) => x.patterns.length);
  if (!goals.length) return 0;
  const txs = (
    transactionIds
      ? transactionIds.map((id) => db.prepare('SELECT id, account_id, date, description, amount FROM transactions WHERE id = ?').get(id))
      : db
          .prepare(
            `SELECT id, account_id, date, description, amount FROM transactions t
             WHERE NOT EXISTS (SELECT 1 FROM savings_movements m WHERE m.transaction_id = t.id)`
          )
          .all()
  ).filter(Boolean) as { id: string; account_id: string; date: string; description: string; amount: number }[];
  const has = db.prepare('SELECT 1 FROM savings_movements WHERE transaction_id = ? LIMIT 1');
  const ins = db.prepare(
    "INSERT INTO savings_movements (id, goal_id, date, amount, transaction_id, note, source, created_at) VALUES (?, ?, ?, ?, ?, NULL, 'auto', ?)"
  );
  let n = 0;
  db.transaction(() => {
    for (const tx of txs) {
      if (has.get(tx.id)) continue;
      const hay = ` ${tx.description.toUpperCase().replace(/\s+/g, ' ')} `;
      // Longest pattern wins, like merchant rules.
      let best: (typeof goals)[number] | null = null;
      let len = 0;
      for (const x of goals) {
        for (const p of x.patterns) {
          if (p.length > len && hay.includes(p)) {
            best = x;
            len = p.length;
          }
        }
      }
      if (!best) continue;
      ins.run(uuid(), best.g.id, tx.date, r2(Math.abs(tx.amount) * movementSign(best.g, tx)), tx.id, now());
      n++;
    }
  })();
  return n;
}

export function transactionAllocations(txId: string) {
  return db
    .prepare(
      `SELECT m.id, m.goal_id, g.name AS goal_name, m.amount, m.source FROM savings_movements m JOIN savings_goals g ON g.id = m.goal_id
       WHERE m.transaction_id = ? ORDER BY g.sort_order, g.name`
    )
    .all(txId) as { id: string; goal_id: string; goal_name: string; amount: number; source: string }[];
}

/** Replaces how a transaction is shared out over goals. Amounts are
 *  magnitudes (the sign comes from the transaction) and may not add up to
 *  more than the transaction. */
export function setTransactionAllocations(txId: string, allocations: { goal_id: string; amount: number }[]) {
  const tx = db.prepare('SELECT id, account_id, date, amount FROM transactions WHERE id = ?').get(txId) as
    | { id: string; account_id: string; date: string; amount: number }
    | undefined;
  if (!tx) throw Object.assign(new Error('Transaction not found'), { status: 404 });
  const clean = allocations.map((a) => ({ goal_id: a.goal_id, amount: r2(Math.abs(a.amount)) })).filter((a) => a.amount > 0);
  const total = r2(clean.reduce((s, a) => s + a.amount, 0));
  if (total > Math.abs(tx.amount) + 0.009) {
    throw new Error(`Allocated ${total.toFixed(2)} but the transaction is ${Math.abs(tx.amount).toFixed(2)}`);
  }
  db.transaction(() => {
    db.prepare('DELETE FROM savings_movements WHERE transaction_id = ?').run(txId);
    const ins = db.prepare(
      "INSERT INTO savings_movements (id, goal_id, date, amount, transaction_id, note, source, created_at) VALUES (?, ?, ?, ?, ?, NULL, 'transaction', ?)"
    );
    for (const a of clean) {
      const g = getGoal(a.goal_id);
      if (!g) throw new Error('Savings goal not found');
      ins.run(uuid(), g.id, tx.date, r2(a.amount * movementSign(g, tx)), txId, now());
    }
  })();
  return transactionAllocations(txId);
}
