import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { db, now } from '../db';
import { publishSensors } from '../ha';
import { resolvePeriod } from '../services/periods';
import {
  describeGoal,
  getGoal,
  linkSavings,
  savingsOverview,
  setTransactionAllocations,
  transactionAllocations,
} from '../services/savings';
import { h, notFound, num, round2, str } from '../util';

export const savingsRouter = Router();

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function goalInput(body: Record<string, unknown>) {
  const name = str(body.name);
  if (!name) throw new Error('Name is required');
  const target = body.target === null || body.target === undefined || body.target === '' ? null : round2(Math.abs(num(body.target)));
  const target_date = str(body.target_date);
  if (target_date && !DATE.test(target_date)) throw new Error('Target date must be YYYY-MM-DD');
  const account_id = str(body.account_id);
  if (account_id && !db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(account_id)) throw new Error('Account not found');
  const category_id = str(body.category_id);
  if (category_id && !db.prepare('SELECT 1 FROM categories WHERE id = ?').get(category_id)) throw new Error('Category not found');
  const pattern = str(body.match_pattern);
  return {
    name,
    icon: str(body.icon),
    target: target || null,
    target_date,
    account_id,
    // A physical goal needs its own account.
    tracks_account: body.tracks_account && account_id ? 1 : 0,
    category_id,
    topup: round2(Math.abs(num(body.topup))),
    match_pattern: pattern ? pattern.toUpperCase() : null,
    opening_balance: round2(num(body.opening_balance)),
    archived: body.archived ? 1 : 0,
    sort_order: Math.round(num(body.sort_order)),
  };
}

/** A physical goal owns its account: a second goal can't also track it. */
function checkPhysical(g: ReturnType<typeof goalInput>, id: string | null) {
  if (!g.tracks_account) return;
  const other = db
    .prepare('SELECT name FROM savings_goals WHERE account_id = ? AND tracks_account = 1 AND archived = 0 AND id != ?')
    .get(g.account_id, id ?? '') as { name: string } | undefined;
  if (other) throw new Error(`${other.name} already uses that account as its own — make this one a pot (virtual) in it instead`);
}

export function createGoal(body: Record<string, unknown>) {
  const g = goalInput(body);
  checkPhysical(g, null);
  const id = uuid();
  const t = now();
  if (!body.sort_order) g.sort_order = ((db.prepare('SELECT MAX(sort_order) AS m FROM savings_goals').get() as { m: number | null }).m ?? 0) + 1;
  db.prepare(
    `INSERT INTO savings_goals (id, name, icon, target, target_date, account_id, tracks_account, category_id, topup, match_pattern, opening_balance, archived, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, g.name, g.icon, g.target, g.target_date, g.account_id, g.tracks_account, g.category_id, g.topup, g.match_pattern, g.opening_balance, g.archived, g.sort_order, t, t);
  linkSavings();
  publishSensors().catch(() => undefined);
  return describeGoal(getGoal(id)!);
}

/** ?period= for this period's top-ups; ?all=1 includes archived goals. */
savingsRouter.get(
  '/',
  h((req, res) => res.json(savingsOverview(resolvePeriod(req.query.period), req.query.all === '1')))
);

savingsRouter.post(
  '/goals',
  h((req, res) => res.status(201).json(createGoal(req.body ?? {})))
);

savingsRouter.put(
  '/goals/:id',
  h((req, res) => {
    const id = String(req.params.id);
    if (!getGoal(id)) notFound('Savings goal not found');
    const g = goalInput(req.body ?? {});
    checkPhysical(g, id);
    db.prepare(
      `UPDATE savings_goals SET name = ?, icon = ?, target = ?, target_date = ?, account_id = ?, tracks_account = ?, category_id = ?, topup = ?,
         match_pattern = ?, opening_balance = ?, archived = ?, sort_order = ?, updated_at = ? WHERE id = ?`
    ).run(g.name, g.icon, g.target, g.target_date, g.account_id, g.tracks_account, g.category_id, g.topup, g.match_pattern, g.opening_balance, g.archived, g.sort_order, now(), id);
    linkSavings();
    publishSensors().catch(() => undefined);
    res.json(describeGoal(getGoal(id)!));
  })
);

savingsRouter.delete(
  '/goals/:id',
  h((req, res) => {
    db.prepare('DELETE FROM savings_goals WHERE id = ?').run(req.params.id);
    publishSensors().catch(() => undefined);
    res.status(204).end();
  })
);

savingsRouter.get(
  '/goals/:id/movements',
  h((req, res) => {
    const g = getGoal(String(req.params.id));
    if (!g) notFound('Savings goal not found');
    res.json(
      db
        .prepare(
          `SELECT m.*, t.description AS transaction_description FROM savings_movements m
           LEFT JOIN transactions t ON t.id = m.transaction_id WHERE m.goal_id = ? ORDER BY m.date DESC, m.created_at DESC`
        )
        .all(g.id)
    );
  })
);

/** A top-up (+) or withdrawal (−) by hand — cash put away, interest, moving
 *  money between pots, or spending from a pot. */
export function addMovement(goalId: string, body: Record<string, unknown>) {
  const g = getGoal(goalId);
  if (!g) notFound('Savings goal not found');
  const amount = round2(num(body.amount));
  if (!amount) throw new Error('Amount is required (negative for a withdrawal)');
  const date = str(body.date) ?? now().slice(0, 10);
  if (!DATE.test(date)) throw new Error('Date must be YYYY-MM-DD');
  const id = uuid();
  db.prepare(
    "INSERT INTO savings_movements (id, goal_id, date, amount, transaction_id, note, source, created_at) VALUES (?, ?, ?, ?, NULL, ?, 'manual', ?)"
  ).run(id, g.id, date, amount, str(body.note), now());
  publishSensors().catch(() => undefined);
  return describeGoal(getGoal(g.id)!);
}

savingsRouter.post(
  '/goals/:id/movements',
  h((req, res) => res.status(201).json(addMovement(String(req.params.id), req.body ?? {})))
);

savingsRouter.delete(
  '/movements/:id',
  h((req, res) => {
    db.prepare('DELETE FROM savings_movements WHERE id = ?').run(req.params.id);
    publishSensors().catch(() => undefined);
    res.status(204).end();
  })
);

/** How one transaction is shared out over goals. */
savingsRouter.get(
  '/allocations/:txId',
  h((req, res) => res.json(transactionAllocations(String(req.params.txId))))
);

/** Body: { allocations: [{ goal_id, amount }] } — amounts as positive numbers. */
savingsRouter.put(
  '/allocations/:txId',
  h((req, res) => {
    const list = Array.isArray(req.body?.allocations) ? req.body.allocations : [];
    const r = setTransactionAllocations(
      String(req.params.txId),
      list.map((a: Record<string, unknown>) => ({ goal_id: String(a.goal_id), amount: num(a.amount) }))
    );
    publishSensors().catch(() => undefined);
    res.json(r);
  })
);
