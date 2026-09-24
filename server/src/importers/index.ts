import crypto from 'crypto';
import { v4 as uuid } from 'uuid';
import { db, now } from '../db';
import { replaceProvisional } from '../notifications/service';
import { matchUnlinkedReceipts } from '../receipts/service';
import { autoCategorize } from '../services/categorize';
import { addDays } from '../services/periods';
import { parseStatement, ParsedRow } from './parse';

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
  /** Of duplicate_count: rows recognised as a transaction already imported
   *  from a differently worded export (not an exact re-import). */
  matched_existing: number;
  /** Per account, for files covering several. */
  accounts: { name: string; new_count: number; duplicate_count: number }[];
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

// How far apart the same transaction's date can be in two different exports
// of it: a monthly statement uses the transaction date, the history export
// the posting date, a few days later.
const OVERLAP_DAYS = 4;

function daysBetween(a: string, b: string): number {
  return Math.abs(Date.parse(a) - Date.parse(b)) / 86400000;
}

interface SectionResult {
  newIds: string[];
  exact: number;
  overlap: number;
}

/** Imports one account's rows. A row is skipped when it's already there:
 *  exactly (same fingerprint — a re-import of the same file/format), or as
 *  the same transaction from a differently worded export (same account and
 *  amount within a few days, paired off in date order). The
 *  existing, already-categorised copy is always the one kept. */
