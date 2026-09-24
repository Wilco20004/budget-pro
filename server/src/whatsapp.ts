import crypto from 'crypto';
import path from 'path';
import { Request, Response } from 'express';
import { db, now } from './db';
import { publishSensors } from './ha';
import { importIncomingFile } from './intake';
import { getSettings, readOptions } from './settings';

// WhatsApp → BudgetPro through the NeuraCore WhatsApp platform's callbacks.
// The platform POSTs every event to <CallbackUrl>/<Endpoint>; only
// /WhatsappReceived with media is used: a slip photo or PDF sent from one of
// the allowed numbers becomes a slip (or a statement, for a statement PDF).
//
//   - Auth: the platform's "custom header" mode, X-Api-Key: <whatsapp key>.
//   - Answer 2xx at once and work afterwards (it retries anything slower
//     than 60 s); the message ID de-duplicates retries.
//   - A business number hears from anyone, so only numbers on the allow
//     list are imported; others are logged by their last digits only.
//   - MediaPath is fetched from the configured platform host only — a
//     forged callback can't point BudgetPro at other addresses.

const KEY_SETTING = 'whatsapp_key';
const MAX_BYTES = 25 * 1024 * 1024;

export function getWhatsappKey(): string {
  let row = db.prepare('SELECT value FROM settings WHERE key = ?').get(KEY_SETTING) as { value: string } | undefined;
  if (!row) {
    row = { value: crypto.randomBytes(24).toString('base64url') };
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(KEY_SETTING, row.value);
  }
  return row.value;
}

export function regenerateWhatsappKey(): string {
  const key = crypto.randomBytes(24).toString('base64url');
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(KEY_SETTING, key);
  return key;
}

/** "082 123 4567, +27 83 111 2222" → ["27821234567", "27831112222"]. */
export function normaliseNumbers(raw: string): string[] {
  return raw
    .split(/[,;\n]/)
    .map((n) => n.replace(/\D/g, ''))
    .map((n) => (n.startsWith('0') && n.length === 10 ? `27${n.slice(1)}` : n))
    .filter((n) => n.length >= 8);
}

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

interface ReceivedMessage {
  ID?: string;
  Content?: string;
  MediaPath?: string;
  MessageType?: string;
  MimeType?: string;
  Data?: string;
  HasMedia?: boolean;
  AuthorName?: string;
  PhoneNumber?: string;
  IsFromMe?: boolean;
  SentDate?: string;
}

type Status = 'processing' | 'receipt' | 'statement' | 'ignored' | 'not_allowed' | 'failed';

/** Claims the message ID before any work, so a retry that arrives while the
 *  first delivery is still downloading/reading is recognised. False = seen. */
function claim(m: ReceivedMessage): boolean {
  const phone = (m.PhoneNumber ?? '').replace(/\D/g, '');
  const r = db
    .prepare(
      `INSERT OR IGNORE INTO whatsapp_messages (id, received_at, phone_tail, author, message_type, status, detail, receipt_id, created_at)
       VALUES (?, ?, ?, NULL, ?, 'processing', NULL, NULL, ?)`
    )
    .run(m.ID, m.SentDate ?? now(), phone ? `…${phone.slice(-4)}` : null, m.MessageType ?? null, now());
  if (r.changes === 1) return true;
  // A claim left behind by a restart mid-download: a later retry takes over.
  const stale = new Date(Date.now() - 10 * 60_000).toISOString();
  return (
    db
      .prepare("UPDATE whatsapp_messages SET created_at = ? WHERE id = ? AND status = 'processing' AND created_at < ?")
      .run(now(), m.ID, stale).changes === 1
  );
}

function record(m: ReceivedMessage, status: Status, detail: string, receiptId: string | null, allowed: boolean) {
  db.prepare('UPDATE whatsapp_messages SET status = ?, detail = ?, receipt_id = ?, author = ? WHERE id = ?').run(
    status,
    detail,
    receiptId,
    allowed ? m.AuthorName ?? null : null, // strangers' names aren't kept
    m.ID
  );
}

