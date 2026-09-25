import { parseAmount } from '../importers/parse';

// Discovery Bank app notifications, as shown in the app's Transaction
// Notifications screen (title, then body lines):
//
//   Card payment
//   CORNER CAFE 12345 – R 353.00
//   From ***8901
//   Card ending ***2222
//   Wednesday, 23 September at 17:05
//   Available balance: R 990.69
//
//   Transfer
//   R 1,000.00
//   From account ending ***5555
//   To account ending ***8901
//   Wednesday, 23 September at 08:55
//
// Declines ("Insufficient funds") move no money and are ignored. Android may
// hand the body over as one line, so everything is matched on the whole
// text rather than line positions.

export type ParsedNotification =
  | {
      kind: 'incoming';
      amount: number; // positive
      account: string; // last 4 digits
      reference: string | null;
      date: string | null;
      time: string | null;
    }
  | {
      kind: 'card_payment';
      merchant: string;
      amount: number; // positive
      account: string; // last 4 digits
      card: string | null;
      date: string | null; // YYYY-MM-DD, year inferred
      time: string | null; // HH:MM
    }
  | {
      kind: 'transfer';
      amount: number;
      from_account: string | null;
      to_account: string | null;
      date: string | null;
      time: string | null;
    }
  | { kind: 'ignore'; reason: string }
  | { kind: 'unknown'; reason: string };

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

const AMOUNT = String.raw`R\s?(\d{1,3}(?:[ ,]?\d{3})*\.\d{2})`;

/** "Wednesday, 23 September at 17:05" — no year, so take the most recent
 *  such date not in the future (a notification is never from next year).
 *  postedAt (the phone's timestamp) settles it when available. */
export function notificationDate(text: string, postedAt?: Date): { date: string | null; time: string | null } {
  const m = text.match(/(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)(?:\s+(\d{4}))?(?:\s+at\s+(\d{1,2}:\d{2}))?/i);
  if (!m) {
    if (!postedAt) return { date: null, time: null };
    return { date: postedAt.toISOString().slice(0, 10), time: null };
  }
  const day = parseInt(m[1], 10);
  const month = MONTHS[m[2].toLowerCase()];
  const ref = postedAt ?? new Date();
  let year = m[3] ? parseInt(m[3], 10) : ref.getFullYear();
  if (!m[3]) {
    const candidate = new Date(year, month - 1, day);
    // Allow a day of clock/timezone slack before rolling back a year.
    if (candidate.getTime() > ref.getTime() + 86400000) year -= 1;
  }
  const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return { date, time: m[4] ?? null };
}

export function looksLikeDiscovery(title: string, text: string): boolean {
  return /\*{3}\d{4}/.test(text) && /(Card payment|Transfer|Card ending|account ending|Available balance)/i.test(`${title} ${text}`);
}

export function parseDiscoveryNotification(title: string, text: string, postedAt?: Date): ParsedNotification {
  const all = `${title}\n${text}`.replace(/ /g, ' ');
  if (/insufficient funds|declined|unsuccessful|reversed/i.test(all)) {
    return { kind: 'ignore', reason: 'Declined or failed — no money moved' };
  }
  const { date, time } = notificationDate(all, postedAt);

  // Money paid in by someone else (a salary): "Incoming payment / R 30,850.16
  // / To account ending ***1234 / Reference: SALARY".
  if (/incoming payment/i.test(all) && !/\bTransfer\b/i.test(title)) {
    const amt = all.match(new RegExp(AMOUNT));
    const to = all.match(/To account ending\s*\*{3}(\d{4})/i);
    if (!amt || !to) return { kind: 'unknown', reason: 'Incoming payment without amount or account' };
    const ref = all.match(/Reference:\s*(.+)/i);
    return { kind: 'incoming', amount: parseAmount(amt[1]) ?? 0, account: to[1], reference: ref ? ref[1].trim() : null, date, time };
  }

  if (/\bTransfer\b/i.test(title) || /account ending/i.test(all)) {
    const amt = all.match(new RegExp(AMOUNT));
    const from = all.match(/From account ending\s*\*{3}(\d{4})/i);
    const to = all.match(/To account ending\s*\*{3}(\d{4})/i);
    if (!amt || (!from && !to)) return { kind: 'unknown', reason: 'Transfer without amount or account' };
    return { kind: 'transfer', amount: parseAmount(amt[1]) ?? 0, from_account: from?.[1] ?? null, to_account: to?.[1] ?? null, date, time };
  }

  // "<merchant> – R 353.00". Normally an en dash, but accept any lone symbol
  // there — a hop with the wrong text encoding turns it into "?" or "�".
  const pay = all.match(new RegExp(String.raw`(?:^|\n|Card payment\s*)\s*(.+?)\s+[^\w\s]{1,2}\s+` + AMOUNT, 'i'));
  const from = all.match(/From\s*\*{3}(\d{4})/i);
  if (pay && from) {
    const card = all.match(/Card ending\s*\*{3}(\d{4})/i);
    return {
      kind: 'card_payment',
      merchant: pay[1].replace(/^Card payment\s*/i, '').trim(),
      amount: parseAmount(pay[2]) ?? 0,
      account: from[1],
      card: card?.[1] ?? null,
      date,
      time,
    };
  }
  return { kind: 'unknown', reason: 'Not a format BudgetPro knows yet' };
}
