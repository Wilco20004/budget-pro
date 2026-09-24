import path from 'path';
import { ImapFlow } from 'imapflow';
import { ParsedMail } from 'mailparser';
import { v4 as uuid } from 'uuid';
import { db, now } from '../db';
import { publishSensors } from '../ha';
import { importStatement } from '../importers';
import { parseStatement } from '../importers/parse';
import { ExtractedReceipt, parseReceiptText } from '../receipts/parseText';
import { createDataReceipt, processReceipt, saveReceiptFile, storeExtraction } from '../receipts/service';
import { EmailConfig, getEmailConfig } from '../settings';
import { htmlToLines } from './htmlText';
import { parseSixty60 } from './sixty60';
import { ensureFolder, fetchMessage, listMessages, MessageSummary, summaryFor, withMailbox } from './mailbox';

// Receipts mailbox → BudgetPro. Every few minutes new messages are read:
//   - statement attachments (Discovery PDF, CSV, OFX) are imported,
//   - slip attachments (photos, PDF e-slips) go through slip reading,
//   - otherwise the email body itself may be the receipt (online orders
//     such as Checkers Sixty60): a shop-specific parser, else the generic
//     till-slip parser on the email's text.
// Each message is handled once (emails table); the mailbox isn't changed.

export type EmailStatus = 'receipt' | 'statement' | 'ignored' | 'failed';

interface EmailState {
  uid_validity: string;
  last_uid: number;
  last_check: string | null;
  last_error: string | null;
}

const STATE_KEY = 'email_state';
const FIRST_RUN_DAYS = 60;

function getState(): EmailState {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(STATE_KEY) as { value: string } | undefined;
  const base: EmailState = { uid_validity: '', last_uid: 0, last_check: null, last_error: null };
  try {
    return row ? { ...base, ...JSON.parse(row.value) } : base;
  } catch {
    return base;
  }
}

function setState(patch: Partial<EmailState>) {
  const next = { ...getState(), ...patch };
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    STATE_KEY,
    JSON.stringify(next)
  );
}

/** A receipt in the email body, from a known shop's layout. Return null when
 *  the email isn't that shop's. Add a parser here per shop. */
type BodyParser = { name: string; parse: (mail: ParsedMail) => ExtractedReceipt | null };
const BODY_PARSERS: BodyParser[] = [{ name: 'sixty60', parse: parseSixty60 }];

const LOOKS_LIKE_RECEIPT = /receipt|invoice|order|slip|purchase|delivered|sixty60|checkers|woolworths|pick n pay|dis-?chem|clicks/i;

/** The email as lines of text: from the HTML when there is one (table rows
 *  kept together), else the plain-text part. */
export function bodyText(mail: ParsedMail): string {
  return mail.html ? htmlToLines(mail.html) : mail.text ?? '';
}

function bodyReceipt(mail: ParsedMail): { data: ExtractedReceipt; parser: string } | null {
  for (const p of BODY_PARSERS) {
    const data = p.parse(mail);
    if (data) return { data, parser: p.name };
  }
  const text = bodyText(mail);
  const header = `${mail.subject ?? ''} ${mail.from?.text ?? ''}`;
  if (!text || !LOOKS_LIKE_RECEIPT.test(header)) return null;
  const data = parseReceiptText(text);
  // Newsletters and adverts have prices too; a receipt has a total and lines.
  if (data.total === null || data.items.length === 0) return null;
  if (!data.date && mail.date) data.date = mail.date.toISOString().slice(0, 10);
  // The first line of an email is a heading ("Your order…"); the sender names the shop.
  data.merchant = mail.from?.value?.[0]?.name || data.merchant;
  return { data, parser: 'generic' };
}

function embedded(mail: ParsedMail, cid: string | undefined): boolean {
  return Boolean(cid && typeof mail.html === 'string' && mail.html.includes(`cid:${cid}`));
}

const STATEMENT_EXT = ['.csv', '.ofx', '.qfx'];
const IMAGE = /^image\/(jpeg|png|webp|gif|heic|heif)$/i;

