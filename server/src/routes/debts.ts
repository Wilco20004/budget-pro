import { Router } from 'express';
import { db, now } from '../db';
import { publishSensors } from '../ha';
import { debtOverview, ensureDebtCategories, recheckDebtLines, setOwed, setPaidInFull, setPlannedPayment } from '../services/debts';
import { resolvePeriod, todayIso } from '../services/periods';
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
 *  interest_rate (annual %), credit_limit — null clears one — and
 *  paid_in_full (a card cleared every month: not debt to pay down). */
debtsRouter.patch(
  '/:accountId',
  h((req, res) => {
    const id = String(req.params.accountId);
    if (!db.prepare("SELECT 1 FROM accounts WHERE id = ? AND type IN ('credit', 'loan')").get(id)) notFound('Not a credit card or loan account');
    const body = req.body ?? {};
    const value = (v: unknown) => (v === null || v === '' ? null : round2(Math.abs(num(v))));
    // The planned repayment is the debt's Debt repayments budget line.
    if ('paid_in_full' in body) setPaidInFull(id, Boolean(body.paid_in_full));
    if ('planned_payment' in body) setPlannedPayment(id, value(body.planned_payment));
    for (const col of ['interest_rate', 'credit_limit']) {
      if (col in body) db.prepare(`UPDATE accounts SET ${col} = ?, updated_at = ? WHERE id = ?`).run(value(body[col]), now(), id);
    }
    publishSensors().catch(() => undefined);
    res.json(debtOverview(resolvePeriod(req.query.period)));
  })
);

/** Sets what's owed on a debt account, e.g. from the banking app between
 *  statements. Body: { owed, date? } — date defaults to today; owed null
 *  clears the balance set for that day. Statement lines after the date and
 *  any newer statement take over from it. */
debtsRouter.put(
  '/:accountId/balance',
  h((req, res) => {
    const id = String(req.params.accountId);
    if (!db.prepare("SELECT 1 FROM accounts WHERE id = ? AND type IN ('credit', 'loan')").get(id)) notFound('Not a credit card or loan account');
    const body = req.body ?? {};
    const date = body.date ? String(body.date) : todayIso();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) throw new Error('Date must be YYYY-MM-DD');
    if (date > todayIso()) throw new Error('The date can’t be in the future');
    const owed = body.owed === null || body.owed === '' || body.owed === undefined ? null : round2(num(body.owed, NaN));
    if (owed !== null && !Number.isFinite(owed)) throw new Error('Owed must be a number');
    setOwed(id, date, owed);
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
