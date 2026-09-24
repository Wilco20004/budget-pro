import { v4 as uuid } from 'uuid';
import { db } from '../db';
import { addDays, currentPeriod, parseIso, Period, previousPeriod, recentPeriods, todayIso, toIso } from './periods';

// Debt accounts: credit cards and loans you import statements for.
//
// How they count (chosen with the user): a repayment into a debt account
// you track is a transfer on the paying side. Each debt account has its own
// subcategory under Debt repayments (1.20.0): its budget is the planned
// repayment, and its actual is the debt's cost — interest, fees and cover,
// filed there — plus how much the balance came down ("paydown", added in
// the KPIs). Purchases on a card are spending in their own categories.
//
// Balances are stored from the holder's side (owed = negative), so
// owed = −balance.

const DEBT_TYPES = ['credit', 'loan'];
const COST = /interest|\bfee\b|fees|insurance|premium|\bcpp\b|charge/i;
const PAYMENT = /payment|transfer|thank you|\b1sa\b|inter.?account|deposit|debit order|d\/o/i;
const NOT_PAYMENT = /refund|voucher|reversal|cash ?back|reward|miles/i;
const r2 = (n: number) => Math.round(n * 100) / 100;

interface AccountRow {
  id: string;
  name: string;
  bank: string;
  type: string;
  planned_payment: number | null;
  interest_rate: number | null;
  credit_limit: number | null;
  debt_category_id: string | null;
  /** Cleared in full every month: a spending card, not debt to pay down. */
  paid_in_full: number;
}

function nextSortOrder(): number {
  return ((db.prepare('SELECT MAX(sort_order) AS m FROM categories').get() as { m: number | null }).m ?? 0) + 1;
}

/** Creates (or re-links) the Debt repayments subcategory of every debt
 *  account, and the Debt repayments parent if it's missing. */
export function ensureDebtCategories(): Map<string, string> {
  const out = new Map<string, string>();
  const accounts = db.prepare("SELECT * FROM accounts WHERE type IN ('credit', 'loan') AND paid_in_full = 0").all() as AccountRow[];
  if (!accounts.length) return out;
  const t = new Date().toISOString();
  db.transaction(() => {
    let parent = db.prepare("SELECT id, group_id FROM categories WHERE name = 'Debt repayments' AND parent_id IS NULL").get() as
      | { id: string; group_id: string | null }
      | undefined;
    if (!parent) {
      parent = { id: uuid(), group_id: null };
      db.prepare(
        `INSERT INTO categories (id, name, kind, icon, requires_slip, default_budget, sort_order, created_at, updated_at)
         VALUES (?, 'Debt repayments', 'expense', '💳', 0, 0, ?, ?, ?)`
      ).run(parent.id, nextSortOrder(), t, t);
    }
    for (const a of accounts) {
      const linked = a.debt_category_id ? db.prepare('SELECT id FROM categories WHERE id = ?').get(a.debt_category_id) : undefined;
      if (linked) {
        out.set(a.id, a.debt_category_id!);
        continue;
      }
      // Reuse a category already named after the account, else make one.
      let cat = db.prepare('SELECT id FROM categories WHERE name = ?').get(a.name) as { id: string } | undefined;
      if (!cat) {
        cat = { id: uuid() };
        db.prepare(
          `INSERT INTO categories (id, name, kind, icon, requires_slip, default_budget, sort_order, group_id, parent_id, created_at, updated_at)
           VALUES (?, ?, 'expense', ?, 0, ?, ?, ?, ?, ?, ?)`
        ).run(cat.id, a.name, a.type === 'loan' ? '🏦' : '💳', a.planned_payment ?? 0, nextSortOrder(), parent.group_id, parent.id, t, t);
      }
      db.prepare('UPDATE accounts SET debt_category_id = ? WHERE id = ?').run(cat.id, a.id);
      out.set(a.id, cat.id);
    }
  })();
  return out;
}

/** The planned repayment in a period: the debt subcategory's budget. */
function plannedFor(a: AccountRow, period: Period): number {
  if (!a.debt_category_id) return a.planned_payment ?? 0;
  const r = db
    .prepare(
      'SELECT COALESCE(b.amount, c.default_budget) AS p FROM categories c LEFT JOIN budget_lines b ON b.category_id = c.id AND b.period_start = ? WHERE c.id = ?'
    )
    .get(period.start, a.debt_category_id) as { p: number } | undefined;
  return r?.p ?? 0;
}

