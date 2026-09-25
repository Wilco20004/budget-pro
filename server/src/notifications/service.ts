import { v4 as uuid } from 'uuid';
import { db, now } from '../db';
import { autoCategorize } from '../services/categorize';
import { addDays } from '../services/periods';
import { hintNumbers } from '../importers';
import { looksLikeDiscovery, parseDiscoveryNotification } from './discovery';
import { looksLikeFnbAlert, parseFnbAlert } from './fnb';

export interface IncomingNotification {
  package?: string | null;
  title?: string | null;
  text?: string | null;
  /** Android's expanded text (android.bigText) — preferred when present. */
  big_text?: string | null;
  /** Phone's post time: epoch ms or ISO string. */
  posted_at?: string | number | null;
}

export interface NotificationResult {
  status: 'imported' | 'ignored' | 'duplicate' | 'unparsed' | 'not_bank';
  reason: string | null;
  transaction_ids: string[];
}

interface AccountRow {
  id: string;
  name: string;
  match_hint: string | null;
}

/** The account a "***8901" belongs to — only accounts set up in BudgetPro.
 *  Anything else (e.g. a business account) is deliberately not tracked. */
function accountForLast4(last4: string | null): AccountRow | null {
  if (!last4) return null;
  const accounts = db.prepare('SELECT id, name, match_hint FROM accounts').all() as AccountRow[];
  return accounts.find((a) => hintNumbers(a.match_hint).some((h) => h.endsWith(last4))) ?? null;
}

