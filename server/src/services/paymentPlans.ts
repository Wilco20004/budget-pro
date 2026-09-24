import { v4 as uuid } from 'uuid';
import { db } from '../db';
import { splitPatterns } from './categorize';
import { addDays, parseIso, Period, todayIso, toIso } from './periods';

// Payment plans: a fixed number of instalments (PayJustNow's 3 monthly,
// PayFlex's 4 fortnightly, a medical account paid off over 6 months). Each
// instalment is added to the plan's category budget in the period it falls
// due — so the budget rises while the plan runs and drops back on its own
// once it's paid off. Bank transactions that pay an instalment are linked to
// the plan (automatically via match_pattern + amount, or by hand), which is
// what "paid so far" counts.

export type Frequency = 'monthly' | 'fortnightly' | 'weekly';
export const FREQUENCIES: Frequency[] = ['monthly', 'fortnightly', 'weekly'];

export interface PlanRow {
  id: string;
  name: string;
  category_id: string;
  instalment: number;
  instalments: number;
  frequency: Frequency;
  first_due: string;
  match_pattern: string | null;
  notes: string | null;
  ended_on: string | null;
  created_at: string;
  updated_at: string;
}

function addMonths(iso: string, n: number): string {
  const d = parseIso(iso);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + n;
  const dim = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return toIso(y, m, Math.min(d.getUTCDate(), dim));
}

/** Every instalment's due date, dropping those after ended_on. */
export function dueDates(p: Pick<PlanRow, 'first_due' | 'instalments' | 'frequency' | 'ended_on'>): string[] {
  const out: string[] = [];
  for (let i = 0; i < p.instalments; i++) {
    const d =
      p.frequency === 'monthly' ? addMonths(p.first_due, i) : addDays(p.first_due, i * (p.frequency === 'weekly' ? 7 : 14));
    if (p.ended_on && d > p.ended_on) break;
    out.push(d);
  }
  return out;
}

function r2(n: number) {
  return Math.round(n * 100) / 100;
}

/** What the plans add to each category's budget in a period. */
export function planBudget(period: Period): { byCategory: Map<string, number>; plans: { plan_id: string; category_id: string; amount: number; due: string[] }[] } {
  const byCategory = new Map<string, number>();
  const plans: { plan_id: string; category_id: string; amount: number; due: string[] }[] = [];
  for (const p of db.prepare('SELECT * FROM payment_plans').all() as PlanRow[]) {
    const due = dueDates(p).filter((d) => d >= period.start && d <= period.end);
    if (!due.length) continue;
    const amount = r2(p.instalment * due.length);
    byCategory.set(p.category_id, r2((byCategory.get(p.category_id) ?? 0) + amount));
    plans.push({ plan_id: p.id, category_id: p.category_id, amount, due });
  }
  return { byCategory, plans };
}

/** A plan with its schedule and progress, for the Plan page and MCP. */
export function describePlan(p: PlanRow, period?: Period) {
  const due = dueDates(p);
  const paid = db
    .prepare('SELECT COUNT(*) AS n, COALESCE(-SUM(amount), 0) AS total FROM transactions WHERE payment_plan_id = ?')
    .get(p.id) as { n: number; total: number };
  const cat = db.prepare('SELECT name, icon FROM categories WHERE id = ?').get(p.category_id) as { name: string; icon: string | null } | undefined;
  const today = todayIso();
  const total = r2(p.instalment * p.instalments);
  const status = p.ended_on
    ? 'ended'
    : paid.n >= p.instalments || paid.total >= total - 0.5
      ? 'paid_off'
      : due[0] > today
        ? 'upcoming'
        : 'active';
  return {
    ...p,
    category_name: cat?.name ?? null,
    category_icon: cat?.icon ?? null,
    total,
    schedule: due,
    last_due: due[due.length - 1] ?? null,
    // The next instalment not yet covered by a linked payment.
    next_due: status === 'active' || status === 'upcoming' ? due[paid.n] ?? null : null,
    paid_count: paid.n,
    paid_total: r2(paid.total),
    remaining: r2(Math.max(0, total - paid.total)),
    status,
    this_period: period ? r2(p.instalment * due.filter((d) => d >= period.start && d <= period.end).length) : undefined,
  };
}