/** Sets the planned repayment from now on: the subcategory's default, with
 *  this and later periods' one-off amounts cleared so it applies. */
/** Marks a card as cleared in full every month (or not). Turning it on
 *  puts its fee lines back in Bank fees and archives its Debt repayments
 *  line; turning it off makes (or restores) that line. */
export function setPaidInFull(accountId: string, on: boolean) {
  const a = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId) as AccountRow | undefined;
  if (!a) return;
  db.transaction(() => {
    db.prepare('UPDATE accounts SET paid_in_full = ? WHERE id = ?').run(on ? 1 : 0, accountId);
    if (!a.debt_category_id) return;
    if (on) {
      const fees = categoryId("name = 'Bank fees'");
      if (fees) db.prepare('UPDATE transaction_splits SET category_id = ? WHERE category_id = ?').run(fees, a.debt_category_id);
      db.prepare('UPDATE categories SET archived = 1 WHERE id = ?').run(a.debt_category_id);
    } else {
      db.prepare('UPDATE categories SET archived = 0 WHERE id = ?').run(a.debt_category_id);
    }
  })();
  if (!on) {
    ensureDebtCategories();
    moveDebtCosts();
  }
}

export function setPlannedPayment(accountId: string, amount: number | null) {
  const cat = ensureDebtCategories().get(accountId);
  db.prepare('UPDATE accounts SET planned_payment = ? WHERE id = ?').run(amount, accountId);
  if (!cat) return;
  db.prepare('UPDATE categories SET default_budget = ? WHERE id = ?').run(amount ?? 0, cat);
  db.prepare('DELETE FROM budget_lines WHERE category_id = ? AND period_start >= ?').run(cat, currentPeriod().start);
}

/** How much each debt came down in a period, per debt subcategory. */
export function paydownByCategory(period: Period): Map<string, number> {
  const out = new Map<string, number>();
  const today = todayIso();
  if (period.start > today) return out;
  for (const a of db.prepare("SELECT * FROM accounts WHERE type IN ('credit', 'loan') AND paid_in_full = 0 AND debt_category_id IS NOT NULL").all() as AccountRow[]) {
    const start = owedAt(a.id, addDays(period.start, -1));
    const end = owedAt(a.id, period.end < today ? period.end : today);
    if (start === null || end === null) continue;
    out.set(a.debt_category_id!, r2((out.get(a.debt_category_id!) ?? 0) + start - end));
  }
  return out;
}

function categoryId(where: string): string | null {
  return (db.prepare(`SELECT id FROM categories WHERE ${where} AND archived = 0 ORDER BY sort_order LIMIT 1`).get() as { id: string } | undefined)?.id ?? null;
}

/** The account's balance at the end of a day (statement order within a day). */
function balanceAt(accountId: string, date: string): number | null {
  const last = db
    .prepare('SELECT MAX(date) AS d FROM transactions WHERE account_id = ? AND date <= ? AND balance IS NOT NULL')
    .get(accountId, date) as { d: string | null };
  if (!last.d) return null;
  const day = db
    .prepare('SELECT balance, amount FROM transactions WHERE account_id = ? AND date = ? AND balance IS NOT NULL ORDER BY rowid')
    .all(accountId, last.d) as { balance: number; amount: number }[];
  // The day's closing balance is the one no other line that day started from
  // (balance − amount is where a line started); insertion order is only the
  // fallback.
  const starts = new Set(day.map((r) => r2(r.balance - r.amount)));
  const ends = day.filter((r) => !starts.has(r2(r.balance)) || day.length === 1);
  return (ends.length === 1 ? ends[0] : day[day.length - 1]).balance;
}

function owedAt(accountId: string, date: string): number | null {
  const b = balanceAt(accountId, date);
  return b === null ? null : r2(-b);
}

function flows(accountId: string, p: Period) {
  const rows = db
    .prepare(
      `SELECT t.amount, t.description,
              (SELECT c.name FROM transaction_splits s JOIN categories c ON c.id = s.category_id WHERE s.transaction_id = t.id LIMIT 1) AS category
       FROM transactions t WHERE t.account_id = ? AND t.ignored = 0 AND t.date BETWEEN ? AND ?`
    )
    .all(accountId, p.start, p.end) as { amount: number; description: string; category: string | null }[];
  let paid = 0;
  let costs = 0;
  let interest = 0;
  let purchases = 0;
  for (const r of rows) {
    if (r.amount > 0) paid += r.amount;
    else if (COST.test(r.description) || /bank fees|insurance/i.test(r.category ?? '')) {
      costs -= r.amount;
      if (/interest/i.test(r.description)) interest -= r.amount;
    } else purchases -= r.amount;
  }
  return { paid: r2(paid), costs: r2(costs), interest: r2(interest), purchases: r2(purchases) };
}