function parsePostedAt(v: IncomingNotification['posted_at']): Date | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  const n = typeof v === 'number' ? v : /^\d+$/.test(String(v)) ? Number(v) : NaN;
  const d = Number.isFinite(n) ? new Date(n) : new Date(String(v));
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function log(n: IncomingNotification, keepText: boolean, status: NotificationResult['status'], reason: string | null, txId: string | null) {
  db.prepare(
    `INSERT INTO notifications (id, received_at, package, title, text, status, reason, transaction_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(uuid(), now(), n.package ?? null, keepText ? n.title ?? null : null, keepText ? n.big_text || n.text || null : null, status, reason, txId);
}

function createProvisional(
  accountId: string,
  date: string,
  time: string | null,
  amount: number,
  description: string,
  source = 'phone notification'
): string | null {
  const fingerprint = `notif:${accountId}|${date}|${time ?? ''}|${amount.toFixed(2)}|${description.toUpperCase().replace(/[^A-Z0-9]/g, '')}`;
  const id = uuid();
  const t = now();
  const r = db
    .prepare(
      `INSERT OR IGNORE INTO transactions (id, account_id, date, description, amount, fingerprint, provisional, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
    )
    .run(id, accountId, date, description, amount, fingerprint, time ? `From ${source} at ${time}` : `From ${source}`, t, t);
  return r.changes ? id : null;
}

/** Already on an imported statement (a notification that arrived late, or
 *  was re-sent after the statement was imported)? */
function onStatement(accountId: string, date: string, amount: number): boolean {
  return Boolean(
    db
      .prepare('SELECT 1 FROM transactions WHERE account_id = ? AND provisional = 0 AND date = ? AND ABS(amount - ?) < 0.005 LIMIT 1')
      .get(accountId, date, amount)
  );
}

/** On an imported statement already? FNB statements date a card purchase
 *  when it's posted, a day or few after the alert. */
function onStatementWithin(accountId: string, date: string, amount: number, days: number): boolean {
  return Boolean(
    db
      .prepare('SELECT 1 FROM transactions WHERE account_id = ? AND provisional = 0 AND date BETWEEN ? AND ? AND ABS(amount - ?) < 0.005 LIMIT 1')
      .get(accountId, date, addDays(date, days), amount)
  );
}

/** One FNB transaction alert (from an email, SMS or push). Each side of the
 *  money on an account set up in BudgetPro becomes a provisional
 *  transaction, replaced when the statement arrives. */
export function ingestFnbAlert(text: string, received: Date, source = 'FNB alert'): NotificationResult {
  const n: IncomingNotification = { package: 'fnb', title: null, text };
  const done = (status: NotificationResult['status'], reason: string | null, ids: string[] = [], keepText = true): NotificationResult => {
    log(n, keepText, status, reason, ids[0] ?? null);
    return { status, reason, transaction_ids: ids };
  };
  const p = parseFnbAlert(text, received);
  if (p.kind === 'ignore') return done('ignored', p.reason);
  if (p.kind === 'unknown') return done('unparsed', p.reason);
  const ids: string[] = [];
  let tracked = 0;
  for (const leg of p.legs) {
    const account = accountForLast4(leg.account);
    if (!account) continue;
    tracked++;
    if (onStatementWithin(account.id, p.date, leg.amount, 4)) continue;
    const id = createProvisional(account.id, p.date, p.time, leg.amount, leg.description, source);
    if (id) ids.push(id);
  }
  // Accounts you don't track leave no content behind.
  if (!tracked) return done('ignored', `Account ..${p.legs.map((l) => l.account).join(' / ..')} isn't set up in BudgetPro`, [], false);
  if (!ids.length) return done('duplicate', 'Already on a statement, or received before');
  autoCategorize(ids);
  return done('imported', p.summary, ids);
}

export { looksLikeFnbAlert };

export function ingestNotification(n: IncomingNotification): NotificationResult {
  const title = (n.title ?? '').trim();
  const body = (n.big_text || n.text || '').trim();
  const posted = parsePostedAt(n.posted_at);

  if (looksLikeFnbAlert(body) || looksLikeFnbAlert(title)) {
    return ingestFnbAlert(looksLikeFnbAlert(body) ? body : `${title} ${body}`, posted ?? new Date(), 'FNB notification');
  }

  // From the banking app itself but worded in a way we don't read yet:
  // keep it (it's the bank's own message) so the wording can be added.
  if (!looksLikeDiscovery(title, body) && /^(bank.discovery.|za.co.fnb)/i.test(n.package ?? '')) {
    const reason = title || body ? 'Banking app notification not recognised' : 'Arrived with no title or text';
    log(n, true, 'unparsed', reason, null);
    return { status: 'unparsed', reason, transaction_ids: [] };
  }

  if (!looksLikeDiscovery(title, body)) {
    // Not a bank notification we understand: keep no content, just the fact.
    const r: NotificationResult = { status: 'not_bank', reason: 'Not a recognised bank notification', transaction_ids: [] };
    log(n, false, r.status, r.reason, null);
    return r;
  }

  const p = parseDiscoveryNotification(title, body, posted);
  const done = (status: NotificationResult['status'], reason: string | null, ids: string[] = [], keepText = true): NotificationResult => {
    log(n, keepText, status, reason, ids[0] ?? null);
    return { status, reason, transaction_ids: ids };
  };
  // Accounts you don't track (e.g. a business account) leave no content behind.
  const untracked = (reason: string) => done('ignored', reason, [], false);

  if (p.kind === 'ignore') return done('ignored', p.reason);
  if (p.kind === 'unknown') return done('unparsed', p.reason);
  if (!p.date) return done('unparsed', 'No date in the notification');

  if (p.kind === 'card_payment') {
    const account = accountForLast4(p.account);
    if (!account) return untracked(`Account ***${p.account} isn't set up in BudgetPro`);
    const amount = -Math.abs(p.amount);
    if (onStatement(account.id, p.date, amount)) return done('duplicate', 'Already on an imported statement');
    const id = createProvisional(account.id, p.date, p.time, amount, `${p.merchant}${p.card ? ` ***${p.card}` : ''}`);
    if (!id) return done('duplicate', 'Same notification received before');
    autoCategorize([id]);
    return done('imported', `${account.name}: ${p.merchant} R${p.amount.toFixed(2)}`, [id]);
  }

  // Transfer: one side per tracked account, worded like the statement so
  // the "Own account transfer" rule categorises both as Transfers.
  const from = accountForLast4(p.from_account);
  const to = accountForLast4(p.to_account);
  if (!from && !to) return untracked('Neither account in this transfer is set up in BudgetPro');
  const ids: string[] = [];
  if (from && !onStatement(from.id, p.date, -p.amount)) {
    const id = createProvisional(from.id, p.date, p.time, -p.amount, `Transfer Inter account transfer to account...${p.to_account ?? ''}`);
    if (id) ids.push(id);
  }
  if (to && !onStatement(to.id, p.date, p.amount)) {
    const id = createProvisional(to.id, p.date, p.time, p.amount, `Transfer Inter account transfer from account...${p.from_account ?? ''}`);
    if (id) ids.push(id);
  }
  if (!ids.length) return done('duplicate', 'Transfer already recorded');
  autoCategorize(ids);
  return done('imported', `Transfer R${p.amount.toFixed(2)}`, ids);
}

/** Called after a statement import: each new statement line takes over the
 *  provisional transaction it corresponds to (same account and amount, the
 *  notification dated on or up to 3 days before the statement line), keeping
 *  whatever the user already did to it — category splits, slip, notes. */
export function replaceProvisional(statementTxIds: string[]): number {
  let replaced = 0;
  const get = db.prepare('SELECT id, account_id, date, amount FROM transactions WHERE id = ?');
  const find = db.prepare(
    `SELECT id, notes FROM transactions
     WHERE provisional = 1 AND account_id = ? AND ABS(amount - ?) < 0.005 AND date BETWEEN ? AND ?
     ORDER BY ABS(julianday(date) - julianday(?)) LIMIT 1`
  );
  db.transaction(() => {
    for (const sid of statementTxIds) {
      const s = get.get(sid) as { id: string; account_id: string; date: string; amount: number } | undefined;
      if (!s) continue;
      const p = find.get(s.account_id, s.amount, addDays(s.date, -3), addDays(s.date, 1), s.date) as
        | { id: string; notes: string | null }
        | undefined;
      if (!p) continue;
      db.prepare('UPDATE transaction_splits SET transaction_id = ? WHERE transaction_id = ?').run(s.id, p.id);
      db.prepare('UPDATE receipts SET transaction_id = ? WHERE transaction_id = ?').run(s.id, p.id);
      db.prepare('UPDATE notifications SET transaction_id = ? WHERE transaction_id = ?').run(s.id, p.id);
      // Keep user notes, drop the automatic "From phone notification" one.
      if (p.notes && !/^From phone notification/.test(p.notes)) {
        db.prepare('UPDATE transactions SET notes = COALESCE(notes, ?) WHERE id = ?').run(p.notes, s.id);
      }
      db.prepare('UPDATE transactions SET merchant_id = COALESCE(merchant_id, (SELECT merchant_id FROM transactions WHERE id = ?)) WHERE id = ?').run(p.id, s.id);
      db.prepare('DELETE FROM transactions WHERE id = ?').run(p.id);
      replaced++;
    }
  })();
  return replaced;
}
