import { Router } from 'express';
import { db, now } from '../db';
import { publishSensors } from '../ha';
import { debtOverview, ensureDebtCategories, recheckDebtLines, setPlannedPayment } from '../services/debts';
import { resolvePeriod } from '../services/periods';
import { h, notFound, num, round2 } from '../util';

export const debtsRouter = Router();

/** Every credit card and loan account: owed, plan, this period, payoff. */
debtsRouter.get(
  '/',
  h((req, res) => {
    ensureDebtCategories();
    res.json(debtOverview(resolvePeriod(req.query.period)));
  })
);

/** The plan for one debt account. Body: any of planned_payment,
 *  interest_rate (annual %), credit_limit — null clears one. */
debtsRouter.patch(
  '/:accountId',
  h((req, res) => {
    const id = String(req.params.accountId);
    if (!db.prepare("SELECT 1 FROM accounts WHERE id = ? AND type IN ('credit', 'loan')").get(id)) notFound('Not a credit card or loan account');
    const body = req.body ?? {};
    const value = (v: unknown) => (v === null || v === '' ? null : round2(Math.abs(num(v))));
    // The planned repayment is the debt's Debt repayments budget line.
    if ('planned_payment' in body) setPlannedPayment(id, value(body.planned_payment));
    for (const col of ['interest_rate', 'credit_limit']) {
      if (col in body) db.prepare(`UPDATE accounts SET ${col} = ?, updated_at = ? WHERE id = ?`).run(value(body[col]), now(), id);
    }
    publishSensors().catch(() => undefined);
    res.json(debtOverview(resolvePeriod(req.query.period)));
  })
);

/** Re-files lines imported before debt accounts were understood, and pairs
 *  repayments with the money leaving the paying account. */
debtsRouter.post(
  '/recheck',
  h((_req, res) => {
    const r = recheckDebtLines();
    publishSensors().catch(() => undefined);
    res.json(r);
  })
);
