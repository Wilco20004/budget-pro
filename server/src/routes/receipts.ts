import path from 'path';
import fs from 'fs';
import { Router } from 'express';
import multer from 'multer';
import { v4 as uuid } from 'uuid';
import { db, now, UPLOADS_DIR } from '../db';
import { publishSensors } from '../ha';
import { upsertProduct } from '../services/categorize';
import { addDays } from '../services/periods';
import { applyReceiptSplits, linkReceipt, processReceipt, saveReceiptFile } from '../receipts/service';
import { h, notFound, num, round2, str } from '../util';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

export const receiptsRouter = Router();

receiptsRouter.get(
  '/',
  h((req, res) => {
    const where = req.query.unlinked === '1' ? 'WHERE r.transaction_id IS NULL' : '';
    res.json(
      db
        .prepare(
          `SELECT r.id, r.status, r.error, r.engine, r.merchant_name, r.receipt_date, r.total, r.transaction_id, r.created_at, r.mime_type,
             t.date AS transaction_date, t.description AS transaction_description, t.amount AS transaction_amount,
             (SELECT COUNT(*) FROM receipt_items i WHERE i.receipt_id = r.id) AS item_count
           FROM receipts r LEFT JOIN transactions t ON t.id = r.transaction_id
           ${where}
           ORDER BY COALESCE(r.receipt_date, substr(r.created_at, 1, 10)) DESC, r.created_at DESC LIMIT 300`
        )
        .all()
    );
  })
);

receiptsRouter.post(
  '/',
  upload.array('files', 20),
  h(async (req, res) => {
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (!files.length) throw new Error('No file uploaded');
    const ids: string[] = [];
    for (const f of files) {
      const mime = f.mimetype === 'application/pdf' || f.originalname.toLowerCase().endsWith('.pdf') ? 'application/pdf' : f.mimetype;
      const id = saveReceiptFile(f.buffer, f.originalname, mime);
      const txId = str(req.body?.transaction_id);
      if (txId) db.prepare('UPDATE receipts SET transaction_id = ? WHERE id = ?').run(txId, id);
      ids.push(id);
    }
    // OCR runs in the background; the page polls the receipt's status.
    (async () => {
      for (const id of ids) await processReceipt(id);
      publishSensors().catch(() => undefined);
    })();
    res.status(201).json({ ids });
  })
);