function importSection(account: AccountRow, rows: ParsedRow[], importId: string, format: string): SectionResult {
  const t = now();
  const insert = db.prepare(
    `INSERT INTO transactions (id, account_id, import_id, date, description, amount, balance, fingerprint, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const byFingerprint = db.prepare('SELECT id FROM transactions WHERE fingerprint = ?');

  const seen = new Map<string, number>();
  const prepared = rows.map((r) => {
    const amount = account.flip_sign ? -r.amount : r.amount;
    const key = `${r.date}|${amount}|${r.description}`;
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    return { r, amount, fp: fingerprint(account.id, r.date, amount, r.description, n, r.externalId) };
  });

  const claimed = new Set<string>();
  const dates = rows.map((r) => r.date).sort();
  const existing = db
    // Only rows from a *different* kind of export are overlap candidates:
    // consecutive monthly statements can legitimately both hold an R10 tip
    // a few days apart, and same-format re-imports are caught exactly (pass 1).
    .prepare(
      `SELECT t.id, t.date, t.amount FROM transactions t JOIN imports i ON i.id = t.import_id
       WHERE t.account_id = ? AND t.provisional = 0 AND i.format != ? AND t.date BETWEEN ? AND ?`
    )
    .all(account.id, format, addDays(dates[0], -OVERLAP_DAYS - 1), addDays(dates[dates.length - 1], OVERLAP_DAYS + 1)) as {
    id: string;
    date: string;
    amount: number;
  }[];

  // Pass 1: exact re-imports claim their existing row first.
  const pending: typeof prepared = [];
  let exact = 0;
  for (const p of prepared) {
    const hit = byFingerprint.get(p.fp) as { id: string } | undefined;
    if (hit) {
      claimed.add(hit.id);
      exact++;
    } else pending.push(p);
  }

  // Pass 2: cross-format overlap. Per amount, walk both lists in date order
  // and pair them off in sequence — two exports of one account list the same
  // transactions in the same order, just with shifted dates. (Taking the
  // nearest free match instead mis-pairs repeats: two R11 parking charges
  // days apart let the first grab the second's twin and orphan the other.)
  const cents = (n: number) => Math.round(n * 100);
  const existingByAmount = new Map<number, typeof existing>();
  for (const e of existing) {
    if (claimed.has(e.id)) continue;
    const k = cents(e.amount);
    existingByAmount.set(k, [...(existingByAmount.get(k) ?? []), e]);
  }
  const pendingByAmount = new Map<number, typeof pending>();
  for (const p of pending) {
    const k = cents(p.amount);
    pendingByAmount.set(k, [...(pendingByAmount.get(k) ?? []), p]);
  }
  const toInsert: typeof pending = [];
  let overlap = 0;
  for (const [k, news] of pendingByAmount) {
    const olds = (existingByAmount.get(k) ?? []).sort((a, b) => a.date.localeCompare(b.date));
    news.sort((a, b) => a.r.date.localeCompare(b.r.date));
    let j = 0;
    for (const p of news) {
      // Existing rows too early to be this one are before the file's range
      // (or genuinely absent from it) — skip past them.
      while (j < olds.length && Date.parse(olds[j].date) < Date.parse(p.r.date) - OVERLAP_DAYS * 86400000) j++;
      if (j < olds.length && daysBetween(olds[j].date, p.r.date) <= OVERLAP_DAYS) {
        claimed.add(olds[j].id);
        j++;
        overlap++;
      } else {
        toInsert.push(p);
      }
    }
  }

  const newIds: string[] = [];
  for (const p of toInsert) {
    const id = uuid();
    insert.run(id, account.id, importId, p.r.date, p.r.description, p.amount, p.r.balance, p.fp, t, t);
    newIds.push(id);
  }
  return { newIds, exact, overlap };
}

export async function importStatement(
  accountId: string | null,
  filename: string,
  buf: Buffer,
  source: 'upload' | 'inbox' | 'api' | 'email' | 'whatsapp' = 'upload'
): Promise<ImportResult> {
  const parsed = await parseStatement(filename, buf);
  if (parsed.rows.length === 0) {
    throw new Error('No transactions found in that file. ' + parsed.warnings.join(' '));
  }
  const warnings = [...parsed.warnings];
  const getAccount = db.prepare('SELECT id, name, match_hint, flip_sign FROM accounts WHERE id = ?');

  // One file can hold several accounts (Discovery's transaction history);
  // each section goes to its own account, and sections for accounts not set
  // up in BudgetPro are skipped — the same "only what you track" rule as
  // for phone notifications.
  const sections: { account: AccountRow & { name: string }; rows: ParsedRow[] }[] = [];
  if (parsed.rows.some((r) => r.accountHint)) {
    for (const hint of parsed.accountHints) {
      const rows = parsed.rows.filter((r) => r.accountHint === hint);
      if (!rows.length) continue;
      const label = `${parsed.sectionNames?.[hint] ?? 'Account'} …${hint.slice(-4)}`;
      const id = accountForHints([hint]);
      if (!id) {
        warnings.push(`${label} isn't set up in BudgetPro — its ${rows.length} transactions were skipped. Add it under Setup → Accounts (with its account number as the match hint) and import again to include it.`);
        continue;
      }
      if (accountId && id !== accountId) {
        warnings.push(`${label}: skipped because you chose a different account for this import.`);
        continue;
      }
      sections.push({ account: getAccount.get(id) as AccountRow & { name: string }, rows });
    }
    if (!sections.length) throw new Error('None of the accounts in this file are set up in BudgetPro. ' + warnings.join(' '));
  } else {
    const resolved = accountId || accountForHints(parsed.accountHints);
    if (!resolved) {
      throw new Error(
        parsed.accountHints.length
          ? `No account matches account number ${parsed.accountHints.join(', ')} — set it as an account's "match hint" or pick the account when importing.`
          : 'Pick which account this statement belongs to.'
      );
    }
    const account = getAccount.get(resolved) as (AccountRow & { name: string }) | undefined;
    if (!account) throw new Error('Account not found');
    sections.push({ account, rows: parsed.rows });
  }

  const t = now();
  const newIds: string[] = [];
  let exact = 0;
  let overlap = 0;
  let firstImportId = '';
  const perAccount: ImportResult['accounts'] = [];
  db.transaction(() => {
    for (const s of sections) {
      const importId = uuid();
      firstImportId ||= importId;
      db.prepare(`INSERT INTO imports (id, account_id, filename, format, source, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(
        importId,
        s.account.id,
        filename,
        parsed.format,
        source,
        t
      );
      const r = importSection(s.account, s.rows, importId, parsed.format);
      db.prepare('UPDATE imports SET row_count = ?, new_count = ?, duplicate_count = ? WHERE id = ?').run(
        s.rows.length,
        r.newIds.length,
        r.exact + r.overlap,
        importId
      );
      newIds.push(...r.newIds);
      exact += r.exact;
      overlap += r.overlap;
      perAccount.push({ name: s.account.name, new_count: r.newIds.length, duplicate_count: r.exact + r.overlap });
    }
  })();

  // Statement lines take over the provisional ones made from phone
  // notifications (keeping their categories/slips) before rules run.
  const provisionalReplaced = replaceProvisional(newIds);
  const auto = autoCategorize(newIds);
  const receiptsLinked = newIds.length ? matchUnlinkedReceipts() : 0;
  const rowCount = sections.reduce((a, s) => a + s.rows.length, 0);
  return {
    receipts_linked: receiptsLinked,
    provisional_replaced: provisionalReplaced,
    import_id: firstImportId,
    account_id: sections[0].account.id,
    format: parsed.format,
    row_count: rowCount,
    new_count: newIds.length,
    duplicate_count: exact + overlap,
    matched_existing: overlap,
    accounts: perAccount,
    auto_categorized: auto,
    warnings,
  };
}