function addMonths(iso: string, n: number): string {
  const d = parseIso(iso);
  return toIso(d.getUTCFullYear(), d.getUTCMonth() + n, Math.min(d.getUTCDate(), 28));
}

/** Months to pay off `owed` at `payment` a month and `rate`% a year. */
function payoff(owed: number, payment: number, rate: number | null) {
  if (owed <= 0) return { months: 0, interest: 0, never: false };
  if (!payment || payment <= 0) return null;
  if (!rate) return { months: Math.ceil(owed / payment), interest: 0, never: false };
  const i = rate / 100 / 12;
  if (payment <= owed * i) return { months: null, interest: null, never: true };
  const n = -Math.log(1 - (i * owed) / payment) / Math.log(1 + i);
  return { months: Math.ceil(n), interest: r2(payment * n - owed), never: false };
}

export function describeDebt(a: AccountRow, period: Period = currentPeriod()) {
  const today = todayIso();
  const owed = owedAt(a.id, today);
  const owedStart = owedAt(a.id, addDays(period.start, -1));
  const owedEnd = owedAt(a.id, period.end < today ? period.end : today);
  const now = flows(a.id, period);
  const prev = flows(a.id, previousPeriod(period));
  const planned = plannedFor(a, period);
  // Fees and cover come out of each repayment before it reaches interest
  // and capital, so they don't count towards paying the balance off.
  const otherCosts = r2(prev.costs - prev.interest);
  const p = owed !== null && !a.paid_in_full ? payoff(owed, r2(planned - otherCosts), a.interest_rate) : null;
  // A spending card: cleared = its balance hit (about) zero this period.
  const lowest = a.paid_in_full
    ? (db
        .prepare('SELECT MAX(balance) AS b FROM transactions WHERE account_id = ? AND date BETWEEN ? AND ? AND balance IS NOT NULL')
        .get(a.id, period.start, period.end) as { b: number | null }).b
    : null;
  const cleared = lowest !== null && lowest >= -1;
  return {
    account_id: a.id,
    name: a.name,
    bank: a.bank,
    type: a.type,
    category_id: a.debt_category_id,
    planned_payment: planned || null,
    interest_rate: a.interest_rate,
    credit_limit: a.credit_limit,
    owed,
    available: a.credit_limit && owed !== null ? r2(a.credit_limit - owed) : null,
    utilisation: a.credit_limit && owed !== null ? r2((owed / a.credit_limit) * 100) : null,
    this_period: {
      ...now,
      /** How much the balance went down (negative = it grew). */
      paid_down: owedStart !== null && owedEnd !== null ? r2(owedStart - owedEnd) : null,
      owed_start: owedStart,
    },
    /** Of the planned repayment, what's expected to reduce the balance —
     *  last period's interest, fees and purchases on the account come off it. */
    planned_paydown: planned ? r2(Math.max(0, planned - prev.costs - prev.purchases)) : 0,
    paid_in_full: Boolean(a.paid_in_full),
    cleared: a.paid_in_full ? cleared : null,
    status: a.paid_in_full
      ? cleared
        ? 'cleared'
        : period.end < today
          ? 'not_cleared'
          : 'due'
      : !planned
        ? 'no_plan'
        : now.paid >= planned - 0.5
          ? 'paid'
          : period.end < today
            ? 'short'
            : 'due',
    payoff: p ? { ...p, date: p.months ? addMonths(today, p.months) : null } : null,
    history: recentPeriods(6, period).map((q) => ({ period: q.start, label: q.label, owed: owedAt(a.id, q.end < today ? q.end : today) })),
  };
}

export function debtOverview(period: Period = currentPeriod()) {
  const debts = (db.prepare(`SELECT * FROM accounts WHERE type IN (${DEBT_TYPES.map(() => '?').join(',')}) ORDER BY name`).all(...DEBT_TYPES) as AccountRow[]).map(
    (a) => describeDebt(a, period)
  );
  const real = debts.filter((d) => !d.paid_in_full);
  const sum = (f: (d: (typeof debts)[number]) => number | null | undefined) => r2(real.reduce((s, d) => s + (f(d) ?? 0), 0));
  return {
    period,
    debts,
    totals: {
      owed: sum((d) => d.owed),
      planned_payment: sum((d) => d.planned_payment),
      planned_paydown: sum((d) => d.planned_paydown),
      paid: sum((d) => d.this_period.paid),
      paid_down: sum((d) => d.this_period.paid_down),
      costs: sum((d) => d.this_period.costs),
    },
  };
}

