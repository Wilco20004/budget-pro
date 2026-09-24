import crypto from 'crypto';
import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { db, now } from '../db';
import { publishSensors } from '../ha';
import { autoCategorize, suggestMerchantPattern, TX_STATUS_SQL } from '../services/categorize';
import { resolvePeriod } from '../services/periods';
import { h, notFound, num, round2, str } from '../util';

export const transactionsRouter = Router();

export interface TxQuery {
  period?: string;
  from?: string;
  to?: string;
  status?: string;
  category_id?: string;
  account_id?: string;
  q?: string;
  limit?: number;
  offset?: number;
}

/** Shared by the REST route and the MCP tools. */
export function queryTransactions(q: TxQuery) {
  const where: string[] = [];
  const params: unknown[] = [];
  let from = q.from;
  let to = q.to;
  if (!from && !to && q.period !== 'all') {
    const p = resolvePeriod(q.period);
    from = p.start;
    to = p.end;
  }
  if (from) {
    where.push('t.date >= ?');
    params.push(from);
  }
  if (to) {
    where.push('t.date <= ?');
    params.push(to);
  }
  if (q.account_id) {
    where.push('t.account_id = ?');
    params.push(q.account_id);
  }
  if (q.category_id) {
    where.push('EXISTS (SELECT 1 FROM transaction_splits s WHERE s.transaction_id = t.id AND s.category_id = ?)');
    params.push(q.category_id);
  }
  if (q.q) {
    where.push('(t.description LIKE ? OR t.notes LIKE ?)');
    params.push(`%${q.q}%`, `%${q.q}%`);
  }
  const statusFilter = q.status && q.status !== 'all' ? q.status : null;
  const limit = Math.min(Math.max(q.limit ?? 500, 1), 5000);
  const offset = Math.max(q.offset ?? 0, 0);

  const sql = `
    SELECT * FROM (
      SELECT t.*, a.name AS account_name, m.name AS merchant_name, ${TX_STATUS_SQL} AS status,
        (SELECT r.id FROM receipts r WHERE r.transaction_id = t.id LIMIT 1) AS receipt_id
      FROM transactions t
      JOIN accounts a ON a.id = t.account_id
      LEFT JOIN merchants m ON m.id = t.merchant_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ) x
    ${statusFilter ? 'WHERE x.status = ?' : ''}
    ORDER BY x.date DESC, x.created_at DESC
    LIMIT ? OFFSET ?`;
  if (statusFilter) params.push(statusFilter);
  params.push(limit, offset);
  const rows = db.prepare(sql).all(...params) as { id: string }[];

  const splitStmt = db.prepare(
    `SELECT s.*, c.name AS category_name, c.color AS category_color, c.icon AS category_icon, c.requires_slip
     FROM transaction_splits s JOIN categories c ON c.id = s.category_id WHERE s.transaction_id = ? ORDER BY ABS(s.amount) DESC`
  );
  return rows.map((r) => ({ ...r, splits: splitStmt.all(r.id) }));
}

function getTransaction(id: string) {
  const t = db
    .prepare(
      `SELECT t.*, a.name AS account_name, m.name AS merchant_name, ${TX_STATUS_SQL} AS status
       FROM transactions t JOIN accounts a ON a.id = t.account_id LEFT JOIN merchants m ON m.id = t.merchant_id WHERE t.id = ?`
    )
    .get(id) as Record<string, unknown> | undefined;
  if (!t) return null;
  const splits = db
    .prepare(
      `SELECT s.*, c.name AS category_name, c.color AS category_color, c.icon AS category_icon, c.requires_slip
       FROM transaction_splits s JOIN categories c ON c.id = s.category_id WHERE s.transaction_id = ?`
    )
    .all(id);
  const receipts = db.prepare('SELECT id, merchant_name, receipt_date, total, status FROM receipts WHERE transaction_id = ?').all(id);
  return { ...t, splits, receipts };
}

transactionsRouter.get(
  '/',
  h((req, res) => {
    const q = req.query as Record<string, string | undefined>;
    res.json(
      queryTransactions({
        period: q.period,
        from: q.from,
        to: q.to,
        status: q.status,
        category_id: q.category_id,
        account_id: q.account_id,
        q: q.q,
        limit: q.limit ? num(q.limit) : undefined,
        offset: q.offset ? num(q.offset) : undefined,
      })
    );
  })
);

transactionsRouter.get(
  '/:id',
  h((req, res) => {
    const t = getTransaction(String(req.params.id));
    if (!t) notFound('Transaction not found');
    res.json(t);
  })
);

