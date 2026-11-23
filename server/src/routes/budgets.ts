import { Router } from 'express';
import { db } from '../db';
import { publishSensors } from '../ha';
import { periodKpis, trend } from '../services/kpis';
import { listPlans, planBudget } from '../services/paymentPlans';
import { debtOverview, ensureDebtCategories } from '../services/debts';
import { goalBudget } from '../services/savings';
import { previousPeriod, resolvePeriod } from '../services/periods';
import { h, HttpError, num, round2 } from '../util';

export const budgetsRouter = Router();

/** Planned amount per category for a period, alongside the category default
 *  and last period's actual — everything needed to fill in a budget. */
budgetsRouter.get(
  '/:period',
  h((req, res) => {
    const period = resolvePeriod(req.params.period);
    const prev = previousPeriod(period);
    ensureDebtCategories();
    const debtByCategory = new Map(debtOverview(period).debts.map((d) => [d.category_id, d]));
    // Own figures for a parent with subcategories: its row plans what isn't split further.
    const own = (c: { actual: number; own_actual?: number }) => c.own_actual ?? c.actual;
    const prevActual = new Map(periodKpis(prev).categories.map((c) => [c.category_id, own(c)]));
    const k = periodKpis(period);
    const actual = new Map(k.categories.map((c) => [c.category_id, own(c)]));
    const bucket = new Map(k.categories.map((c) => [c.category_id, c.bucket]));
    const plans = planBudget(period).byCategory;
    const goals = goalBudget();
    const rows = db
      .prepare(
        `SELECT c.id AS category_id, c.name, c.kind, c.icon, c.color, c.requires_slip, c.default_budget, c.personal, c.parent_id,
                b.amount AS override, c.group_id, g.name AS group_name
         FROM categories c LEFT JOIN budget_lines b ON b.category_id = c.id AND b.period_start = ?
         LEFT JOIN category_groups g ON g.id = c.group_id
         WHERE c.archived = 0 AND c.kind NOT IN ('transfer', 'loan')
         ORDER BY COALESCE(g.sort_order, 999999),
                  -- a subcategory sorts right after its parent
                  COALESCE((SELECT p.sort_order FROM categories p WHERE p.id = c.parent_id), c.sort_order),
                  COALESCE((SELECT p.name FROM categories p WHERE p.id = c.parent_id), c.name),
                  c.parent_id IS NOT NULL, c.sort_order, c.name`
      )
      .all(period.start) as { category_id: string; kind: string; default_budget: number; override: number | null }[];
    res.json({
      period,
      lines: rows.map((r) => ({
        ...r,
        // planned is what the user sets; payment plan instalments are added on top.
        planned: r.override ?? r.default_budget,
        plans: r.kind === 'income' ? 0 : plans.get(r.category_id) ?? 0,
        goals: r.kind === 'income' ? 0 : goals.get(r.category_id) ?? 0,
        previous_actual: prevActual.get(r.category_id) ?? 0,
        actual: actual.get(r.category_id) ?? 0,
        // Fixed, debt or day-to-day, for the savings-first summary.
        bucket: r.kind === 'expense' ? bucket.get(r.category_id) ?? 'day_to_day' : null,
        // A tracked card/loan's own line: what's owed, for the Plan page.
        debt: debtByCategory.has(r.category_id)
          ? { account_id: debtByCategory.get(r.category_id)!.account_id, owed: debtByCategory.get(r.category_id)!.owed }
          : null,
      })),
      payment_plans: listPlans(period).filter((p) => p.this_period || p.status === 'active' || p.status === 'upcoming'),
    });
  })
);

/** Body: { lines: [{ category_id, amount }], set_default?: boolean }.
 *  set_default also makes these the default for all future periods. */
budgetsRouter.put(
  '/:period',
  h((req, res) => {
    const period = resolvePeriod(req.params.period);
    const lines = Array.isArray(req.body?.lines) ? req.body.lines : [];
    const upsert = db.prepare(
      `INSERT INTO budget_lines (period_start, category_id, amount) VALUES (?, ?, ?)
       ON CONFLICT(period_start, category_id) DO UPDATE SET amount = excluded.amount`
    );
    const setDefault = db.prepare('UPDATE categories SET default_budget = ? WHERE id = ?');
    db.transaction(() => {
      for (const l of lines) {
        const amount = round2(num(l.amount));
        upsert.run(period.start, String(l.category_id), amount);
        if (req.body?.set_default) setDefault.run(amount, String(l.category_id));
      }
    })();
    publishSensors().catch(() => undefined);
    res.json({ ok: true });
  })
);