/** New lines on loan accounts: the repayment arriving is a transfer (the
 *  paying side is too); interest and fees are the cost of the loan (Bank
 *  fees), credit-life cover is Insurance. On cards, interest and fee lines
 *  are Bank fees; purchases are left to the merchant rules. */
export function categorizeDebtLines(ids: string[]): number {
  const transfer = categoryId("kind = 'transfer'");
  const debtCats = ensureDebtCategories();
  const tx = db.prepare(
    `SELECT t.id, t.amount, t.description, a.type, a.id AS account_id FROM transactions t JOIN accounts a ON a.id = t.account_id
     WHERE t.id = ? AND a.type IN ('credit', 'loan') AND a.paid_in_full = 0 AND NOT EXISTS (SELECT 1 FROM transaction_splits s WHERE s.transaction_id = t.id)`
  );
  const ins = db.prepare("INSERT INTO transaction_splits (id, transaction_id, category_id, amount, source) VALUES (?, ?, ?, ?, 'rule')");
  let n = 0;
  db.transaction(() => {
    for (const id of ids) {
      const t = tx.get(id) as { id: string; amount: number; description: string; type: string; account_id: string } | undefined;
      if (!t) continue;
      // The debt's cost (interest, fees, cover) is its own Debt repayments
      // line; a loan's repayment arriving is a transfer.
      const own = debtCats.get(t.account_id) ?? null;
      let cat: string | null = null;
      if (t.type === 'loan') cat = t.amount > 0 ? transfer : own;
      else if (t.amount < 0 && /^(interest|card fee|.*\bfee)$/i.test(t.description.trim())) cat = own;
      if (!cat) continue;
      ins.run(uuid(), t.id, cat, t.amount);
      n++;
    }
  })();
  return n;
}

/** A payment into a tracked debt account and the matching money out of
 *  another account (same amount, within 4 days) are one transfer: the paying
 *  side is re-filed from a rule's category (e.g. "FNB Ploan → Debt
 *  repayments") to Transfers. Categories set by hand are left alone. */
export function pairDebtPayments(): number {
  const transfer = categoryId("kind = 'transfer'");
  if (!transfer) return 0;
  const payments = db
    .prepare(
      `SELECT t.id, t.account_id, t.date, t.amount, t.description, a.type FROM transactions t JOIN accounts a ON a.id = t.account_id
       WHERE a.type IN ('credit', 'loan') AND t.amount > 0 AND t.ignored = 0 ORDER BY t.date`
    )
    .all() as { id: string; account_id: string; date: string; amount: number; description: string; type: string }[];
  const find = db.prepare(
    `SELECT t.id FROM transactions t
     WHERE t.account_id != ? AND ABS(t.amount + ?) < 0.005 AND t.date BETWEEN ? AND ? AND t.ignored = 0
       AND NOT EXISTS (SELECT 1 FROM transaction_splits s WHERE s.transaction_id = t.id AND s.source NOT IN ('rule'))
       AND NOT EXISTS (SELECT 1 FROM transaction_splits s JOIN categories c ON c.id = s.category_id WHERE s.transaction_id = t.id AND c.kind = 'transfer')
     ORDER BY ABS(julianday(t.date) - julianday(?)) LIMIT 1`
  );
  const del = db.prepare('DELETE FROM transaction_splits WHERE transaction_id = ?');
  const ins = db.prepare("INSERT INTO transaction_splits (id, transaction_id, category_id, amount, source) VALUES (?, ?, ?, ?, 'rule')");
  const amountOf = db.prepare('SELECT amount FROM transactions WHERE id = ?');
  let n = 0;
  db.transaction(() => {
    for (const p of payments) {
      // On a card, money in is a payment only if it says so — a refund of
      // the same amount as something bought elsewhere isn't a transfer.
      if (p.type === 'credit' && (!PAYMENT.test(p.description) || NOT_PAYMENT.test(p.description))) continue;
      const hit = find.get(p.account_id, p.amount, addDays(p.date, -4), addDays(p.date, 4), p.date) as { id: string } | undefined;
      if (!hit) continue;
      del.run(hit.id);
      ins.run(uuid(), hit.id, transfer, (amountOf.get(hit.id) as { amount: number }).amount);
      n++;
    }
  })();
  return n;
}

