import { db } from '../db';
import { TX_STATUS_SQL } from './categorize';
import { planBudget } from './paymentPlans';
import { goalBudget } from './savings';
import { parseIso, Period, recentPeriods, todayIso } from './periods';

export interface CategoryKpi {
  category_id: string | null;
  name: string;
  kind: string;
  color: string | null;
  icon: string | null;
  requires_slip: boolean;
  planned: number;
  actual: number;
  remaining: number;
  pct_used: number | null;
  /** What "on budget" would have spent by today (planned × elapsed share). */
  pace_expected: number;
  /** actual extrapolated to the full period at the current rate. */
  projected: number;
  status: 'over' | 'ahead_of_pace' | 'on_track' | 'unplanned' | 'no_activity';
  transaction_count: number;
  /** Display group (expense categories only). */
  group_id: string | null;
  group_name: string | null;
  /** A household member's spending money. */
  personal: boolean;
  /** Part of planned that comes from payment plan instalments due this period. */
  plans_planned: number;
  /** Set on a subcategory; its parent's figures include it. */
  parent_id: string | null;
  /** On a parent: its own (not-split-further) actual and planned. */
  own_actual?: number;
  own_planned?: number;
  /** Part of planned that comes from savings goals' planned top-ups. */
  goals_planned: number;
}

export interface GroupKpi {
  /** null = expense categories not in any group (incl. Uncategorised). */
  group_id: string | null;
  name: string;
  planned: number;
  actual: number;
  remaining: number;
  pct_used: number | null;
  pace_expected: number;
  status: CategoryKpi['status'];
  category_ids: (string | null)[];
}

function spendStatus(planned: number, actual: number, pace: number, fraction: number, income: boolean): CategoryKpi['status'] {
  if (!planned && !actual) return 'no_activity';
  if (!planned) return 'unplanned';
  if (!income && actual > planned + 0.005) return 'over';
  if (!income && fraction < 1 && actual > pace * 1.1 && actual - pace > 50) return 'ahead_of_pace';
  return 'on_track';
}

export interface PeriodKpis {
  period: Period;
  elapsed_days: number;
  days_left: number;
  elapsed_fraction: number;
  totals: {
    income_planned: number;
    income_actual: number;
    expense_planned: number;
    expense_actual: number;
    savings_planned: number;
    savings_actual: number;
    /** Money borrowed this period (kind 'loan'): cash in that isn't income. */
    borrowed_actual: number;
    /** income + borrowed − expenses − savings: what's unaccounted for / left over. */
    net: number;
    /** (income − expenses) / income: share of income not spent. */
    savings_rate: number | null;
    expense_remaining: number;
    /** Budget left for spending ÷ days left in the period. */
    daily_allowance: number | null;
    /** Planned income − planned outflows. Negative means the budget itself is over-committed. */
    unallocated: number;
  };
  recon: {
    total: number;
    reconciled: number;
    uncategorized: number;
    needs_slip: number;
    ignored: number;
    uncategorized_amount: number;
    /** Share of slip-requiring transactions that have a slip attached. */
    slip_coverage: number | null;
  };
  /** Borrowing this period with no repayment plan yet. */
  borrowed_unplanned: { transaction_id: string; date: string; description: string; amount: number }[];
  categories: CategoryKpi[];
  /** Expense categories rolled up by display group, in group order;
   *  ungrouped last. */
  groups: GroupKpi[];
}

function r2(n: number) {
  return Math.round(n * 100) / 100;
}