budgetsRouter.post(
  '/:period/copy-previous',
  h((req, res) => {
    const period = resolvePeriod(req.params.period);
    const prev = previousPeriod(period);
    // Copy last period's effective plan (override or default) as explicit lines.
    const r = db
      .prepare(
        `INSERT INTO budget_lines (period_start, category_id, amount)
         SELECT ?, c.id, COALESCE(b.amount, c.default_budget)
         FROM categories c LEFT JOIN budget_lines b ON b.category_id = c.id AND b.period_start = ?
         WHERE c.archived = 0
         ON CONFLICT(period_start, category_id) DO UPDATE SET amount = excluded.amount`
      )
      .run(period.start, prev.start);
    res.json({ copied: r.changes });
  })
);

/** Body: { cells: [{ category_id, n, amount }], notes?: [{ category_id, n, note }] }
 *  — the period's amounts set by hand per category and week, replacing any
 *  set before. amount null (or a cell left out) = automatic: its share of
 *  what the set weeks leave. notes, when sent, replace the period's notes
 *  (left out = notes unchanged, so "All automatic" keeps them). */
budgetsRouter.put(
  '/:period/weeks',
  h((req, res) => {
    const period = resolvePeriod(req.params.period);
    // An older page sends { weeks }: refuse rather than read it as "clear everything".
    if (!Array.isArray(req.body?.cells)) {
      throw new HttpError(400, 'This page is out of date: reload BudgetPro and try again.');
    }
    const cells = req.body.cells as { category_id?: unknown; n?: unknown; amount?: unknown }[];
    const known = new Set((db.prepare('SELECT id FROM categories').all() as { id: string }[]).map((c) => c.id));
    const upsert = db.prepare(
      `INSERT INTO week_category_plans (period_start, week_n, category_id, amount) VALUES (?, ?, ?, ?)
       ON CONFLICT(period_start, week_n, category_id) DO UPDATE SET amount = excluded.amount`
    );
    db.transaction(() => {
      db.prepare('DELETE FROM week_category_plans WHERE period_start = ?').run(period.start);
      // Whole-week amounts from 1.31.0 are replaced by what's saved now.
      db.prepare('DELETE FROM week_plans WHERE period_start = ?').run(period.start);
      for (const c of cells) {
        const n = Math.trunc(num(c?.n));
        const id = String(c?.category_id ?? '');
        if (n < 1 || !known.has(id) || c?.amount === null || c?.amount === undefined || c?.amount === '') continue;
        upsert.run(period.start, n, id, Math.max(0, round2(num(c.amount))));
      }
      if (Array.isArray(req.body?.notes)) {
        db.prepare('DELETE FROM week_category_notes WHERE period_start = ?').run(period.start);
        const addNote = db.prepare(
          `INSERT INTO week_category_notes (period_start, week_n, category_id, note) VALUES (?, ?, ?, ?)
           ON CONFLICT(period_start, week_n, category_id) DO UPDATE SET note = excluded.note`
        );
        for (const x of req.body.notes as { category_id?: unknown; n?: unknown; note?: unknown }[]) {
          const n = Math.trunc(num(x?.n));
          const id = String(x?.category_id ?? '');
          const note = typeof x?.note === 'string' ? x.note.trim().slice(0, 200) : '';
          if (n < 1 || !known.has(id) || !note) continue;
          addNote.run(period.start, n, id, note);
        }
      }
    })();
    publishSensors().catch(() => undefined);
    res.json({ ok: true });
  })
);

export const kpisRouter = Router();

kpisRouter.get(
  '/',
  h((req, res) => res.json(periodKpis(resolvePeriod(req.query.period))))
);

kpisRouter.get(
  '/trend',
  h((req, res) => res.json(trend(num(req.query.count, 6), resolvePeriod(req.query.period))))
);