async function download(mediaPath: string): Promise<Buffer> {
  const base = getSettings().whatsapp_media_base;
  const origin = new URL(base).origin;
  const url = new URL(mediaPath, base);
  if (url.origin !== origin) throw new Error(`Media outside ${origin} refused`);
  const headers: Record<string, string> = {};
  const extra = readOptions().whatsapp_media_header; // e.g. "X-Api-Key: …" if the platform wants one
  if (extra && extra.includes(':')) headers[extra.slice(0, extra.indexOf(':')).trim()] = extra.slice(extra.indexOf(':') + 1).trim();
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Media download failed: HTTP ${res.status}`);
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > MAX_BYTES) throw new Error('Media larger than 25 MB');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error('Media larger than 25 MB');
  return buf;
}

export async function handleReceived(m: ReceivedMessage): Promise<void> {
  if (!m.ID || m.IsFromMe) return;
  if (!claim(m)) return; // a retry of a message already received
  const allowedNumbers = normaliseNumbers(getSettings().whatsapp_numbers);
  const phone = (m.PhoneNumber ?? '').replace(/\D/g, '');
  if (!allowedNumbers.includes(phone)) {
    record(m, 'not_allowed', 'Sender is not on the allowed numbers list — nothing downloaded', null, false);
    return;
  }
  if (!m.HasMedia || !m.MediaPath) {
    record(m, 'ignored', 'No photo or file', null, true);
    return;
  }
  if (!['image', 'document'].includes(m.MessageType ?? '')) {
    record(m, 'ignored', `${m.MessageType} messages aren't imported`, null, true);
    return;
  }
  try {
    let data: { FileName?: string | null; MimeType?: string | null } = {};
    try {
      data = m.Data ? JSON.parse(m.Data) : {};
    } catch {
      data = {};
    }
    const mime = m.MimeType || data.MimeType || 'application/octet-stream';
    const name = data.FileName || path.posix.basename(m.MediaPath);
    const buf = await download(m.MediaPath);
    const r = await importIncomingFile(buf, name, mime, 'whatsapp');
    if (r.kind === 'receipt' && m.Content) {
      // The caption ("Checkers, nappies were for the baby") is kept as the slip's name.
      db.prepare('UPDATE receipts SET original_name = ? WHERE id = ?').run(m.Content.slice(0, 200), r.receipt_id);
    }
    record(m, r.kind === 'skipped' ? 'ignored' : r.kind, r.detail, r.kind === 'receipt' ? r.receipt_id : null, true);
    if (r.kind !== 'skipped') publishSensors().catch(() => undefined);
  } catch (e) {
    record(m, 'failed', (e as Error).message, null, true);
  }
}

/** POST /webhooks/whatsapp/:endpoint — mounted outside the API token check;
 *  the X-Api-Key header (or ?key=) is the credential. */
export function whatsappWebhook(req: Request, res: Response) {
  const given = String(req.get('x-api-key') ?? req.query.key ?? '');
  if (!given || !sameSecret(given, getWhatsappKey())) {
    res.status(401).json({ error: 'Invalid or missing X-Api-Key' });
    return;
  }
  // Every other event (sent messages, statuses, …) is acknowledged and dropped.
  if (req.params.endpoint !== 'WhatsappReceived') {
    res.json({ ok: true, ignored: true });
    return;
  }
  res.json({ ok: true });
  const body = req.body as ReceivedMessage;
  setImmediate(() => handleReceived(body).catch((e) => console.warn('[budgetpro] whatsapp:', (e as Error).message)));
}

export function whatsappStatus() {
  const s = getSettings();
  return {
    key: getWhatsappKey(),
    numbers: s.whatsapp_numbers,
    media_base: s.whatsapp_media_base,
    recent: db
      .prepare('SELECT id, received_at, phone_tail, author, message_type, status, detail, receipt_id FROM whatsapp_messages ORDER BY created_at DESC LIMIT 20')
      .all(),
  };
}
