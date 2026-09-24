import { db } from '../db';
import { TX_STATUS_SQL } from './categorize';
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
    /** income − expenses − savings: what's unaccounted for / left over. */
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
  categories: CategoryKpi[];
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
      `SELECT c.*, COALESCE(b.amount, c.default_budget) AS planned
       FROM categories c LEFT JOIN budget_lines b ON b.category_id = c.id AND b.period_start = ?
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
  }[];

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
    if (c.archived && !s && !c.planned) continue;
    const signed = s?.total ?? 0;
    const actual = r2(c.kind === 'income' ? signed : -signed);
    const planned = r2(c.planned || 0);
    const pace = r2(planned * fraction);
    let status: CategoryKpi['status'];
    if (!planned && !actual) status = 'no_activity';
    else if (!planned) status = 'unplanned';
    else if (c.kind !== 'income' && actual > planned + 0.005) status = 'over';
    else if (c.kind !== 'income' && fraction < 1 && actual > pace * 1.1 && actual - pace > 50) status = 'ahead_of_pace';
    else status = 'on_track';
    categories.push({
      category_id: c.id,
      name: c.name,
      kind: c.kind,
      color: c.color,
      icon: c.icon,
      requires_slip: Boolean(c.requires_slip),
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
    });
  }

  const sum = (kind: string, field: 'planned' | 'actual') =>
    r2(categories.filter((c) => c.kind === kind).reduce((a, c) => a + c[field], 0));
  const uncategorisedIn = r2(unassigned.rest - unassigned.out_rest); // positive unassigned money in
  const income_actual = r2(sum('income', 'actual') + uncategorisedIn);
  const income_planned = sum('income', 'planned');
  const expense_actual = sum('expense', 'actual');
  const expense_planned = sum('expense', 'planned');
  const savings_actual = sum('savings', 'actual');
  const savings_planned = sum('savings', 'planned');
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
       WHERE t.date BETWEEN ? AND ? AND t.ignored = 0 AND c.requires_slip = 1`
    )
    .get(period.start, period.end) as { n: number; with_slip: number };

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
      net: r2(income_actual - expense_actual - savings_actual),
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
    categories,
  };
}

export interface TrendPoint {
  period: Period;
  income: number;
  expenses: number;
  expenses_planned: number;
  savings: number;
  net: number;
  categories: { category_id: string | null; name: string; planned: number; actual: number }[];
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
        .filter((c) => c.kind !== 'income')
        .map((c) => ({ category_id: c.category_id, name: c.name, planned: c.planned, actual: c.actual })),
    };
  });
}
