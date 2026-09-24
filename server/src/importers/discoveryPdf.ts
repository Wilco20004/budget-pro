import { parseAmount, parseDate, ParsedRow, ParsedStatement } from './parse';

// Discovery Bank monthly statements (transaction account and credit card
// share one layout). After rebuilding lines from the PDF, the transaction
// timeline reads:
//
//   Date Card no. Type Details Amount
//   Opening balance - R5,000.00
//   04 Jul 2026 ***1111 POS Purchase CORNER CAFE (PTY)LTD SANDTON - R189.00
//   18 Jul 2026 Transfer Inter account transfer from account...7777 R3,000.00
//   Rent                                   <- wrapped details of the line above
//   ...
//   Closing balance - R8,189.00
//
// "- R" is money out (so a credit card's purchases are already negative, no
// sign flip needed). The column header, the bank's address footer and the
// "Straight Budget" section title repeat on page breaks and are skipped.

export function isDiscoveryStatement(text: string): boolean {
  return /Discovery Bank Limited/i.test(text) && /Transaction timeline/i.test(text);
}

// Thousands are written "R1,234.56" on newer statements and "R1 234.56" on
// older ones (and occasionally not at all: "R15085.46").
const AMT = String.raw`R\s?(\d{1,3}(?:[ ,]?\d{3})*\.\d{2})`;
const TX_LINE = new RegExp(String.raw`^(\d{1,2} [A-Za-z]{3} \d{4})\s*(\*{3}\d{4})?\s*(.*?)\s+(-\s?)?` + AMT + '$');
const BALANCE_LINE = new RegExp(String.raw`^(Opening|Closing) balance\s+(-\s?)?` + AMT + '$', 'i');
const HAS_AMOUNT = new RegExp(AMT);
const NOISE =
  /^(Date Card no\.|1 Discovery Place|Discovery Bank Limited|FSP number|Straight Budget|Budget facility|Total VAT|Your interest rate|Page \d)/i;

function money(neg: string | undefined, digits: string): number {
  const n = parseAmount(digits) ?? 0;
  return neg ? -n : n;
}

export function parseDiscoveryStatement(text: string, filename: string): ParsedStatement {
  const lines = text.split('\n').map((l) => l.replace(/\s+/g, ' ').trim());
  const warnings: string[] = [];
  const rows: ParsedRow[] = [];

  // The account number is on the summary line ("Discovery Platinum Card
  // 12345678901") and at the start of the file name. Deliberately NOT taken
  // from transfer lines ("to account...8901"), which name the other account.
  const hints = new Set<string>();
  for (const l of lines) {
    const m = l.match(/^Discovery .*?(\d{9,})$/);
    if (m) hints.add(m[1]);
  }
  const fm = filename.match(/^(\d{9,})/);
  if (fm) hints.add(fm[1]);

  let opening: number | null = null;
  let closing: number | null = null;
  let inTimeline = false;
  let last: ParsedRow | null = null;

  for (const l of lines) {
    if (!l) continue;
    if (/^Transaction timeline/i.test(l)) {
      inTimeline = true;
      continue;
    }
    if (!inTimeline) continue;
    const bal = l.match(BALANCE_LINE);
    if (bal) {
      const v = money(bal[2], bal[3]);
      if (/^opening/i.test(bal[1])) opening = v;
      else {
        closing = v;
        break; // everything after is card holders, interest rates, footers
      }
      last = null;
      continue;
    }
    const m = l.match(TX_LINE);
    if (m) {
      const date = parseDate(m[1]);
      if (!date) continue;
      const card = m[2] ? ` ${m[2]}` : '';
      last = { date, description: `${m[3].trim()}${card}`, amount: money(m[4], m[5]), balance: null };
      rows.push(last);
      continue;
    }
    if (NOISE.test(l)) {
      last = null;
      continue;
    }
    // A short line with no amount right after a transaction is its wrapped
    // details (a transfer reference, the rest of a shop's town).
    if (last && l.length <= 40 && !HAS_AMOUNT.test(l)) {
      const card = last.description.match(/ (\*{3}\d{4})$/);
      const base = card ? last.description.slice(0, -card[0].length) : last.description;
      last.description = `${base} ${l}${card ? card[0] : ''}`;
      last = null; // at most one continuation line
    }
  }

  // Running balance, and the reconciliation check that proves nothing was
  // dropped or misread: opening + transactions must equal closing.
  if (opening !== null) {
    let running = opening;
    for (const r of rows) {
      running = Math.round((running + r.amount) * 100) / 100;
      r.balance = running;
    }
    if (closing !== null && Math.abs(running - closing) > 0.009) {
      warnings.push(
        `Opening balance plus transactions comes to R${running.toFixed(2)}, but the statement's closing balance is R${closing.toFixed(2)} — some lines may have been missed.`
      );
    }
  } else {
    warnings.push('No opening balance found — the totals could not be checked against the statement.');
  }

  return { format: 'discovery-pdf', rows, accountHints: [...hints], warnings };
}
