// FNB transaction alerts ("inContact"), as SMS / app push / email. The email
// subject carries the whole message, e.g.
//
//   FNB:-) R119.99 reserved for purchase @ Some Shop from Fusion Premier a/c..123456 using card..1111. 22Sep 14:06
//   FNB:-) R300.00 withdrawn from Easy Account..654321 @ 00100000 ATM. 23Sep 08:26
//   FNB:-) R609.00 paid from Fusion Premier a/c..123456 @ Smartapp. Ref.Doctor. 28Aug 10:35
//   FNB:-) R576.00 paid to Easy Account..654321 @ Payshap. Ref.Books.  9Sep 08:34
//   FNB :-) R1500.00 paid to FNB card a/c..777777. 31Aug 00:42
//   FNB:-) R200.00 t/fer from Fusion Premier a/c..123456 to Easy Account..654321 @ Smartapp. 27Aug 14:10
//
// Everything else FNB sends (overdrawn warnings, "Payment Link created",
// debit-order notices, "paid in full") moves no money and is ignored.
// Accounts are named by their last 6 digits.

export interface AlertLeg {
  /** Last digits of the account the money moved on. */
  account: string;
  /** Signed from that account's side: negative = money out. */
  amount: number;
  /** Worded like the statement line, so merchant rules match both. */
  description: string;
}

export type ParsedAlert =
  | { kind: 'money'; legs: AlertLeg[]; date: string; time: string | null; summary: string }
  | { kind: 'ignore'; reason: string }
  | { kind: 'unknown'; reason: string };

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

export function looksLikeFnbAlert(text: string): boolean {
  return /^\s*(?:(?:fw|fwd|re)\s*:\s*)*FNB\s*:-\)/i.test(text);
}

/** "22Sep 14:06" — the year is the latest one that doesn't put the alert
 *  after it was received. */
function alertDate(text: string, received: Date): { date: string; time: string | null } | null {
  const m = text.match(/\b(\d{1,2})\s?(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2}:\d{2})?/i);
  if (!m) return null;
  const month = MONTHS[m[2].toLowerCase()];
  const day = parseInt(m[1], 10);
  let year = received.getFullYear();
  const at = (y: number) => new Date(Date.UTC(y, month - 1, day));
  if (at(year).getTime() > received.getTime() + 2 * 86400000) year -= 1;
  const d = at(year);
  return { date: d.toISOString().slice(0, 10), time: m[3] ?? null };
}

const AMT = String.raw`R\s?(\d[\d,]*\.\d{2})`;
const ACCT = String.raw`(.+?)\s?(?:a\/c)?\.\.(\d{4,})`; // "Fusion Premier a/c..123456", "Easy Account..654321"
const num = (s: string) => parseFloat(s.replace(/,/g, ''));
const tidy = (s: string) => s.replace(/\s+/g, ' ').trim();

export function parseFnbAlert(raw: string, received: Date): ParsedAlert {
  const text = tidy(raw.replace(/^\s*(?:(?:fw|fwd|re)\s*:\s*)*/i, '').replace(/^FNB\s*:-\)\s*/i, ''));
  if (!/^R\s?\d/.test(text)) return { kind: 'ignore', reason: 'Not a money movement' };
  const when = alertDate(text, received);
  if (!when) return { kind: 'unknown', reason: 'No date in the alert' };
  let m: RegExpMatchArray | null;

  // Card purchase (a reservation — the statement line follows a day or two later)
  if ((m = text.match(new RegExp(`^${AMT} reserved for purchase @ (.+?) from ${ACCT}(?: using card\\.\\.(\\d+))?`, 'i')))) {
    const merchant = tidy(m[2]);
    return {
      kind: 'money',
      ...when,
      summary: `${merchant} R${m[1]}`,
      legs: [{ account: m[4], amount: -num(m[1]), description: `POS Purchase ${merchant}${m[5] ? ` card..${m[5]}` : ''}` }],
    };
  }
  if ((m = text.match(new RegExp(`^${AMT} withdrawn from ${ACCT} @ (.+?)\\.\\s`, 'i')))) {
    return {
      kind: 'money',
      ...when,
      summary: `Cash withdrawal R${m[1]}`,
      legs: [{ account: m[3], amount: -num(m[1]), description: `Cash Withdrawal ${tidy(m[4])}` }],
    };
  }
  if ((m = text.match(new RegExp(`^${AMT} t\\/fer from ${ACCT} to ${ACCT}`, 'i')))) {
    const amount = num(m[1]);
    return {
      kind: 'money',
      ...when,
      summary: `Transfer R${m[1]}`,
      // Worded like Discovery's, so the own-account transfer rule files both sides.
      legs: [
        { account: m[3], amount: -amount, description: `Inter account transfer to ${tidy(m[4])}..${m[5]}` },
        { account: m[5], amount, description: `Inter account transfer from ${tidy(m[2])}..${m[3]}` },
      ],
    };
  }
  if ((m = text.match(new RegExp(`^${AMT} paid from ${ACCT}(?: @ ([^.]+))?(?:\\. Ref\\.(.+?))?\\.\\s+\\d{1,2}\\s?[A-Za-z]{3}`, 'i')))) {
    const ref = m[5] ? tidy(m[5]) : '';
    const channel = tidy(m[4] ?? '');
    const description = /scheduled/i.test(channel) ? `Scheduled Payment To ${ref}` : `FNB App Payment To ${ref || channel}`;
    return { kind: 'money', ...when, summary: `${ref || channel} R${m[1]}`, legs: [{ account: m[3], amount: -num(m[1]), description }] };
  }
  if ((m = text.match(new RegExp(`^${AMT} paid to ${ACCT}(?: @ ([^.]+))?(?:\\. Ref\\.(.+?))?\\.\\s+\\d{1,2}\\s?[A-Za-z]{3}`, 'i')))) {
    const ref = m[5] ? tidy(m[5]) : '';
    const channel = tidy(m[4] ?? '');
    // Into a card with no reference: a card repayment ("Payment Thank You" on the statement).
    const description = /card/i.test(m[2]) && !ref ? 'Payment Thank You' : `${channel || 'Payment'} Credit ${ref}`.trim();
    return { kind: 'money', ...when, summary: `${ref || 'Payment'} R${m[1]} in`, legs: [{ account: m[3], amount: num(m[1]), description }] };
  }
  return { kind: 'unknown', reason: 'Alert wording not recognised' };
}
