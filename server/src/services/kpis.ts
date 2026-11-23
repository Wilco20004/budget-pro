import { db } from '../db';
import { TX_STATUS_SQL } from './categorize';
import { planBudget } from './paymentPlans';
import { debtOverview, paydownByCategory } from './debts';
import { goalBudget } from './savings';
import { addDays, parseIso, Period, periodFor, recentPeriods, todayIso } from './periods';

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
  /** A fixed cost (debit order): paid once, not tracked against pace. */
  fixed: boolean;
  /** Part of planned that comes from payment plan instalments due this period. */
  plans_planned: number;
  /** Set on a subcategory; its parent's figures include it. */
  parent_id: string | null;
  /** On a parent: its own (not-split-further) actual and planned. */
  own_actual?: number;
  own_planned?: number;
  /** Part of planned that comes from savings goals' planned top-ups. */
  goals_planned: number;
  /** Where its own money sits in the monthly plan: a fixed cost, a debt
   *  repayment (the Debt repayments tree), or day-to-day spending. */
  bucket: Bucket;
}

export type Bucket = 'fixed' | 'debt' | 'day_to_day';

/** One payday-to-payday week of day-to-day spending. */
export interface WeekKpi {
  n: number;
  start: string;
  end: string;
  days: number;
  /** What this week plans to spend: the amount set for it by hand, or its
   *  share (by days) of what the hand-set weeks leave of the budget. */
  base: number;
  /** true when base was set by hand for this week. */
  custom: boolean;
  /** base plus whatever earlier weeks left over (or minus what they overspent);
   *  null for a week that hasn't started. */
  allowance: number | null;
  spent: number;
  /** allowance − spent; null for a week that hasn't started. */
  left: number | null;
  state: 'past' | 'current' | 'future';
  /** Notes on this week's categories ("Kids: school trip"). */
  notes: { category_id: string; name: string; icon: string | null; note: string }[];
}

/** One day-to-day category across the weeks of a period. */
export interface WeekCategoryKpi {
  /** null = spending not categorised yet (no plan, not editable). */
  category_id: string | null;
  name: string;
  icon: string | null;
  parent_id: string | null;
  /** The category's own plan for the period (as on the Plan page). */
  planned: number;
  /** plan: set by hand (custom) or its share by days of what the set weeks leave. */
  weeks: { plan: number; custom: boolean; spent: number; note: string | null }[];
}

/** 1.31.0 stored whole-week amounts; 1.32.0 plans each category per week.
 *  A set week becomes that week's cells, split over the categories in
 *  proportion to their plans, so every week's total stays the same. */
