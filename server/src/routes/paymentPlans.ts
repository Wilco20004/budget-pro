import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { db, now } from '../db';
import { publishSensors } from '../ha';
import { describePlan, FREQUENCIES, Frequency, getPlan, linkPaymentPlans, listPlans } from '../services/paymentPlans';
import { resolvePeriod } from '../services/periods';
import { h, notFound, num, round2, str } from '../util';

export const paymentPlansRouter = Router();

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function planInput(body: Record<string, unknown>) {
  const name = str(body.name);
  if (!name) throw new Error('Name is required');
  const category_id = str(body.category_id);
  if (!category_id || !db.prepare("SELECT 1 FROM categories WHERE id = ? AND kind != 'income'").get(category_id)) {
    throw new Error('Choose a spending category for the plan');
  }
  const instalment = round2(Math.abs(num(body.instalment)));
  if (!instalment) throw new Error('Instalment amount is required');
  const instalments = Math.round(num(body.instalments));
  if (instalments < 1 || instalments > 120) throw new Error('Number of instalments must be 1–120');
  const frequency = (str(body.frequency) ?? 'monthly') as Frequency;
  if (!FREQUENCIES.includes(frequency)) throw new Error(`Frequency must be one of ${FREQUENCIES.join(', ')}`);
  const first_due = str(body.first_due);
  if (!first_due || !DATE.test(first_due)) throw new Error('First payment date is required (YYYY-MM-DD)');
  const ended_on = str(body.ended_on);
  if (ended_on && !DATE.test(ended_on)) throw new Error('ended_on must be YYYY-MM-DD');
  const pattern = str(body.match_pattern);
  // The borrowed-money transaction this plan pays back, if any.
  const loan_transaction_id = str(body.loan_transaction_id);
  if (loan_transaction_id && !db.prepare('SELECT 1 FROM transactions WHERE id = ?').get(loan_transaction_id)) {
    throw new Error('Borrowed-money transaction not found');
  }
  return {
    name,
    category_id,
    instalment,
    instalments,
    frequency,
    first_due,
    match_pattern: pattern ? pattern.toUpperCase() : null,
    notes: str(body.notes),
    ended_on,
    loan_transaction_id,
  };
}

export function createPlan(body: Record<string, unknown>) {
  const p = planInput(body);
  const id = uuid();
  const t = now();
  db.prepare(
    `INSERT INTO payment_plans (id, name, category_id, instalment, instalments, frequency, first_due, match_pattern, notes, ended_on, loan_transaction_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, p.name, p.category_id, p.instalment, p.instalments, p.frequency, p.first_due, p.match_pattern, p.notes, p.ended_on, p.loan_transaction_id, t, t);
  // Instalments already on imported statements get linked straight away.
  linkPaymentPlans();
  publishSensors().catch(() => undefined);
  return describePlan(getPlan(id)!);
}

/** ?period= adds this_period (what the plan adds to that period's budget). */
paymentPlansRouter.get(
  '/',
  h((req, res) => res.json(listPlans(resolvePeriod(req.query.period))))
);

paymentPlansRouter.get(
  '/:id',
  h((req, res) => {
    const p = getPlan(String(req.params.id));
    if (!p) notFound('Payment plan not found');
    const payments = db
      .prepare('SELECT id, date, description, amount FROM transactions WHERE payment_plan_id = ? ORDER BY date')
      .all(p.id);
    res.json({ ...describePlan(p, resolvePeriod(req.query.period)), payments });
  })
);

paymentPlansRouter.post(
  '/',
  h((req, res) => res.status(201).json(createPlan(req.body ?? {})))
);

paymentPlansRouter.put(
  '/:id',
  h((req, res) => {
    const id = String(req.params.id);
    if (!getPlan(id)) notFound('Payment plan not found');
    const p = planInput(req.body ?? {});
    db.prepare(
      `UPDATE payment_plans SET name = ?, category_id = ?, instalment = ?, instalments = ?, frequency = ?, first_due = ?, match_pattern = ?, notes = ?, ended_on = ?, loan_transaction_id = ?, updated_at = ?
       WHERE id = ?`
    ).run(p.name, p.category_id, p.instalment, p.instalments, p.frequency, p.first_due, p.match_pattern, p.notes, p.ended_on, p.loan_transaction_id, now(), id);
    linkPaymentPlans();
    publishSensors().catch(() => undefined);
    res.json(describePlan(getPlan(id)!));
  })
);

/** Removes the plan and its budget add-ons; linked transactions keep their
 *  category, just not the link. */
paymentPlansRouter.delete(
  '/:id',
  h((req, res) => {
    db.transaction(() => {
      db.prepare('UPDATE transactions SET payment_plan_id = NULL WHERE payment_plan_id = ?').run(req.params.id);
      db.prepare('DELETE FROM payment_plans WHERE id = ?').run(req.params.id);
    })();
    publishSensors().catch(() => undefined);
    res.status(204).end();
  })
);