function getReceipt(id: string) {
  const r = db.prepare('SELECT * FROM receipts WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!r) return null;
  const items = db
    .prepare(
      `SELECT i.*, c.name AS category_name, c.color AS category_color, p.category_id AS product_category_id
       FROM receipt_items i LEFT JOIN categories c ON c.id = i.category_id LEFT JOIN products p ON p.id = i.product_id
       WHERE i.receipt_id = ? ORDER BY i.sort_order`
    )
    .all(id);
  const transaction = r.transaction_id
    ? db
        .prepare('SELECT t.id, t.date, t.description, t.amount, a.name AS account_name FROM transactions t JOIN accounts a ON a.id = t.account_id WHERE t.id = ?')
        .get(r.transaction_id)
    : null;
  // Candidates for linking: close in amount and date.
  let candidates: unknown[] = [];
  if (!r.transaction_id) {
    const date = (r.receipt_date as string | null) ?? String(r.created_at).slice(0, 10);
    const total = r.total as number | null;
    candidates = db
      .prepare(
        `SELECT t.id, t.date, t.description, t.amount, a.name AS account_name
         FROM transactions t JOIN accounts a ON a.id = t.account_id
         WHERE t.amount < 0 AND t.date BETWEEN ? AND ?
           AND NOT EXISTS (SELECT 1 FROM receipts x WHERE x.transaction_id = t.id)
         ORDER BY ${total !== null ? 'ABS(ABS(t.amount) - ?)' : 't.date'} LIMIT 15`
      )
      .all(...[addDays(date, -7), addDays(date, 7), ...(total !== null ? [total] : [])]);
  }
  return { ...r, items, transaction, candidates };
}

receiptsRouter.get(
  '/:id',
  h((req, res) => {
    const r = getReceipt(String(req.params.id));
    if (!r) notFound('Receipt not found');
    res.json(r);
  })
);

receiptsRouter.get(
  '/:id/file',
  h((req, res) => {
    const r = db.prepare('SELECT file_path, mime_type FROM receipts WHERE id = ?').get(req.params.id) as
      | { file_path: string; mime_type: string }
      | undefined;
    if (!r) notFound('Receipt not found');
    if (!r.file_path) notFound('This slip was logged without an image');
    const abs = path.join(UPLOADS_DIR, r.file_path);
    if (!fs.existsSync(abs)) notFound('File missing');
    res.type(r.mime_type).sendFile(abs);
  })
);

receiptsRouter.put(
  '/:id',
  h((req, res) => {
    const id = String(req.params.id);
    const b = req.body ?? {};
    const r = db
      .prepare('UPDATE receipts SET merchant_name = ?, merchant_id = ?, receipt_date = ?, total = ?, updated_at = ? WHERE id = ?')
      .run(str(b.merchant_name), str(b.merchant_id), str(b.receipt_date), b.total === null || b.total === '' ? null : round2(num(b.total)), now(), id);
    if (!r.changes) notFound('Receipt not found');
    res.json(getReceipt(id));
  })
);

/** Replace the slip lines. Every line with a category teaches the product
 *  database, so the same product on the next slip is categorised for you. */
receiptsRouter.put(
  '/:id/items',
  h((req, res) => {
    const id = String(req.params.id);
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    db.transaction(() => {
      db.prepare('DELETE FROM receipt_items WHERE receipt_id = ?').run(id);
      const ins = db.prepare(
        `INSERT INTO receipt_items (id, receipt_id, product_id, raw_name, quantity, amount, category_id, sort_order, barcode)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      items.forEach((it: Record<string, unknown>, i: number) => {
        const name = str(it.raw_name);
        if (!name) return;
        const cat = str(it.category_id);
        const barcode = str(it.barcode);
        const productId = upsertProduct(name, cat ?? undefined, barcode && /^\d{8,14}$/.test(barcode) ? barcode : null);
        ins.run(uuid(), id, productId, name, num(it.quantity, 1) || 1, round2(num(it.amount)), cat, i, barcode);
      });
    })();
    const r = db.prepare('SELECT transaction_id FROM receipts WHERE id = ?').get(id) as { transaction_id: string | null } | undefined;
    if (r?.transaction_id && req.body?.apply !== false) applyReceiptSplits(id);
    publishSensors().catch(() => undefined);
    res.json(getReceipt(id));
  })
);

receiptsRouter.post(
  '/:id/rescan',
  h(async (req, res) => {
    const id = String(req.params.id);
    db.prepare('UPDATE receipts SET receipt_date = NULL, total = NULL WHERE id = ?').run(id);
    await processReceipt(id);
    res.json(getReceipt(id));
  })
);

receiptsRouter.post(
  '/:id/link',
  h((req, res) => {
    const id = String(req.params.id);
    const txId = str(req.body?.transaction_id);
    if (!txId) throw new Error('transaction_id is required');
    linkReceipt(id, txId, req.body?.apply !== false);
    publishSensors().catch(() => undefined);
    res.json(getReceipt(id));
  })
);

receiptsRouter.post(
  '/:id/unlink',
  h((req, res) => {
    const id = String(req.params.id);
    db.prepare('UPDATE receipts SET transaction_id = NULL, updated_at = ? WHERE id = ?').run(now(), id);
    publishSensors().catch(() => undefined);
    res.json(getReceipt(id));
  })
);

receiptsRouter.post(
  '/:id/apply',
  h((req, res) => {
    applyReceiptSplits(String(req.params.id));
    res.json(getReceipt(String(req.params.id)));
  })
);

receiptsRouter.delete(
  '/:id',
  h((req, res) => {
    const r = db.prepare('SELECT file_path FROM receipts WHERE id = ?').get(req.params.id) as { file_path: string } | undefined;
    if (r) {
      // Slips logged over MCP have no file — never rm the uploads dir itself.
      if (r.file_path) fs.rm(path.join(UPLOADS_DIR, r.file_path), { force: true }, () => undefined);
      db.prepare('DELETE FROM receipts WHERE id = ?').run(req.params.id);
    }
    res.status(204).end();
  })
);

// ---- Product database ----------------------------------------------------------

export const productsRouter = Router();

export function queryProducts(opts: { q?: string; category_id?: string; limit?: number }) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.q) {
    where.push('p.name_key LIKE ?');
    params.push(`%${opts.q.toUpperCase()}%`);
  }
  if (opts.category_id) {
    where.push('p.category_id = ?');
    params.push(opts.category_id);
  }
  params.push(Math.min(opts.limit ?? 500, 5000));
  return db
    .prepare(
      `SELECT p.id, p.name, p.barcode, p.category_id, c.name AS category_name,
         COUNT(i.id) AS times_bought,
         ROUND(SUM(i.amount), 2) AS total_spent,
         ROUND(AVG(i.amount / i.quantity), 2) AS avg_unit_price,
         MAX(COALESCE(r.receipt_date, substr(r.created_at, 1, 10))) AS last_bought,
         (SELECT ROUND(i2.amount / i2.quantity, 2) FROM receipt_items i2 JOIN receipts r2 ON r2.id = i2.receipt_id
            WHERE i2.product_id = p.id ORDER BY COALESCE(r2.receipt_date, r2.created_at) DESC LIMIT 1) AS last_unit_price
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       LEFT JOIN receipt_items i ON i.product_id = p.id
       LEFT JOIN receipts r ON r.id = i.receipt_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       GROUP BY p.id
       ORDER BY times_bought DESC, p.name
       LIMIT ?`
    )
    .all(...params);
}

/** Price history of one product across slips — what the AI trend tools use. */
export function productHistory(productId: string) {
  return db
    .prepare(
      `SELECT COALESCE(r.receipt_date, substr(r.created_at, 1, 10)) AS date, r.merchant_name, i.raw_name, i.quantity, i.amount,
              ROUND(i.amount / i.quantity, 2) AS unit_price
       FROM receipt_items i JOIN receipts r ON r.id = i.receipt_id WHERE i.product_id = ? ORDER BY date`
    )
    .all(productId);
}

productsRouter.get(
  '/',
  h((req, res) =>
    res.json(
      queryProducts({
        q: typeof req.query.q === 'string' ? req.query.q : undefined,
        category_id: typeof req.query.category_id === 'string' ? req.query.category_id : undefined,
      })
    )
  )
);

productsRouter.get(
  '/:id/history',
  h((req, res) => res.json(productHistory(String(req.params.id))))
);

/** Changing a product's category also re-categorises its lines on slips
 *  that aren't linked yet (linked ones keep what was applied). */
productsRouter.put(
  '/:id',
  h((req, res) => {
    const id = String(req.params.id);
    const cat = str(req.body?.category_id);
    const name = str(req.body?.name);
    db.transaction(() => {
      db.prepare('UPDATE products SET category_id = ?, name = COALESCE(?, name), updated_at = ? WHERE id = ?').run(cat, name, now(), id);
      db.prepare(
        `UPDATE receipt_items SET category_id = ? WHERE product_id = ?
           AND receipt_id IN (SELECT id FROM receipts WHERE transaction_id IS NULL)`
      ).run(cat, id);
    })();
    res.json({ ok: true });
  })
);