export async function handleMail(mail: ParsedMail): Promise<{ status: EmailStatus; detail: string; receipt_id: string | null }> {
  const notes: string[] = [];
  let receiptId: string | null = null;
  let statements = 0;
  let slips = 0;

  for (const a of mail.attachments ?? []) {
    const name = a.filename || 'attachment';
    const ext = path.extname(name).toLowerCase();
    const isPdf = a.contentType === 'application/pdf' || ext === '.pdf';
    try {
      if (STATEMENT_EXT.includes(ext)) {
        const r = await importStatement(null, name, a.content, 'email');
        notes.push(`${name}: ${r.new_count} new transactions`);
        statements++;
      } else if (isPdf) {
        // A PDF is a statement if a statement reader recognises it, else a slip.
        let isStatement = false;
        try {
          isStatement = (await parseStatement(name, a.content)).rows.length > 0;
        } catch {
          isStatement = false;
        }
        if (isStatement) {
          const r = await importStatement(null, name, a.content, 'email');
          notes.push(`${name}: ${r.new_count} new transactions`);
          statements++;
        } else {
          const id = saveReceiptFile(a.content, name, 'application/pdf');
          await processReceipt(id);
          receiptId ??= id;
          notes.push(`${name}: slip added`);
          slips++;
        }
      } else if (IMAGE.test(a.contentType) && a.contentDisposition !== 'inline' && !a.related && !embedded(mail, a.cid)) {
        // Images shown inside the email's HTML (logos, signatures, a
        // forwarded letterhead) aren't slips; attached photos are.
        const id = saveReceiptFile(a.content, name, a.contentType.toLowerCase().replace('image/jpg', 'image/jpeg'));
        await processReceipt(id);
        receiptId ??= id;
        notes.push(`${name}: slip added`);
        slips++;
      }
    } catch (e) {
      notes.push(`${name}: ${(e as Error).message}`);
    }
  }

  if (!statements && !slips) {
    const found = bodyReceipt(mail);
    if (found) {
      receiptId = createDataReceipt(null);
      db.prepare('UPDATE receipts SET original_name = ? WHERE id = ?').run(mail.subject ?? 'Email', receiptId);
      storeExtraction(receiptId, found.data, `email:${found.parser}`, bodyText(mail));
      notes.push(`receipt from the email (${found.parser}): ${found.data.items.length} lines, total ${found.data.total}`);
      slips++;
    }
  }

  if (statements || slips) return { status: statements ? 'statement' : 'receipt', detail: notes.join('; '), receipt_id: receiptId };
  if (notes.length) return { status: 'failed', detail: notes.join('; '), receipt_id: null };
  return { status: 'ignored', detail: 'No slip, statement or receipt found', receipt_id: null };
}

/** Saves what happened to a message. `elsewhere`: it was read from another
 *  folder (e.g. already moved to BudgetPro), so its inbox uid isn't updated. */
function record(s: MessageSummary, uidValidity: string, r: { status: EmailStatus; detail: string; receipt_id: string | null }, elsewhere = false) {
  const t = now();
  const where = elsewhere ? '' : 'uid = excluded.uid, uid_validity = excluded.uid_validity, ';
  db.prepare(
    `INSERT INTO emails (id, uid, uid_validity, message_id, received_at, from_addr, subject, status, detail, receipt_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(message_id) DO UPDATE SET ${where}status = excluded.status,
       detail = excluded.detail, receipt_id = COALESCE(excluded.receipt_id, emails.receipt_id), updated_at = excluded.updated_at`
  ).run(uuid(), s.uid, uidValidity, s.message_id ?? `uid:${uidValidity}:${s.uid}`, s.date, s.from, s.subject, r.status, r.detail, r.receipt_id, t, t);
}

/** Imported emails leave the inbox (moved to cfg.move_to, or deleted),
 *  so it only shows what still needs a look. Each one is checked by
 *  Message-ID first, so a stale uid can never touch a different email. */
async function tidyMailbox(client: ImapFlow, uidValidity: string, cfg: EmailConfig) {
  if (cfg.after_import === 'keep') return;
  const rows = db
    .prepare("SELECT uid, message_id FROM emails WHERE uid_validity = ? AND status IN ('receipt', 'statement') AND mailbox_action IS NULL")
    .all(uidValidity) as { uid: number; message_id: string }[];
  if (!rows.length) return;
  const here = new Map<number, string | null>();
  for await (const m of client.fetch(rows.map((r) => r.uid), { uid: true, envelope: true }, { uid: true })) {
    here.set(m.uid, m.envelope?.messageId ?? null);
  }
  const mine = rows.filter((r) => here.has(r.uid) && (here.get(r.uid) === r.message_id || r.message_id.startsWith('uid:')));
  const gone = rows.filter((r) => !here.has(r.uid));
  const mark = db.prepare('UPDATE emails SET mailbox_action = ?, updated_at = ? WHERE uid_validity = ? AND uid = ?');
  for (const r of gone) mark.run('gone', now(), uidValidity, r.uid);
  if (!mine.length) return;
  const uids = mine.map((r) => r.uid);
  if (cfg.after_import === 'move') await client.messageMove(uids, await ensureFolder(client, cfg.move_to), { uid: true });
  else await client.messageDelete(uids, { uid: true });
  for (const r of mine) mark.run(cfg.after_import === 'move' ? 'moved' : 'deleted', now(), uidValidity, r.uid);
}