/** Manual entry — cash spend, or a transaction the bank export missed. */
transactionsRouter.post(
  '/',
  h((req, res) => {
    const account_id = str(req.body?.account_id);
    const date = str(req.body?.date);
    const description = str(req.body?.description);
    const amount = round2(num(req.body?.amount, NaN));
    if (!account_id || !date || !description || !Number.isFinite(amount)) {
      throw new Error('Account, date, description and amount are required');
    }
    const id = uuid();
    const t = now();
    db.prepare(
      `INSERT INTO transactions (id, account_id, date, description, amount, fingerprint, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, account_id, date, description, amount, 'manual:' + crypto.randomUUID(), str(req.body?.notes), t, t);
    const category_id = str(req.body?.category_id);
    if (category_id) {
      db.prepare(`INSERT INTO transaction_splits (id, transaction_id, category_id, amount, source) VALUES (?, ?, ?, ?, 'manual')`).run(
        uuid(),
        id,
        category_id,
        amount
      );
    } else {
      autoCategorize([id]);
    }
    publishSensors().catch(() => undefined);
    res.status(201).json(getTransaction(id));
  })
);

transactionsRouter.patch(
  '/:id',
  h((req, res) => {
    const id = String(req.params.id);
    const t = db.prepare('SELECT id FROM transactions WHERE id = ?').get(id);
    if (!t) notFound('Transaction not found');
    if ('notes' in (req.body ?? {})) db.prepare('UPDATE transactions SET notes = ? WHERE id = ?').run(str(req.body.notes), id);
    if ('ignored' in (req.body ?? {})) db.prepare('UPDATE transactions SET ignored = ? WHERE id = ?').run(req.body.ignored ? 1 : 0, id);
    db.prepare('UPDATE transactions SET updated_at = ? WHERE id = ?').run(now(), id);
    publishSensors().catch(() => undefined);
    res.json(getTransaction(id));
  })
);

export function setSingleCategory(id: string, categoryId: string, remember = false) {
  const tx = db.prepare('SELECT id, amount, description, merchant_id FROM transactions WHERE id = ?').get(id) as
    | { id: string; amount: number; description: string; merchant_id: string | null }
    | undefined;
  if (!tx) notFound('Transaction not found');
  const cat = db.prepare('SELECT id FROM categories WHERE id = ?').get(categoryId);
  if (!cat) notFound('Category not found');
  db.transaction(() => {
    db.prepare('DELETE FROM transaction_splits WHERE transaction_id = ?').run(id);
    db.prepare(`INSERT INTO transaction_splits (id, transaction_id, category_id, amount, source) VALUES (?, ?, ?, ?, 'manual')`).run(
      uuid(),
      id,
      categoryId,
      tx.amount
    );
    if (remember) {
      if (tx.merchant_id) {
        db.prepare('UPDATE merchants SET default_category_id = ?, updated_at = ? WHERE id = ?').run(categoryId, now(), tx.merchant_id);
      } else {
        const pattern = suggestMerchantPattern(tx.description);
        if (pattern.length >= 3) {
          const existing = db.prepare('SELECT id FROM merchants WHERE name = ?').get(pattern) as { id: string } | undefined;
          const mid = existing?.id ?? uuid();
          const t = now();
          if (existing) {
            db.prepare('UPDATE merchants SET default_category_id = ?, updated_at = ? WHERE id = ?').run(categoryId, t, mid);
          } else {
            db.prepare(
              'INSERT INTO merchants (id, name, patterns, default_category_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
            ).run(mid, pattern, pattern, categoryId, t, t);
          }
          db.prepare('UPDATE transactions SET merchant_id = ? WHERE id = ?').run(mid, id);
        }
      }
    }
  })();
  const applied = remember ? autoCategorize() : 0;
  publishSensors().catch(() => undefined);
  return applied;
}

/** One-category shortcut. remember=true teaches the merchant so future
 *  transactions with the same description get this category automatically. */
transactionsRouter.put(
  '/:id/category',
  h((req, res) => {
    const id = String(req.params.id);
    const categoryId = str(req.body?.category_id);
    if (!categoryId) throw new Error('category_id is required');
    const applied = setSingleCategory(id, categoryId, Boolean(req.body?.remember));
    res.json({ ...getTransaction(id), also_categorized: applied });
  })
);

/** Replace all splits. Amounts are entered as positive magnitudes in the UI;
 *  they take the transaction's sign here and must add up to its amount. */
transactionsRouter.put(
  '/:id/splits',
  h((req, res) => {
    const id = String(req.params.id);
    const tx = db.prepare('SELECT id, amount FROM transactions WHERE id = ?').get(id) as { id: string; amount: number } | undefined;
    if (!tx) notFound('Transaction not found');
    const sign = tx.amount < 0 ? -1 : 1;
    const splits = (Array.isArray(req.body?.splits) ? req.body.splits : [])
      .map((s: Record<string, unknown>) => ({
        category_id: str(s.category_id),
        amount: round2(Math.abs(num(s.amount))) * sign,
        note: str(s.note),
      }))
      .filter((s: { category_id: string | null; amount: number }) => s.category_id && s.amount !== 0);
    const total = round2(splits.reduce((a: number, s: { amount: number }) => a + s.amount, 0));
    if (splits.length && Math.abs(total - tx.amount) > 0.009) {
      throw new Error(`Splits add up to ${Math.abs(total).toFixed(2)} but the transaction is ${Math.abs(tx.amount).toFixed(2)}`);
    }
    db.transaction(() => {
      db.prepare('DELETE FROM transaction_splits WHERE transaction_id = ?').run(id);
      const ins = db.prepare(
        `INSERT INTO transaction_splits (id, transaction_id, category_id, amount, note, source) VALUES (?, ?, ?, ?, ?, 'manual')`
      );
      for (const s of splits) ins.run(uuid(), id, s.category_id, s.amount, s.note);
    })();
    publishSensors().catch(() => undefined);
    res.json(getTransaction(id));
  })
);

transactionsRouter.delete(
  '/:id',
  h((req, res) => {
    db.prepare('DELETE FROM transactions WHERE id = ?').run(req.params.id);
    publishSensors().catch(() => undefined);
    res.status(204).end();
  })
);