export function periodKpis(period: Period): PeriodKpis {
  const today = todayIso();
  const elapsedDays =
    today < period.start
      ? 0
      : today > period.end
        ? period.days
        : Math.round((parseIso(today).getTime() - parseIso(period.start).getTime()) / 86400000) + 1;
  const fraction = period.days ? elapsedDays / period.days : 0;

  const cats = db
    .prepare(
      `SELECT c.*, COALESCE(b.amount, c.default_budget) AS planned, g.name AS group_name
       FROM categories c LEFT JOIN budget_lines b ON b.category_id = c.id AND b.period_start = ?
       LEFT JOIN category_groups g ON g.id = c.group_id
       ORDER BY c.sort_order, c.name`
    )
    .all(period.start) as {
    id: string;
    name: string;
    kind: string;
    color: string | null;
    icon: string | null;
    requires_slip: number;
    archived: number;
    planned: number;
    group_id: string | null;
    group_name: string | null;
    personal: number;
    parent_id: string | null;
  }[];
  const plans = planBudget(period).byCategory;
  const goals = goalBudget();

  const sums = db
    .prepare(
      `SELECT s.category_id, SUM(s.amount) AS total, COUNT(DISTINCT t.id) AS n
       FROM transaction_splits s JOIN transactions t ON t.id = s.transaction_id
       WHERE t.date BETWEEN ? AND ? AND t.ignored = 0
       GROUP BY s.category_id`
    )
    .all(period.start, period.end) as { category_id: string; total: number; n: number }[];
  const sumMap = new Map(sums.map((s) => [s.category_id, s]));

  // Money not (fully) assigned to any category.
  const unassigned = db
    .prepare(
      `SELECT COALESCE(SUM(t.amount - COALESCE((SELECT SUM(s.amount) FROM transaction_splits s WHERE s.transaction_id = t.id), 0)), 0) AS rest,
              COALESCE(SUM(CASE WHEN t.amount < 0 THEN t.amount - COALESCE((SELECT SUM(s.amount) FROM transaction_splits s WHERE s.transaction_id = t.id), 0) ELSE 0 END), 0) AS out_rest,
              COUNT(*) AS n
       FROM transactions t
       WHERE t.date BETWEEN ? AND ? AND t.ignored = 0
         AND ABS(t.amount - COALESCE((SELECT SUM(s.amount) FROM transaction_splits s WHERE s.transaction_id = t.id), 0)) > 0.009`
    )
    .get(period.start, period.end) as { rest: number; out_rest: number; n: number };

  const categories: CategoryKpi[] = [];
  for (const c of cats) {
    if (c.kind === 'transfer') continue;
    const s = sumMap.get(c.id);
    const moneyIn = c.kind === 'income' || c.kind === 'loan';
    const fromPlans = moneyIn ? 0 : plans.get(c.id) ?? 0;
    const fromGoals = moneyIn ? 0 : goals.get(c.id) ?? 0;
    if (c.archived && !s && !c.planned && !fromPlans && !fromGoals) continue;
    const signed = s?.total ?? 0;
    const actual = r2(moneyIn ? signed : -signed);
    const planned = r2((c.planned || 0) + fromPlans + fromGoals);
    const pace = r2(planned * fraction);
    const status = spendStatus(planned, actual, pace, fraction, moneyIn);
    categories.push({
      category_id: c.id,
      name: c.name,
      kind: c.kind,
      color: c.color,
      icon: c.icon,
      requires_slip: Boolean(c.requires_slip),
      group_id: c.kind === 'expense' ? c.group_id : null,
      group_name: c.kind === 'expense' ? c.group_name : null,
      personal: Boolean(c.personal),
      parent_id: c.parent_id ?? null,
      plans_planned: r2(fromPlans),
      goals_planned: r2(fromGoals),
      planned,
      actual,
      remaining: r2(planned - actual),
      pct_used: planned ? r2((actual / planned) * 100) : null,
      pace_expected: pace,
      projected: fraction > 0 ? r2(actual / fraction) : actual,
      status,
      transaction_count: s?.n ?? 0,
    });
  }
  if (Math.abs(unassigned.out_rest) > 0.005) {
    const actual = r2(-unassigned.out_rest);
    categories.push({
      category_id: null,
      name: 'Uncategorised',
      kind: 'expense',
      color: null,
      icon: '❓',
      requires_slip: false,
      planned: 0,
      actual,
      remaining: -actual,
      pct_used: null,
      pace_expected: 0,
      projected: fraction > 0 ? r2(actual / fraction) : actual,
      status: 'unplanned',
      transaction_count: unassigned.n,
      group_id: null,
      group_name: null,
      personal: false,
      parent_id: null,
      plans_planned: 0,
      goals_planned: 0,
    });
  }

  // Parents include their subcategories: Groceries = unsplit groceries + Meat + Starch + …
  const byId = new Map(categories.map((c) => [c.category_id, c]));
  for (const c of categories) if (c.parent_id && !byId.has(c.parent_id)) c.parent_id = null; // parent hidden (archived, unused)
  for (const p of categories) {
    if (!p.category_id) continue; // Uncategorised has no subcategories (its null id must not match top-level rows)
    const kids = categories.filter((c) => c.parent_id && c.parent_id === p.category_id);
    if (!kids.length) continue;
    p.own_actual = p.actual;
    p.own_planned = p.planned;
    p.actual = r2(p.actual + kids.reduce((a, c) => a + c.actual, 0));
    p.planned = r2(p.planned + kids.reduce((a, c) => a + c.planned, 0));
    p.plans_planned = r2(p.plans_planned + kids.reduce((a, c) => a + c.plans_planned, 0));
    p.goals_planned = r2(p.goals_planned + kids.reduce((a, c) => a + c.goals_planned, 0));
    p.transaction_count += kids.reduce((a, c) => a + c.transaction_count, 0);
    p.remaining = r2(p.planned - p.actual);
    p.pct_used = p.planned ? r2((p.actual / p.planned) * 100) : null;
    p.pace_expected = r2(p.planned * fraction);
    p.projected = fraction > 0 ? r2(p.actual / fraction) : p.actual;
    p.status = spendStatus(p.planned, p.actual, p.pace_expected, fraction, p.kind === 'income');
  }
  // Totals and group subtotals count top-level rows only (parents already include their children).
  const top = categories.filter((c) => !c.parent_id);

  const sum = (kind: string, field: 'planned' | 'actual') =>
    r2(top.filter((c) => c.kind === kind).reduce((a, c) => a + c[field], 0));
  const uncategorisedIn = r2(unassigned.rest - unassigned.out_rest); // positive unassigned money in
  const income_actual = r2(sum('income', 'actual') + uncategorisedIn);
  const income_planned = sum('income', 'planned');
  const expense_actual = sum('expense', 'actual');
  const expense_planned = sum('expense', 'planned');
  const savings_actual = sum('savings', 'actual');
  const savings_planned = sum('savings', 'planned');
  const borrowed_actual = sum('loan', 'actual');
  const borrowed_unplanned = db
    .prepare(
      `SELECT t.id AS transaction_id, t.date, t.description, t.amount FROM transactions t
       WHERE t.date BETWEEN ? AND ? AND t.ignored = 0 AND t.amount > 0
         AND EXISTS (SELECT 1 FROM transaction_splits s JOIN categories c ON c.id = s.category_id WHERE s.transaction_id = t.id AND c.kind = 'loan')
         AND NOT EXISTS (SELECT 1 FROM payment_plans p WHERE p.loan_transaction_id = t.id)
       ORDER BY t.date`
    )
    .all(period.start, period.end) as PeriodKpis['borrowed_unplanned'];
  const daysLeft = period.days - elapsedDays;
  const expense_remaining = r2(expense_planned - expense_actual);

  const statusRows = db
    .prepare(
      `SELECT status, COUNT(*) AS n FROM (SELECT ${TX_STATUS_SQL} AS status FROM transactions t WHERE t.date BETWEEN ? AND ?) GROUP BY status`
    )
    .all(period.start, period.end) as { status: string; n: number }[];
  const st = Object.fromEntries(statusRows.map((r) => [r.status, r.n])) as Record<string, number>;
  const slipTotal = db
    .prepare(
      `SELECT COUNT(DISTINCT t.id) AS n,
              COUNT(DISTINCT CASE WHEN EXISTS (SELECT 1 FROM receipts r WHERE r.transaction_id = t.id) THEN t.id END) AS with_slip
       FROM transactions t JOIN transaction_splits s ON s.transaction_id = t.id JOIN categories c ON c.id = s.category_id
       WHERE t.date BETWEEN ? AND ? AND t.ignored = 0 AND c.requires_slip = 1
         AND (t.no_slip_reason IS NULL OR EXISTS (SELECT 1 FROM receipts r WHERE r.transaction_id = t.id))`
    )
    .get(period.start, period.end) as { n: number; with_slip: number };

  // Roll expense categories up by display group, in the groups' own order.
  const groupRows = db.prepare('SELECT id, name FROM category_groups ORDER BY sort_order, name').all() as { id: string; name: string }[];
  const groups: GroupKpi[] = [...groupRows, { id: null, name: 'Other' }]
    .map((g) => {
      const members = top.filter((c) => c.kind === 'expense' && (c.group_id ?? null) === g.id);
      const planned = r2(members.reduce((a, c) => a + c.planned, 0));
      const actual = r2(members.reduce((a, c) => a + c.actual, 0));
      const pace = r2(planned * fraction);
      return {
        group_id: g.id,
        name: g.name,
        planned,
        actual,
        remaining: r2(planned - actual),
        pct_used: planned ? r2((actual / planned) * 100) : null,
        pace_expected: pace,
        status: spendStatus(planned, actual, pace, fraction, false),
        category_ids: members.map((c) => c.category_id),
      };
    })
    // An empty "Other" is noise; an empty named group still shows (it's set up).
    .filter((g) => g.group_id !== null || g.category_ids.length > 0);

  return {
    period,
    elapsed_days: elapsedDays,
    days_left: daysLeft,
    elapsed_fraction: r2(fraction),
    totals: {
      income_planned,
      income_actual,
      expense_planned,
      expense_actual,
      savings_planned,
      savings_actual,
      borrowed_actual,
      net: r2(income_actual + borrowed_actual - expense_actual - savings_actual),
      savings_rate: income_actual > 0 ? r2(((income_actual - expense_actual) / income_actual) * 100) : null,
      expense_remaining,
      daily_allowance: daysLeft > 0 ? r2(expense_remaining / daysLeft) : null,
      unallocated: r2(income_planned - expense_planned - savings_planned),
    },
    recon: {
      total: Object.values(st).reduce((a, b) => a + b, 0),
      reconciled: st.reconciled ?? 0,
      uncategorized: st.uncategorized ?? 0,
      needs_slip: st.needs_slip ?? 0,
      ignored: st.ignored ?? 0,
      uncategorized_amount: r2(unassigned.rest),
      slip_coverage: slipTotal.n ? r2((slipTotal.with_slip / slipTotal.n) * 100) : null,
    },
    borrowed_unplanned,
    categories,
    groups,
  };
}

export interface TrendPoint {
  period: Period;
  income: number;
  expenses: number;
  expenses_planned: number;
  savings: number;
  net: number;
  categories: { category_id: string | null; name: string; parent_id: string | null; planned: number; actual: number }[];
}

export function trend(count: number, anchor?: Period): TrendPoint[] {
  return recentPeriods(Math.min(Math.max(count, 1), 36), anchor).map((p) => {
    const k = periodKpis(p);
    return {
      period: p,
      income: k.totals.income_actual,
      expenses: k.totals.expense_actual,
      expenses_planned: k.totals.expense_planned,
      savings: k.totals.savings_actual,
      net: k.totals.net,
      categories: k.categories
        .filter((c) => c.kind !== 'income' && c.kind !== 'loan')
        .map((c) => ({ category_id: c.category_id, name: c.name, parent_id: c.parent_id, planned: c.planned, actual: c.actual })),
    };
  });
}
