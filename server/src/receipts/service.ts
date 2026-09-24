import fs from 'fs';
import path from 'path';
import { v4 as uuid } from 'uuid';
import { db, now, UPLOADS_DIR } from '../db';
import { categoryForItem, matchMerchant, MerchantRow, upsertProduct } from '../services/categorize';
import { addDays } from '../services/periods';
import { getSettings } from '../settings';
import { claudeAvailable, claudeExtract, parseReceiptText, pdfText, tesseractText } from './engines';
import { ExtractedReceipt } from './parseText';

export interface ReceiptRow {
  id: string;
  file_path: string;
  mime_type: string;
  status: string;
  merchant_id: string | null;
  merchant_name: string | null;
  receipt_date: string | null;
  total: number | null;
  transaction_id: string | null;
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

export function saveReceiptFile(buf: Buffer, originalName: string, mimeType: string): string {
  const id = uuid();
  const ext = path.extname(originalName) || (mimeType === 'application/pdf' ? '.pdf' : '.jpg');
  const rel = `receipts/${id}${ext.toLowerCase()}`;
  fs.mkdirSync(path.join(UPLOADS_DIR, 'receipts'), { recursive: true });
  fs.writeFileSync(path.join(UPLOADS_DIR, rel), buf);
  const t = now();
  db.prepare(
    `INSERT INTO receipts (id, file_path, mime_type, original_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)`
  ).run(id, rel, mimeType, originalName, t, t);
  return id;
}

async function extract(r: ReceiptRow): Promise<{ engine: string; text: string | null; data: ExtractedReceipt }> {
  const abs = path.join(UPLOADS_DIR, r.file_path);
  const buf = fs.readFileSync(abs);
  const setting = getSettings().ocr_engine;
  const useClaude = setting === 'claude' || (setting === 'auto' && claudeAvailable());
  if (useClaude) {
    const names = (db.prepare('SELECT name FROM categories WHERE archived = 0 AND kind = ?').all('expense') as { name: string }[]).map(
      (c) => c.name
    );
    return { engine: 'claude', text: null, data: await claudeExtract(buf, r.mime_type, names) };
  }
  const text = r.mime_type === 'application/pdf' ? await pdfText(buf) : await tesseractText(abs);
  return { engine: r.mime_type === 'application/pdf' ? 'pdf-text' : 'tesseract', text, data: parseReceiptText(text) };
}

/** OCR / extract a slip, store its lines with categories, and try to link it
 *  to the matching bank transaction. Safe to re-run ("Re-scan"). */
export async function processReceipt(id: string): Promise<void> {
  const r = db.prepare('SELECT * FROM receipts WHERE id = ?').get(id) as ReceiptRow | undefined;
  if (!r) return;
  db.prepare("UPDATE receipts SET status = 'processing', error = NULL, updated_at = ? WHERE id = ?").run(now(), id);
  try {
    const { engine, text, data } = await extract(r);
    const merchants = db.prepare('SELECT * FROM merchants').all() as MerchantRow[];
    const merchant = matchMerchant([data.merchant ?? '', text ?? ''].join(' '), merchants);
    const categoriesByName = new Map(
      (db.prepare('SELECT id, name FROM categories').all() as { id: string; name: string }[]).map((c) => [
        c.name.toLowerCase(),
        c.id,
      ])
    );

    db.transaction(() => {
      db.prepare('DELETE FROM receipt_items WHERE receipt_id = ?').run(id);
      const insert = db.prepare(
        `INSERT INTO receipt_items (id, receipt_id, product_id, raw_name, quantity, amount, category_id, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );
      data.items.forEach((it, i) => {
        // A category the user taught for this exact product always wins over
        // the model's guess — that's the whole point of the product database.
        const learned = categoryForItem(it.name, merchant?.default_category_id ?? null);
        const suggested = it.suggested_category ? categoriesByName.get(it.suggested_category.toLowerCase()) : undefined;
        const taught = learned.product_id
          ? (db.prepare('SELECT category_id FROM products WHERE id = ?').get(learned.product_id) as { category_id: string | null })
          : undefined;
        const categoryId = (taught?.category_id ? learned.category_id : suggested ?? learned.category_id) ?? null;
        const productId = upsertProduct(it.name);
        insert.run(uuid(), id, productId, it.name, it.quantity || 1, round2(it.amount), categoryId, i);
      });
      db.prepare(
        `UPDATE receipts SET status = 'parsed', engine = ?, ocr_text = ?, merchant_id = ?, merchant_name = ?,
           receipt_date = COALESCE(receipt_date, ?), total = COALESCE(total, ?), updated_at = ? WHERE id = ?`
      ).run(engine, text, merchant?.id ?? null, merchant?.name ?? data.merchant, data.date, data.total, now(), id);
    })();

    if (r.transaction_id) {
      // Attached straight from a transaction — split it by the slip lines.
      applyReceiptSplits(id);
    } else {
      const txId = findMatchingTransaction(id);
      if (txId) linkReceipt(id, txId, true);
    }
  } catch (e) {
    db.prepare("UPDATE receipts SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").run(
      (e as Error).message,
      now(),
      id
    );
  }
}

/** A debit of exactly the slip total within 4 days of the slip date (card
 *  transactions often post a day or three later), not already claimed by
 *  another slip. Only returns a match when it's unambiguous. */
export function findMatchingTransaction(receiptId: string): string | null {
  const r = db.prepare('SELECT * FROM receipts WHERE id = ?').get(receiptId) as ReceiptRow | undefined;
  if (!r || r.total === null) return null;
  const params: unknown[] = [-Math.abs(r.total)];
  let dateClause = '';
  if (r.receipt_date) {
    dateClause = 'AND t.date BETWEEN ? AND ?';
    params.push(addDays(r.receipt_date, -1), addDays(r.receipt_date, 4));
  }
  const rows = db
    .prepare(
      `SELECT t.id FROM transactions t
       WHERE ABS(t.amount - ?) < 0.005 ${dateClause}
         AND NOT EXISTS (SELECT 1 FROM receipts r WHERE r.transaction_id = t.id)
       ORDER BY t.date`
    )
    .all(...params) as { id: string }[];
  return rows.length === 1 ? rows[0].id : null;
}

/** After a statement import: slips photographed before the bank export
 *  existed get linked now. Returns how many were linked. */
export function matchUnlinkedReceipts(): number {
  const ids = db
    .prepare("SELECT id FROM receipts WHERE transaction_id IS NULL AND status = 'parsed' AND total IS NOT NULL")
    .all() as { id: string }[];
  let n = 0;
  for (const { id } of ids) {
    const txId = findMatchingTransaction(id);
    if (txId) {
      linkReceipt(id, txId, true);
      n++;
    }
  }
  return n;
}

/** Links a slip to a transaction and (by default) replaces the transaction's
 *  splits with one split per category from the slip lines. Anything the
 *  lines don't account for (rounding, bag levy, OCR misses) goes to the
 *  merchant's default category, so the splits always sum to the amount. */
export function linkReceipt(receiptId: string, transactionId: string, applySplits = true) {
  const tx = db.prepare('SELECT id, amount, merchant_id FROM transactions WHERE id = ?').get(transactionId) as
    | { id: string; amount: number; merchant_id: string | null }
    | undefined;
  if (!tx) throw new Error('Transaction not found');
  db.prepare('UPDATE receipts SET transaction_id = NULL WHERE transaction_id = ? AND id != ?').run(transactionId, receiptId);
  db.prepare('UPDATE receipts SET transaction_id = ?, updated_at = ? WHERE id = ?').run(transactionId, now(), receiptId);
  if (applySplits) applyReceiptSplits(receiptId);
}

export function applyReceiptSplits(receiptId: string) {
  const r = db.prepare('SELECT * FROM receipts WHERE id = ?').get(receiptId) as ReceiptRow | undefined;
  if (!r?.transaction_id) throw new Error('Receipt is not linked to a transaction');
  const tx = db.prepare('SELECT id, amount FROM transactions WHERE id = ?').get(r.transaction_id) as {
    id: string;
    amount: number;
  };
  const items = db.prepare('SELECT amount, category_id FROM receipt_items WHERE receipt_id = ?').all(receiptId) as {
    amount: number;
    category_id: string | null;
  }[];

  const merchantDefault = r.merchant_id
    ? ((db.prepare('SELECT default_category_id FROM merchants WHERE id = ?').get(r.merchant_id) as
        | { default_category_id: string | null }
        | undefined)?.default_category_id ?? null)
    : null;
  const existing = db.prepare('SELECT category_id FROM transaction_splits WHERE transaction_id = ? LIMIT 1').get(tx.id) as
    | { category_id: string }
    | undefined;
  const fallback = merchantDefault ?? existing?.category_id ?? null;

  const sign = tx.amount < 0 ? -1 : 1;
  const byCat = new Map<string, number>();
  for (const it of items) {
    const cat = it.category_id ?? fallback;
    // Lines with no category at all fall into the remainder below.
    if (cat) byCat.set(cat, (byCat.get(cat) ?? 0) + it.amount);
  }
  const total = Math.abs(tx.amount);
  const assigned = [...byCat.values()].reduce((a, b) => a + b, 0);
  const remainder = round2(total - assigned);
  if (Math.abs(remainder) >= 0.01) {
    const target = fallback ?? [...byCat.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (!target) return; // nothing categorised at all — leave the transaction alone
    byCat.set(target, (byCat.get(target) ?? 0) + remainder);
  }

  db.transaction(() => {
    db.prepare('DELETE FROM transaction_splits WHERE transaction_id = ?').run(tx.id);
    const ins = db.prepare(
      `INSERT INTO transaction_splits (id, transaction_id, category_id, amount, source) VALUES (?, ?, ?, ?, 'receipt')`
    );
    for (const [cat, amt] of byCat) {
      if (Math.abs(amt) < 0.005) continue;
      ins.run(uuid(), tx.id, cat, round2(sign * amt));
    }
  })();
}