/** One-off for lines imported before 1.19.0: loan lines were all filed as
 *  transfers; re-file the loan's costs, then pair up the payments. */
/** Rebuilds running balances of imported card statements in date order
 *  (1.19.0: FNB card statements list lines out of date order, and earlier
 *  imports took their running balance in listing order). The statement's
 *  closing balance is the balance after its last-listed line. */
export function rebalanceCardImports(): number {
  const imports = db
    .prepare("SELECT i.id FROM imports i JOIN accounts a ON a.id = i.account_id WHERE a.type = 'credit' AND i.format = 'fnb-pdf-credit'")
    .all() as { id: string }[];
  const set = db.prepare('UPDATE transactions SET balance = ? WHERE id = ?');
  let n = 0;
  db.transaction(() => {
    for (const imp of imports) {
      const rows = db.prepare('SELECT id, date, amount, balance FROM transactions WHERE import_id = ? ORDER BY rowid').all(imp.id) as {
        id: string;
        date: string;
        amount: number;
        balance: number | null;
      }[];
      if (!rows.length || rows.some((r) => r.balance === null)) continue;
      // The closing balance is the one that sits exactly "all the lines" after
      // some line's starting balance (the statement's opening).
      const total = r2(rows.reduce((s, r) => s + r.amount, 0));
      const openings = new Set(rows.map((r) => r2((r.balance as number) - r.amount)));
      const closings = rows.map((r) => r.balance as number).filter((b) => openings.has(r2(b - total)));
      if (closings.length !== 1) continue; // ambiguous — leave it
      const closing = closings[0];
      const byDate = [...rows].sort((a, b) => a.date.localeCompare(b.date));
      let bal = closing;
      for (let k = byDate.length - 1; k >= 0; k--) {
        set.run(r2(bal), byDate[k].id);
        bal = r2(bal - byDate[k].amount);
      }
      n++;
    }
  })();
  return n;
}

/** 1.20.0: debt costs filed as Bank fees / Insurance (by 1.19.0, or by
 *  hand before debts had their own lines) move to the debt's subcategory —
 *  on a card or loan account, a fee or cover line is the cost of that debt. */
function moveDebtCosts(): number {
  const cats = ensureDebtCategories();
  const rows = db
    .prepare(
      `SELECT s.id, t.account_id, t.description FROM transaction_splits s
       JOIN transactions t ON t.id = s.transaction_id JOIN accounts a ON a.id = t.account_id
       JOIN categories c ON c.id = s.category_id
       WHERE a.type IN ('credit', 'loan') AND a.paid_in_full = 0 AND t.amount < 0 AND c.name IN ('Bank fees', 'Insurance')`
    )
    .all() as { id: string; account_id: string; description: string }[];
  const set = db.prepare("UPDATE transaction_splits SET category_id = ?, source = 'rule' WHERE id = ?");
  let n = 0;
  db.transaction(() => {
    for (const r of rows) {
      const cat = cats.get(r.account_id);
      if (!cat) continue;
      set.run(cat, r.id);
      n++;
    }
  })();
  return n;
}

export function recheckDebtLines(): { refiled: number; paired: number; rebalanced: number } {
  const rebalanced = rebalanceCardImports();
  const ids = (
    db
      .prepare(
        `SELECT t.id FROM transactions t JOIN accounts a ON a.id = t.account_id
         WHERE a.type = 'loan'
           AND NOT EXISTS (SELECT 1 FROM transaction_splits s WHERE s.transaction_id = t.id AND s.source != 'rule')`
      )
      .all() as { id: string }[]
  ).map((r) => r.id);
  // Only rule-made splits are replaced; hand-made ones stay.
  const transferId = categoryId("kind = 'transfer'");
  const clear = db.prepare(
    "DELETE FROM transaction_splits WHERE transaction_id = ? AND source = 'rule' AND category_id = ? AND (SELECT amount FROM transactions WHERE id = ?) < 0"
  );
  db.transaction(() => {
    for (const id of ids) clear.run(id, transferId, id);
  })();
  const refiled = categorizeDebtLines(ids) + moveDebtCosts();
  return { refiled, paired: pairDebtPayments(), rebalanced };
}
