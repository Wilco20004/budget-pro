import { Router } from 'express';
import { db } from '../db';
import { publishSensors } from '../ha';
import { periodKpis, trend } from '../services/kpis';
import { listPlans, planBudget } from '../services/paymentPlans';
import { goalBudget } from '../services/savings';
import { previousPeriod, resolvePeriod } from '../services/periods';
import { h, num, round2 } from '../util';

export const budgetsRouter = Router();

/** Planned amount per category for a period, alongside the category default
 *  and last period's actual — everything needed to fill in a budget. */
budgetsRouter.get(
  '/:period',
  h((req, res) => {
    const period = resolvePeriod(req.params.period);
    const prev = previousPeriod(period);
    const prevActual = new Map(periodKpis(prev).categories.map((c) => [c.category_id, c.actual]));
    const plans = planBudget(period).byCategory;
    const goals = goalBudget();
    const rows = db
      .prepare(
        `SELECT c.id AS category_id, c.name, c.kind, c.icon, c.color, c.requires_slip, c.default_budget, c.personal,
                b.amount AS override, c.group_id, g.name AS group_name
         FROM categories c LEFT JOIN budget_lines b ON b.category_id = c.id AND b.period_start = ?
         LEFT JOIN category_groups g ON g.id = c.group_id
         WHERE c.archived = 0 AND c.kind != 'transfer'
         ORDER BY COALESCE(g.sort_order, 999999), c.sort_order, c.name`
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

export const kpisRouter = Router();

kpisRouter.get(
  '/',
  h((req, res) => res.json(periodKpis(resolvePeriod(req.query.period))))
);

kpisRouter.get(
  '/trend',
  h((req, res) => res.json(trend(num(req.query.count, 6), resolvePeriod(req.query.period))))
);
