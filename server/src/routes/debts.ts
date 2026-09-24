import { Router } from 'express';
import { db, now } from '../db';
import { publishSensors } from '../ha';
import { debtOverview, recheckDebtLines } from '../services/debts';
import { resolvePeriod } from '../services/periods';
import { h, notFound, num, round2 } from '../util';

export const debtsRouter = Router();

/** Every credit card and loan account: owed, plan, this period, payoff. */
debtsRouter.get(
  '/',
  h((req, res) => res.json(debtOverview(resolvePeriod(req.query.period))))
);

/** The plan for one debt account. Body: any of planned_payment,
 *  interest_rate (annual %), credit_limit — null clears one. */
debtsRouter.patch(
  '/:accountId',
  h((req, res) => {
    const id = String(req.params.accountId);
    if (!db.prepare("SELECT 1 FROM accounts WHERE id = ? AND type IN ('credit', 'loan')").get(id)) notFound('Not a credit card or loan account');
    const body = req.body ?? {};
    for (const col of ['planned_payment', 'interest_rate', 'credit_limit']) {
      if (!(col in body)) continue;
      const v = body[col] === null || body[col] === '' ? null : round2(Math.abs(num(body[col])));
      db.prepare(`UPDATE accounts SET ${col} = ?, updated_at = ? WHERE id = ?`).run(v, now(), id);
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