export function listPlans(period?: Period) {
  return (db.prepare('SELECT * FROM payment_plans ORDER BY ended_on IS NOT NULL, first_due DESC').all() as PlanRow[]).map((p) =>
    describePlan(p, period)
  );
}

export function getPlan(id: string): PlanRow | undefined {
  return db.prepare('SELECT * FROM payment_plans WHERE id = ?').get(id) as PlanRow | undefined;
}

/** Links unlinked outflows to the plan they pay: the description contains
 *  the plan's match pattern, the amount is the instalment (±2%, min R1),
 *  and the date is within the plan's run. When several plans with the same
 *  pattern run at once (two PayJustNow purchases) the closest amount wins.
 *  A linked transaction without a manual category gets the plan's.
 *  Returns how many were linked. */
export function linkPaymentPlans(transactionIds?: string[]): number {
  const plans = (db.prepare('SELECT * FROM payment_plans WHERE match_pattern IS NOT NULL').all() as PlanRow[]).map((p) => {
    const due = dueDates(p);
    return {
      p,
      patterns: splitPatterns(p.match_pattern ?? ''),
      from: addDays(p.first_due, -10),
      to: addDays(due[due.length - 1] ?? p.first_due, 20),
      linked: (db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE payment_plan_id = ?').get(p.id) as { n: number }).n,
    };
  });
  if (!plans.some((x) => x.patterns.length)) return 0;
  const txs = (
    transactionIds
      ? transactionIds.map((id) => db.prepare('SELECT id, date, description, amount, payment_plan_id FROM transactions WHERE id = ?').get(id))
      : db.prepare('SELECT id, date, description, amount, payment_plan_id FROM transactions WHERE payment_plan_id IS NULL AND amount < 0 ORDER BY date').all()
  ).filter(Boolean) as { id: string; date: string; description: string; amount: number; payment_plan_id: string | null }[];

  const link = db.prepare('UPDATE transactions SET payment_plan_id = ? WHERE id = ?');
  let count = 0;
  db.transaction(() => {
    for (const tx of txs) {
      if (tx.payment_plan_id || tx.amount >= 0) continue;
      const hay = ` ${tx.description.toUpperCase().replace(/\s+/g, ' ')} `;
      const out = -tx.amount;
      let best: (typeof plans)[number] | null = null;
      let bestDiff = Infinity;
      for (const x of plans) {
        if (x.linked >= x.p.instalments) continue;
        if (tx.date < x.from || tx.date > x.to) continue;
        if (x.p.ended_on && tx.date > x.p.ended_on) continue;
        if (!x.patterns.some((pt) => hay.includes(pt))) continue;
        const diff = Math.abs(out - x.p.instalment);
        if (diff > Math.max(1, x.p.instalment * 0.02)) continue;
        if (diff < bestDiff || (diff === bestDiff && best && x.p.first_due < best.p.first_due)) {
          best = x;
          bestDiff = diff;
        }
      }
      if (!best) continue;
      link.run(best.p.id, tx.id);
      best.linked++;
      applyPlanCategory(tx.id, best.p.category_id, tx.amount);
      count++;
    }
  })();
  return count;
}

/** Puts a linked transaction in the plan's category unless the user chose
 *  its category(ies) by hand. */
export function applyPlanCategory(txId: string, categoryId: string, amount: number) {
  const manual = db.prepare("SELECT 1 FROM transaction_splits WHERE transaction_id = ? AND source != 'rule' LIMIT 1").get(txId);
  if (manual) return;
  db.prepare('DELETE FROM transaction_splits WHERE transaction_id = ?').run(txId);
  db.prepare(`INSERT INTO transaction_splits (id, transaction_id, category_id, amount, source) VALUES (?, ?, ?, ?, 'rule')`).run(
    uuid(),
    txId,
    categoryId,
    amount
  );
}