function migrateWeekTotals(
  periodStart: string,
  nWeeks: number,
  ownPlanned: Map<string, number>
) {
  const rows = db.prepare('SELECT week_n, amount FROM week_plans WHERE period_start = ?').all(periodStart) as { week_n: number; amount: number }[];
  if (!rows.length) return;
  const total = [...ownPlanned.values()].reduce((a, v) => a + Math.max(0, v), 0);
  // Nothing planned to split it over yet: keep the amounts for a later try.
  if (total <= 0) return;
  const insert = db.prepare(
    `INSERT INTO week_category_plans (period_start, week_n, category_id, amount) VALUES (?, ?, ?, ?)
     ON CONFLICT(period_start, week_n, category_id) DO NOTHING`
  );
  db.transaction(() => {
    for (const r of rows) {
      if (r.week_n < 1 || r.week_n > nWeeks) continue;
      for (const [id, planned] of ownPlanned) {
        if (planned > 0) insert.run(periodStart, r.week_n, id, r2((r.amount * planned) / total));
      }
    }
    db.prepare('DELETE FROM week_plans WHERE period_start = ?').run(periodStart);
  })();
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

function spendStatus(planned: number, actual: number, pace: number, fraction: number, income: boolean, fixed = false): CategoryKpi['status'] {
  if (!planned && !actual) return 'no_activity';
  if (!planned) return 'unplanned';
  if (!income && actual > planned + 0.005) return 'over';
  if (!income && !fixed && fraction < 1 && actual > pace * 1.1 && actual - pace > 50) return 'ahead_of_pace';
  return 'on_track';
}

/** By today, a fixed cost should have spent whatever has gone off (up to its
 *  amount); anything else, its planned share of the elapsed period. */
function expectedByToday(planned: number, actual: number, fraction: number, fixed: boolean) {
  return r2(fixed ? Math.min(Math.max(actual, 0), planned) : planned * fraction);
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
    /** Planned repayments to tracked cards/loans, less their expected costs: what should come off the balances. */
    debt_paydown_planned: number;
    /** How much the tracked cards/loans went down this period (negative = debt grew). */
    debt_paydown_actual: number;
    /** income + borrowed − expenses − savings (debt paydown is in expenses): what's left over. */
    net: number;
    /** (income − expenses) / income: share of income not spent. */
    savings_rate: number | null;
    expense_remaining: number;
    /** Budget left for spending ÷ days left in the period. */
    daily_allowance: number | null;
    /** Planned income − planned outflows. Negative means the budget itself is over-committed. */
    unallocated: number;
    /** Planned debt repayments (cards, loans) ÷ planned income, %. */
    debt_to_income: number | null;
    /** Savings and investments ÷ income, %: as planned, and as actually put away. */
    investment_to_income_planned: number | null;
    investment_to_income: number | null;
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
  /** The monthly plan, savings first: income − savings = to live on;
   *  − fixed − day-to-day − debt = surplus (negative = shortfall). */
  plan: {
    income: number;
    savings: number;
    live_on: number;
    fixed: number;
    day_to_day: number;
    debt: number;
    surplus: number;
  };
  /** The day-to-day budget spread over 7-day weeks from payday (a last
   *  stub under 4 days joins the week before); spending outside this
   *  week's allowance carries into the next. */
  /** budget = the day-to-day plan; planned = what the weeks add up to (differs
   *  when hand-set weeks add up to more than the budget, or every week is set). */
  weekly: { budget: number; planned: number; current: number | null; weeks: WeekKpi[]; categories: WeekCategoryKpi[] };
}

/** 7-day weeks from the period's first day; a stub under 4 days at the end
 *  joins the last full week. */
export function payWeeks(period: Period): { start: string; end: string; days: number }[] {
  const weeks: { start: string; end: string; days: number }[] = [];
  for (let start = period.start; start <= period.end; start = addDays(start, 7)) {
    const end = addDays(start, 6) < period.end ? addDays(start, 6) : period.end;
    const days = Math.round((parseIso(end).getTime() - parseIso(start).getTime()) / 86400000) + 1;
    if (days < 4 && weeks.length) {
      const last = weeks[weeks.length - 1];
      last.end = end;
      last.days += days;
    } else weeks.push({ start, end, days });
  }
  return weeks;
}

function r2(n: number) {
  return Math.round(n * 100) / 100;
}

/** Converts every period's 1.31.0 whole-week amounts (week_plans) into
 *  per-category cells. Run at startup and after a restore, never from a read. */
export function migrateAllWeekTotals() {
  const starts = db.prepare('SELECT DISTINCT period_start FROM week_plans').all() as { period_start: string }[];
  for (const { period_start } of starts) {
    try {
      periodKpis(periodFor(period_start), { migrate: true });
    } catch (e) {
      console.error('[budgetpro] week plan migration failed for', period_start, e);
    }
  }
}

export function periodKpis(period: Period, opts: { migrate?: boolean } = {}): PeriodKpis {
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
    fixed: number;
    parent_id: string | null;
  }[];
  const plans = planBudget(period).byCategory;
  const goals = goalBudget();
  // A debt's line also counts how much its balance came down.
  const paydown = paydownByCategory(period);

  const sums = db
    .prepare(
      `SELECT s.category_id, SUM(s.amount) AS total, COUNT(DISTINCT t.id) AS n
       FROM transaction_splits s JOIN transactions t ON t.id = s.transaction_id
       WHERE COALESCE(t.budget_date, t.date) BETWEEN ? AND ? AND t.ignored = 0
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
       WHERE COALESCE(t.budget_date, t.date) BETWEEN ? AND ? AND t.ignored = 0
         AND ABS(t.amount - COALESCE((SELECT SUM(s.amount) FROM transaction_splits s WHERE s.transaction_id = t.id), 0)) > 0.009`
    )
    .get(period.start, period.end) as { rest: number; out_rest: number; n: number };

  // The Debt repayments tree and every tracked card/loan's own line.
  const debtIds = new Set(
    (
      db
        .prepare(
          `SELECT id FROM categories
           WHERE (name = 'Debt repayments' AND parent_id IS NULL)
              OR parent_id IN (SELECT id FROM categories WHERE name = 'Debt repayments' AND parent_id IS NULL)
              OR id IN (SELECT debt_category_id FROM accounts WHERE debt_category_id IS NOT NULL)`
        )
        .all() as { id: string }[]
    ).map((r) => r.id)
  );

  const categories: CategoryKpi[] = [];
  for (const c of cats) {
    if (c.kind === 'transfer') continue;
    const s = sumMap.get(c.id);
    const moneyIn = c.kind === 'income' || c.kind === 'loan';
    const fromPlans = moneyIn ? 0 : plans.get(c.id) ?? 0;
    const fromGoals = moneyIn ? 0 : goals.get(c.id) ?? 0;
    const fromPaydown = paydown.get(c.id) ?? 0;
    if (c.archived && !s && !c.planned && !fromPlans && !fromGoals && !fromPaydown) continue;
    const signed = s?.total ?? 0;
    const actual = r2((moneyIn ? signed : -signed) + fromPaydown);
    const planned = r2((c.planned || 0) + fromPlans + fromGoals);
    const fixed = Boolean(c.fixed) && !moneyIn;
    const pace = expectedByToday(planned, actual, fraction, fixed);
    const status = spendStatus(planned, actual, pace, fraction, moneyIn, fixed);
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
      fixed,
      bucket: debtIds.has(c.id) ? 'debt' : fixed ? 'fixed' : 'day_to_day',
      parent_id: c.parent_id ?? null,
      plans_planned: r2(fromPlans),
      goals_planned: r2(fromGoals),
      planned,
      actual,
      remaining: r2(planned - actual),
      pct_used: planned ? r2((actual / planned) * 100) : null,
      pace_expected: pace,
      projected: fixed ? Math.max(actual, planned) : fraction > 0 ? r2(actual / fraction) : actual,
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
      fixed: false,
      bucket: 'day_to_day',
      parent_id: null,
      plans_planned: 0,
      goals_planned: 0,
    });
  }

  // Each category's own figures, before parents take in their subcategories.
  const own = categories.map((c) => ({ id: c.category_id, kind: c.kind, bucket: c.bucket, planned: c.planned }));

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
    if (kids.some((c) => c.fixed) && !kids.every((c) => c.fixed)) {
      // Mixed: fixed children count what's gone off, the rest their share of the period.
      p.pace_expected = r2(
        expectedByToday(p.own_planned, p.own_actual, fraction, p.fixed) + kids.reduce((a, c) => a + c.pace_expected, 0)
      );
    } else {
      p.fixed = p.fixed || kids.every((c) => c.fixed);
      p.pace_expected = expectedByToday(p.planned, p.actual, fraction, p.fixed);
    }
    p.projected = p.fixed ? Math.max(p.actual, p.planned) : fraction > 0 ? r2(p.actual / fraction) : p.actual;
    p.status = spendStatus(p.planned, p.actual, p.pace_expected, fraction, p.kind === 'income' || p.kind === 'loan', p.fixed);
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
  const debt = debtOverview(period).totals;
  const debt_paydown_planned = debt.planned_paydown;
  const debt_paydown_actual = debt.paid_down;
  const borrowed_unplanned = db
    .prepare(
      `SELECT t.id AS transaction_id, t.date, t.description, t.amount FROM transactions t
       WHERE COALESCE(t.budget_date, t.date) BETWEEN ? AND ? AND t.ignored = 0 AND t.amount > 0
         AND EXISTS (SELECT 1 FROM transaction_splits s JOIN categories c ON c.id = s.category_id WHERE s.transaction_id = t.id AND c.kind = 'loan')
         AND NOT EXISTS (SELECT 1 FROM payment_plans p WHERE p.loan_transaction_id = t.id)
       ORDER BY t.date`
    )
    .all(period.start, period.end) as PeriodKpis['borrowed_unplanned'];
  const daysLeft = period.days - elapsedDays;
  const expense_remaining = r2(expense_planned - expense_actual);

  const statusRows = db
    .prepare(
      `SELECT status, COUNT(*) AS n FROM (SELECT ${TX_STATUS_SQL} AS status FROM transactions t WHERE COALESCE(t.budget_date, t.date) BETWEEN ? AND ?) GROUP BY status`
    )
    .all(period.start, period.end) as { status: string; n: number }[];
  const st = Object.fromEntries(statusRows.map((r) => [r.status, r.n])) as Record<string, number>;
  const slipTotal = db
    .prepare(
      `SELECT COUNT(DISTINCT t.id) AS n,
              COUNT(DISTINCT CASE WHEN EXISTS (SELECT 1 FROM receipts r WHERE r.transaction_id = t.id) THEN t.id END) AS with_slip
       FROM transactions t JOIN transaction_splits s ON s.transaction_id = t.id JOIN categories c ON c.id = s.category_id
       WHERE COALESCE(t.budget_date, t.date) BETWEEN ? AND ? AND t.ignored = 0 AND c.requires_slip = 1
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
      // Fixed costs count what's gone off, so a debit order doesn't push the group ahead of pace.
      const pace = r2(members.reduce((a, c) => a + c.pace_expected, 0));
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

  // The plan, savings first (each category counted once, by its own figures).
  const planOf = (bucket: Bucket) => r2(own.filter((c) => c.kind === 'expense' && c.bucket === bucket).reduce((a, c) => a + c.planned, 0));
  const plan = {
    income: income_planned,
    savings: savings_planned,
    live_on: r2(income_planned - savings_planned),
    fixed: planOf('fixed'),
    day_to_day: planOf('day_to_day'),
    debt: planOf('debt'),
    surplus: 0,
  };
  plan.surplus = r2(plan.live_on - plan.fixed - plan.day_to_day - plan.debt);

  // Day-to-day spending per week: everything that isn't fixed or debt,
  // including what isn't categorised yet (most of that is day-to-day).
  const dayToDay = new Set(own.filter((c) => c.kind === 'expense' && c.bucket === 'day_to_day' && c.id).map((c) => c.id));
  const spendRows = db
    .prepare(
      `SELECT COALESCE(t.budget_date, t.date) AS d, s.category_id AS c, -s.amount AS v
       FROM transaction_splits s JOIN transactions t ON t.id = s.transaction_id
       WHERE COALESCE(t.budget_date, t.date) BETWEEN ? AND ? AND t.ignored = 0
       UNION ALL
       SELECT COALESCE(t.budget_date, t.date), NULL,
              -(t.amount - COALESCE((SELECT SUM(s.amount) FROM transaction_splits s WHERE s.transaction_id = t.id), 0))
       FROM transactions t
       WHERE COALESCE(t.budget_date, t.date) BETWEEN ? AND ? AND t.ignored = 0 AND t.amount < 0
         AND t.amount - COALESCE((SELECT SUM(s.amount) FROM transaction_splits s WHERE s.transaction_id = t.id), 0) < -0.009`
    )
    .all(period.start, period.end, period.start, period.end) as { d: string; c: string | null; v: number }[];
  const weekBudget = plan.day_to_day;
  const blocks = payWeeks(period);
  const nWeeks = blocks.length;
  const ownPlanned = new Map(own.filter((c) => c.id && dayToDay.has(c.id)).map((c) => [c.id as string, c.planned]));
  if (opts.migrate) migrateWeekTotals(period.start, nWeeks, ownPlanned);

  // Amounts set by hand per category and week; a category's other weeks share
  // what's left of its plan for the period, by days.
  const cells = new Map<string, Map<number, number>>();
  for (const r of db.prepare('SELECT category_id, week_n, amount FROM week_category_plans WHERE period_start = ?').all(period.start) as {
    category_id: string;
    week_n: number;
    amount: number;
  }[]) {
    if (r.week_n < 1 || r.week_n > nWeeks || !dayToDay.has(r.category_id)) continue;
    if (!cells.has(r.category_id)) cells.set(r.category_id, new Map());
    cells.get(r.category_id)!.set(r.week_n, r.amount);
  }
  const weekOf = (d: string) => blocks.findIndex((w) => d >= w.start && d <= w.end);
  const spentBy = new Map<string | null, number[]>();
  for (const r of spendRows) {
    if (r.c !== null && !dayToDay.has(r.c)) continue;
    const i = weekOf(r.d);
    if (i < 0) continue;
    if (!spentBy.has(r.c)) spentBy.set(r.c, blocks.map(() => 0));
    spentBy.get(r.c)![i] += r.v;
  }
  // What's planned for a category's week, in words.
  const notes = new Map<string, Map<number, string>>();
  for (const r of db.prepare('SELECT category_id, week_n, note FROM week_category_notes WHERE period_start = ?').all(period.start) as {
    category_id: string;
    week_n: number;
    note: string;
  }[]) {
    if (r.week_n < 1 || r.week_n > nWeeks || !dayToDay.has(r.category_id) || !r.note.trim()) continue;
    if (!notes.has(r.category_id)) notes.set(r.category_id, new Map());
    notes.get(r.category_id)!.set(r.week_n, r.note);
  }
  const catIds = [
    ...new Set([...ownPlanned.keys(), ...cells.keys(), ...notes.keys(), ...[...spentBy.keys()].filter((k): k is string => k !== null)]),
  ].filter(
    (id) => (ownPlanned.get(id) ?? 0) > 0 || cells.has(id) || notes.has(id) || spentBy.has(id)
  );
  const byIdAll = new Map(categories.map((c) => [c.category_id, c]));
  const weekCats: WeekCategoryKpi[] = catIds.map((id) => {
    const planned = ownPlanned.get(id) ?? 0;
    const set = cells.get(id) ?? new Map<number, number>();
    const setTotal = [...set.values()].reduce((a, v) => a + v, 0);
    const freeDays = blocks.reduce((a, w, i) => a + (set.has(i + 1) ? 0 : w.days), 0);
    const rest = Math.max(0, planned - setTotal);
    const spent = spentBy.get(id) ?? blocks.map(() => 0);
    const c = byIdAll.get(id);
    return {
      category_id: id,
      name: c?.name ?? '?',
      icon: c?.icon ?? null,
      parent_id: c?.parent_id ?? null,
      planned,
      weeks: blocks.map((w, i) => ({
        plan: r2(set.has(i + 1) ? set.get(i + 1)! : freeDays ? (rest * w.days) / freeDays : 0),
        custom: set.has(i + 1),
        note: notes.get(id)?.get(i + 1) ?? null,
        spent: r2(spent[i]),
      })),
    };
  });
  // Spending not given a category yet counts against the week, with no plan of its own.
  if (spentBy.has(null)) {
    weekCats.push({
      category_id: null,
      name: 'Uncategorised',
      icon: '❓',
      parent_id: null,
      planned: 0,
      weeks: spentBy.get(null)!.map((v) => ({ plan: 0, custom: false, spent: r2(v), note: null })),
    });
  }

  let carried = 0; // cumulative base − spent of finished weeks
  let current: number | null = null;
  const weeks: WeekKpi[] = blocks.map((w, i) => {
    const custom = weekCats.some((c) => c.weeks[i].custom);
    const base = r2(weekCats.reduce((a, c) => a + c.weeks[i].plan, 0));
    const spent = r2(weekCats.reduce((a, c) => a + c.weeks[i].spent, 0));
    const state = w.end < today ? 'past' : w.start <= today ? 'current' : 'future';
    if (state === 'current') current = i;
    const allowance = state === 'future' ? null : r2(base + carried);
    if (state !== 'future') carried = r2(carried + base - spent);
    const weekNotes = weekCats
      .filter((c) => c.category_id && c.weeks[i].note)
      .map((c) => ({ category_id: c.category_id!, name: c.name, icon: c.icon, note: c.weeks[i].note! }));
    return { n: i + 1, ...w, base, custom, allowance, spent, left: allowance === null ? null : r2(allowance - spent), state, notes: weekNotes };
  });

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
      debt_paydown_planned,
      debt_paydown_actual,
      // Paydown is inside expense_actual (each debt's Debt repayments line).
      net: r2(income_actual + borrowed_actual - expense_actual - savings_actual),
      savings_rate: income_actual > 0 ? r2(((income_actual - expense_actual) / income_actual) * 100) : null,
      expense_remaining,
      daily_allowance: daysLeft > 0 ? r2(expense_remaining / daysLeft) : null,
      unallocated: r2(income_planned - expense_planned - savings_planned),
      debt_to_income: income_planned > 0 ? r2((plan.debt / income_planned) * 100) : null,
      investment_to_income_planned: income_planned > 0 ? r2((savings_planned / income_planned) * 100) : null,
      investment_to_income: income_actual > 0 ? r2((savings_actual / income_actual) * 100) : null,
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
    plan,
    weekly: { budget: weekBudget, planned: r2(weeks.reduce((a, w) => a + w.base, 0)), current, weeks, categories: weekCats },
  };
}

export interface TrendPoint {
  period: Period;
  income: number;
  expenses: number;
  expenses_planned: number;
  savings: number;
  net: number;
  debt_to_income: number | null;
  investment_to_income: number | null;
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
      debt_to_income: k.totals.debt_to_income,
      investment_to_income: k.totals.investment_to_income,
      categories: k.categories
        .filter((c) => c.kind !== 'income' && c.kind !== 'loan')
        .map((c) => ({ category_id: c.category_id, name: c.name, parent_id: c.parent_id, planned: c.planned, actual: c.actual })),
    };
  });
}
