import crypto from 'crypto';
import { v4 as uuid } from 'uuid';
import { db, now } from '../db';
import { replaceProvisional } from '../notifications/service';
import { matchUnlinkedReceipts } from '../receipts/service';
import { autoCategorize } from '../services/categorize';
import { parseStatement } from './parse';

export interface ImportResult {
  import_id: string;
  account_id: string;
  format: string;
  row_count: number;
  new_count: number;
  duplicate_count: number;
  auto_categorized: number;
  receipts_linked: number;
  provisional_replaced: number;
  warnings: string[];
}

interface AccountRow {
  id: string;
  match_hint: string | null;
  flip_sign: number;
}

function fingerprint(accountId: string, date: string, amount: number, description: string, n: number, ext?: string) {
  const basis = ext
    ? `${accountId}|ext|${ext}`
    : `${accountId}|${date}|${amount.toFixed(2)}|${description.toUpperCase().replace(/[^A-Z0-9]/g, '')}|${n}`;
  return crypto.createHash('sha1').update(basis).digest('hex');
}

/** Picks the account whose match_hint appears in (or ends) an account
 *  number found in the file. */
export function accountForHints(hints: string[]): string | null {
  const accounts = db.prepare('SELECT id, match_hint, flip_sign FROM accounts').all() as AccountRow[];
  for (const a of accounts) {
    const h = (a.match_hint ?? '').replace(/\D/g, '');
    // hint "8901" matches file number "12345678901"; the reverse (a short
    // number found in the file matching inside a full hint) needs 6+ digits
    // so a stray "…5555" can't claim the wrong account.
    if (h.length >= 4 && hints.some((x) => x.endsWith(h) || x === h || (x.length >= 6 && h.endsWith(x)))) return a.id;
  }
  return null;
}

export async function importStatement(
  accountId: string | null,
  filename: string,
  buf: Buffer,
  source: 'upload' | 'inbox' | 'api' = 'upload'
): Promise<ImportResult> {
  const parsed = await parseStatement(filename, buf);
  const resolved = accountId || accountForHints(parsed.accountHints);
  if (!resolved) {
    throw new Error(
      parsed.accountHints.length
        ? `No account matches account number ${parsed.accountHints.join(', ')} — set it as an account's "match hint" or pick the account when importing.`
        : 'Pick which account this statement belongs to.'
    );
  }
  const account = db.prepare('SELECT id, match_hint, flip_sign FROM accounts WHERE id = ?').get(resolved) as
    | AccountRow
    | undefined;
  if (!account) throw new Error('Account not found');
  if (parsed.rows.length === 0) {
    throw new Error('No transactions found in that file. ' + parsed.warnings.join(' '));
  }

  const importId = uuid();
  const t = now();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO transactions (id, account_id, import_id, date, description, amount, balance, fingerprint, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const newIds: string[] = [];
  const seen = new Map<string, number>();

  db.transaction(() => {
    db.prepare(
      `INSERT INTO imports (id, account_id, filename, format, source, created_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(importId, account.id, filename, parsed.format, source, t);
    for (const r of parsed.rows) {
      const amount = account.flip_sign ? -r.amount : r.amount;
      const key = `${r.date}|${amount}|${r.description}`;
      const n = (seen.get(key) ?? 0) + 1;
      seen.set(key, n);
      const id = uuid();
      const res = insert.run(
        id,
        account.id,
        importId,
        r.date,
        r.description,
        amount,
        r.balance,
        fingerprint(account.id, r.date, amount, r.description, n, r.externalId),
        t,
        t
      );
      if (res.changes > 0) newIds.push(id);
    }
    db.prepare('UPDATE imports SET row_count = ?, new_count = ?, duplicate_count = ? WHERE id = ?').run(
      parsed.rows.length,
      newIds.length,
      parsed.rows.length - newIds.length,
      importId
    );
  })();

  // Statement lines take over the provisional ones made from phone
  // notifications (keeping their categories/slips) before rules run.
  const provisionalReplaced = replaceProvisional(newIds);
  const auto = autoCategorize(newIds);
  const receiptsLinked = newIds.length ? matchUnlinkedReceipts() : 0;
  return {
    receipts_linked: receiptsLinked,
    provisional_replaced: provisionalReplaced,
    import_id: importId,
    account_id: account.id,
    format: parsed.format,
    row_count: parsed.rows.length,
    new_count: newIds.length,
    duplicate_count: parsed.rows.length - newIds.length,
    auto_categorized: auto,
    warnings: parsed.warnings,
  };
}