let running = false;

/** Fetch and handle new messages. Safe to call any time (one run at a time). */
export async function checkEmail(): Promise<{ processed: number }> {
  const cfg = getEmailConfig();
  if (!cfg || running) return { processed: 0 };
  running = true;
  let processed = 0;
  try {
    await withMailbox(async (client, uidValidity) => {
      const st = getState();
      const fresh = st.uid_validity !== uidValidity;
      const list = await listMessages(client, fresh ? { sinceDate: new Date(Date.now() - FIRST_RUN_DAYS * 86400000) } : { sinceUid: st.last_uid });
      let lastUid = fresh ? 0 : st.last_uid;
      for (const s of [...list].reverse()) {
        const seen = s.message_id && db.prepare('SELECT 1 FROM emails WHERE message_id = ?').get(s.message_id);
        if (!seen) {
          let r: { status: EmailStatus; detail: string; receipt_id: string | null };
          try {
            const mail = await fetchMessage(client, s.uid);
            r = mail ? await handleMail(mail) : { status: 'failed', detail: 'Message could not be read', receipt_id: null };
          } catch (e) {
            r = { status: 'failed', detail: (e as Error).message, receipt_id: null };
          }
          record(s, uidValidity, r);
          processed++;
        }
        lastUid = Math.max(lastUid, s.uid);
        setState({ uid_validity: uidValidity, last_uid: lastUid });
      }
      if (fresh) setState({ uid_validity: uidValidity, last_uid: lastUid });
      await tidyMailbox(client, uidValidity, cfg);
    }, { write: cfg.after_import !== 'keep' });
    setState({ last_check: now(), last_error: null });
  } catch (e) {
    setState({ last_check: now(), last_error: (e as Error).message });
  } finally {
    running = false;
  }
  if (processed) publishSensors().catch(() => undefined);
  return { processed };
}

/** Handle one message again (e.g. after a shop parser was added). A receipt
 *  made from the email body before is updated in place, not duplicated. */
export async function reprocessEmail(uid: number, folder?: string): Promise<{ status: EmailStatus; detail: string; receipt_id: string | null }> {
  return withMailbox(async (client, uidValidity, cfg) => {
    const s = await summaryFor(client, uid);
    if (!s) throw new Error(`No message with uid ${uid}`);
    const mail = await fetchMessage(client, uid);
    if (!mail) throw new Error('Message could not be read');
    const prev = db.prepare('SELECT receipt_id FROM emails WHERE message_id = ?').get(s.message_id ?? `uid:${uidValidity}:${uid}`) as
      | { receipt_id: string | null }
      | undefined;
    const prevReceipt = prev?.receipt_id
      ? (db.prepare("SELECT id, file_path FROM receipts WHERE id = ?").get(prev.receipt_id) as { id: string; file_path: string } | undefined)
      : undefined;
    let r: { status: EmailStatus; detail: string; receipt_id: string | null };
    if (prevReceipt && !prevReceipt.file_path) {
      // A body receipt: re-read the body into the same receipt.
      const found = bodyReceipt(mail);
      if (found) {
        storeExtraction(prevReceipt.id, found.data, `email:${found.parser}`, bodyText(mail));
        r = { status: 'receipt', detail: `receipt from the email (${found.parser}): ${found.data.items.length} lines, total ${found.data.total}`, receipt_id: prevReceipt.id };
      } else r = { status: 'ignored', detail: 'No receipt found in the email any more', receipt_id: prevReceipt.id };
    } else {
      r = await handleMail(mail);
    }
    record(s, uidValidity, r, Boolean(folder && folder !== cfg.folder));
    publishSensors().catch(() => undefined);
    return r;
  }, { folder });
}

export function emailStatus() {
  const cfg = getEmailConfig();
  const st = getState();
  return {
    configured: Boolean(cfg),
    user: cfg?.user ?? null,
    folder: cfg?.folder ?? null,
    after_import: cfg?.after_import ?? null,
    move_to: cfg?.move_to ?? null,
    last_check: st.last_check,
    last_error: st.last_error,
    recent: db
      .prepare('SELECT uid, received_at, from_addr, subject, status, detail, receipt_id FROM emails ORDER BY received_at DESC LIMIT 20')
      .all(),
  };
}

export function startEmailWatcher() {
  setInterval(() => checkEmail().catch(() => undefined), 5 * 60_000);
  setTimeout(() => checkEmail().catch(() => undefined), 15_000);
}
