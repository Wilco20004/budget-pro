import { v4 as uuid } from 'uuid';
import { db } from '../db';

export interface MerchantRow {
  id: string;
  name: string;
  patterns: string;
  default_category_id: string | null;
}

export function splitPatterns(patterns: string): string[] {
  return patterns
    .split('|')
    .map((p) => p.toUpperCase())
    .filter((p) => p.trim().length > 0);
}

/** Longest matching pattern wins, so "UBER EATS" beats a generic "UBER". */
export function matchMerchant(text: string, merchants?: MerchantRow[]): MerchantRow | null {
  const list = merchants ?? (db.prepare('SELECT * FROM merchants').all() as MerchantRow[]);
  const hay = ` ${text.toUpperCase().replace(/\s+/g, ' ')} `;
  let best: MerchantRow | null = null;
  let bestLen = 0;
  for (const m of list) {
    for (const p of splitPatterns(m.patterns)) {
      if (p.length > bestLen && hay.includes(p)) {
        best = m;
        bestLen = p.length;
      }
    }
  }
  return best;
}

/** Strips the noise banks wrap around a merchant name — card numbers,
 *  reference numbers, "POS PURCHASE" prefixes — to suggest a pattern when
 *  the user teaches a new merchant from a transaction. */
export function suggestMerchantPattern(description: string): string {
  return description
    .toUpperCase()
    .replace(/\b(POS|PURCHASE|CARD|DEBIT ORDER|FNB APP|PAYMENT|TO|FROM|ONLINE|INT|CR|DR)\b/g, ' ')
    .replace(/[*#]\S*/g, ' ')
    .replace(/\b\d[\d/.:-]*\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .slice(0, 3)
    .join(' ');
}

/** Applies merchant rules to transactions that have no splits yet.
 *  Returns how many were categorised. */
export function autoCategorize(transactionIds?: string[]): number {
  const merchants = db.prepare('SELECT * FROM merchants').all() as MerchantRow[];
  const rows = (
    transactionIds
      ? transactionIds.map((id) => db.prepare('SELECT id, description, amount FROM transactions WHERE id = ?').get(id))
      : db
          .prepare(
            `SELECT id, description, amount FROM transactions t
             WHERE NOT EXISTS (SELECT 1 FROM transaction_splits s WHERE s.transaction_id = t.id)`
          )
          .all()
  ).filter(Boolean) as { id: string; description: string; amount: number }[];

  const hasSplits = db.prepare('SELECT 1 FROM transaction_splits WHERE transaction_id = ? LIMIT 1');
  const setMerchant = db.prepare('UPDATE transactions SET merchant_id = ? WHERE id = ?');
  const insertSplit = db.prepare(
    `INSERT INTO transaction_splits (id, transaction_id, category_id, amount, source) VALUES (?, ?, ?, ?, 'rule')`
  );
  let count = 0;
  const run = db.transaction(() => {
    for (const tx of rows) {
      const m = matchMerchant(tx.description, merchants);
      if (!m) continue;
      setMerchant.run(m.id, tx.id);
      if (m.default_category_id && !hasSplits.get(tx.id)) {
        insertSplit.run(uuid(), tx.id, m.default_category_id, tx.amount);
        count++;
      }
    }
  });
  run();
  return count;
}

/** Status of one transaction, derived rather than stored so it can't drift:
 *   ignored        — user excluded it
 *   uncategorized  — no splits, or splits don't add up to the amount
 *   needs_slip     — a split is in a requires_slip category, no receipt is linked
 *                    and the slip wasn't waived (no_slip_reason)
 *   reconciled     — done */
export const TX_STATUS_SQL = `
  CASE
    WHEN t.ignored = 1 THEN 'ignored'
    WHEN NOT EXISTS (SELECT 1 FROM transaction_splits s WHERE s.transaction_id = t.id) THEN 'uncategorized'
    WHEN ABS((SELECT SUM(s.amount) FROM transaction_splits s WHERE s.transaction_id = t.id) - t.amount) > 0.009 THEN 'uncategorized'
    WHEN EXISTS (
      SELECT 1 FROM transaction_splits s JOIN categories c ON c.id = s.category_id
      WHERE s.transaction_id = t.id AND c.requires_slip = 1
    ) AND t.no_slip_reason IS NULL
      AND NOT EXISTS (SELECT 1 FROM receipts r WHERE r.transaction_id = t.id) THEN 'needs_slip'
    ELSE 'reconciled'
  END`;

export function normalizeProductName(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

interface KeywordRow {
  keyword: string;
  category_id: string;
}

type ProductRow = { id: string; category_id: string | null };

/** Barcode first (exact, survives OCR mangling the name), then name. */
function findProduct(rawName: string, barcode?: string | null): ProductRow | undefined {
  if (barcode) {
    const byCode = db.prepare('SELECT id, category_id FROM products WHERE barcode = ?').get(barcode) as ProductRow | undefined;
    if (byCode) return byCode;
  }
  return db.prepare('SELECT id, category_id FROM products WHERE name_key = ?').get(normalizeProductName(rawName)) as
    | ProductRow
    | undefined;
}

/** Category for one slip line: learned product → keyword → merchant default. */
export function categoryForItem(
  rawName: string,
  merchantDefault: string | null,
  keywords?: KeywordRow[],
  barcode?: string | null
): { category_id: string | null; product_id: string | null } {
  const key = normalizeProductName(rawName);
  const product = findProduct(rawName, barcode);
  if (product?.category_id) return { category_id: product.category_id, product_id: product.id };
  const kws = keywords ?? (db.prepare('SELECT keyword, category_id FROM category_keywords').all() as KeywordRow[]);
  const hay = ` ${key} `;
  let best: KeywordRow | null = null;
  for (const k of kws) {
    const kw = k.keyword.toUpperCase();
    if (hay.includes(kw) && (!best || kw.length > best.keyword.length)) best = k;
  }
  return { category_id: best?.category_id ?? merchantDefault, product_id: product?.id ?? null };
}

/** Finds or creates the product row for a slip line and (optionally)
 *  teaches it a category. */
export function upsertProduct(rawName: string, categoryId?: string | null, barcode?: string | null): string {
  const key = normalizeProductName(rawName);
  const t = new Date().toISOString();
  const existing = findProduct(rawName, barcode);
  if (existing) {
    if (categoryId !== undefined) {
      db.prepare('UPDATE products SET category_id = ?, updated_at = ? WHERE id = ?').run(categoryId, t, existing.id);
    }
    if (barcode) db.prepare('UPDATE products SET barcode = COALESCE(barcode, ?) WHERE id = ?').run(barcode, existing.id);
    return existing.id;
  }
  const id = uuid();
  // name_key is unique; a barcode-identified product whose (OCR'd) name
  // collides with another product's gets the barcode appended.
  const nameTaken = db.prepare('SELECT 1 FROM products WHERE name_key = ?').get(key);
  db.prepare(
    'INSERT INTO products (id, name_key, name, category_id, barcode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, nameTaken && barcode ? `${key} ${barcode}` : key, rawName.trim(), categoryId ?? null, barcode ?? null, t, t);
  return id;
}
