import { ImapFlow } from 'imapflow';
import { ParsedMail, simpleParser } from 'mailparser';
import { EmailConfig, getEmailConfig } from '../settings';

// Read-only access to the receipts mailbox. Nothing is deleted, moved or
// flagged there: which messages were handled is tracked in the emails table,
// so the mailbox stays the untouched original.

export interface MessageSummary {
  uid: number;
  message_id: string | null;
  date: string | null;
  from: string | null;
  subject: string | null;
  size: number | null;
}

function addr(list: { name?: string; address?: string }[] | undefined): string | null {
  const a = list?.[0];
  if (!a) return null;
  return a.name && a.address ? `${a.name} <${a.address}>` : a.address ?? a.name ?? null;
}

export async function withMailbox<T>(fn: (client: ImapFlow, uidValidity: string, cfg: EmailConfig) => Promise<T>): Promise<T> {
  const cfg = getEmailConfig();
  if (!cfg) throw new Error('Email isn’t set up — add imap_host, imap_user and imap_password in the add-on’s Configuration tab.');
  const client = new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.port !== 143,
    auth: { user: cfg.user, pass: cfg.password },
    logger: false,
  });
  // A dropped connection emits 'error'; without a listener that would crash the process.
  client.on('error', () => undefined);
  await client.connect();
  try {
    const lock = await client.getMailboxLock(cfg.folder, { readOnly: true });
    try {
      const mb = client.mailbox;
      const uidValidity = mb && typeof mb === 'object' ? String(mb.uidValidity) : '';
      return await fn(client, uidValidity, cfg);
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }
}

/** Newest first. `sinceUid` lists only messages after it (the poller);
 *  `query` searches subject/from/body on the server. */
export async function listMessages(
  client: ImapFlow,
  opts: { limit?: number; sinceUid?: number; query?: string; sinceDate?: Date } = {}
): Promise<MessageSummary[]> {
  const criteria: Record<string, unknown> = {};
  if (opts.sinceUid) criteria.uid = `${opts.sinceUid + 1}:*`;
  if (opts.sinceDate) criteria.since = opts.sinceDate;
  if (opts.query) criteria.or = [{ subject: opts.query }, { from: opts.query }, { body: opts.query }];
  const found = await client.search(Object.keys(criteria).length ? criteria : { all: true }, { uid: true });
  let uids = (Array.isArray(found) ? found : []).filter((u) => !opts.sinceUid || u > opts.sinceUid).sort((a, b) => b - a);
  if (opts.limit) uids = uids.slice(0, opts.limit);
  if (!uids.length) return [];
  const out: MessageSummary[] = [];
  for await (const m of client.fetch(uids, { uid: true, envelope: true, size: true, internalDate: true }, { uid: true })) {
    out.push({
      uid: m.uid,
      message_id: m.envelope?.messageId ?? null,
      date: new Date(m.envelope?.date ?? m.internalDate ?? Date.now()).toISOString(),
      from: addr(m.envelope?.from),
      subject: m.envelope?.subject ?? null,
      size: m.size ?? null,
    });
  }
  return out.sort((a, b) => b.uid - a.uid);
}

export async function summaryFor(client: ImapFlow, uid: number): Promise<MessageSummary | null> {
  const m = await client.fetchOne(String(uid), { uid: true, envelope: true, size: true, internalDate: true }, { uid: true });
  if (!m) return null;
  return {
    uid: m.uid,
    message_id: m.envelope?.messageId ?? null,
    date: new Date(m.envelope?.date ?? m.internalDate ?? Date.now()).toISOString(),
    from: addr(m.envelope?.from),
    subject: m.envelope?.subject ?? null,
    size: m.size ?? null,
  };
}

export async function fetchMessage(client: ImapFlow, uid: number): Promise<ParsedMail | null> {
  const m = await client.fetchOne(String(uid), { uid: true, source: true }, { uid: true });
  if (!m || !m.source) return null;
  return simpleParser(m.source);
}
