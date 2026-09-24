import { parseDate, ParsedRow, ParsedStatement } from './parse';

// FNB (First National Bank) PDF statements, as emailed. Three layouts:
//
//   Cheque / current account ("FNB Fusion Premier Account" and friends):
//     Statement Period : 20 August 2026 to 19 September 2026
//     Opening Balance 1,234.56 Dr
//     26 Aug POS Purchase Corner Cafe 400000*1111 25 Aug 80.00 1,314.56
//     25 Aug FNB OB Pmt Salary 20,000.00Cr 18,685.44Cr
//     22 Aug 2.75 1,317.31              <- accrued bank charge, no description
//     Closing Balance 1,317.31Dr
//   Amounts are debits unless marked Cr; a balance without Cr is overdrawn.
//   Dates have no year — it comes from the statement period.
//
//   Credit card ("FNB Premier Credit", "Credit Card"):
//     Statement Date 07 Sep 2026
//     Opening Balance 12 345.67           <- after the "Tran Date" header
//     31 Aug Some Shop 7AB 2 100.00       <- space as thousands separator
//     31 Aug Payment Thank You 1 500.00Cr
//     Closing Balance 12 400.00 0.00
//   Purchases and fees are owed (money out); Cr is a payment/refund.
//
//   Personal loan:
//     Personal Loan Transaction History from 16 August 2026 to 12 September 2026
//     28 Aug 2026 Opening Balance 90 000.00Dr
//     28 Aug 2026 Interest 2 000.00 92 000.00Dr
//     28 Aug 2026 Payment 3 000.00 89 000.00Dr
//   Debits and credits share a text position, so the sign comes from how
//   the balance (owed) moves.
//
// Every layout carries opening and closing balances; the rows are checked
// against them so a misread line shows up as a warning, not silent drift.
// Balances are stored from the account holder's side: owed = negative.

const r2 = (n: number) => Math.round(n * 100) / 100;

// "1,234.56" (cheque) and "1 234.56" (card, loan). The look-behind stops a
// reference number glued in front ("012345 99.50") being read as thousands.
const COMMA_AMT = String.raw`\d{1,3}(?:,\d{3})*\.\d{2}`;
const SPACE_AMT = String.raw`(?<![\d.])\d{1,3}(?: \d{3})*\.\d{2}`;
const num = (s: string) => parseFloat(s.replace(/[ ,]/g, ''));

export function fnbKind(text: string): 'cheque' | 'credit' | 'loan' | null {
  if (!/First\s*National\s*Bank|FirstRand Bank|fnb\.co\.za/i.test(text)) return null;
  if (/Personal Loan Transaction History/i.test(text)) return 'loan';
  if (/Statement Period\s*:/i.test(text) && /Transactions in RAND/i.test(text)) return 'cheque';
  if (/Card Total|Payment Due Date/i.test(text) && /Statement Date/i.test(text)) return 'credit';
  return null;
}

/** A "DD Mon" date on or before `end` (a statement's last day). */
function yearless(dayMon: string, end: string): string | null {
  const endYear = +end.slice(0, 4);
  const d = parseDate(`${dayMon} ${endYear}`);
  if (!d) return null;
  // A few days' grace: card lines can post just after the statement date.
  return Date.parse(d) > Date.parse(end) + 10 * 86400000 ? parseDate(`${dayMon} ${endYear - 1}`) : d;
}

function checkClosing(rows: ParsedRow[], opening: number | null, closing: number | null, warnings: string[]) {
  if (opening === null) {
    warnings.push('No opening balance found — the totals could not be checked against the statement.');
    return;
  }
  let running = opening;
  for (const r of rows) {
    running = r2(running + r.amount);
    if (r.balance === null) r.balance = running;
  }
  if (closing !== null && Math.abs(running - closing) > 0.009) {
    warnings.push(
      `Opening balance plus transactions comes to R${running.toFixed(2)}, but the statement's closing balance is R${closing.toFixed(2)} — some lines may have been missed or misread.`
    );
  }
}

function parseCheque(lines: string[], warnings: string[]): { rows: ParsedRow[]; hints: string[] } {
  const hints = new Set<string>();
  let end: string | null = null;
  let opening: number | null = null;
  let closing: number | null = null;
  for (const l of lines) {
    const p = l.match(/Statement Period\s*:\s*(\d{1,2} \w+ \d{4}) to (\d{1,2} \w+ \d{4})/i);
    if (p) end = parseDate(p[2]);
    const a = l.match(/(?:Account|\(ZAR\))\s*:\s*(\d{9,})/i);
    if (a) hints.add(a[1]);
    const o = l.match(new RegExp(String.raw`^Opening Balance (${COMMA_AMT}) ?(Cr|Dr)?`, 'i'));
    if (o && opening === null) opening = num(o[1]) * (/cr/i.test(o[2] ?? '') ? 1 : -1);
    const c = l.match(new RegExp(String.raw`^Closing Balance (${COMMA_AMT}) ?(Cr|Dr)?$`, 'i'));
    if (c) closing = num(c[1]) * (/cr/i.test(c[2] ?? '') ? 1 : -1);
  }
  if (!end) {
    warnings.push('No statement period found, so the year of each line is a guess.');
    end = new Date().toISOString().slice(0, 10);
  }
  const TX = new RegExp(String.raw`^(\d{1,2} [A-Z][a-z]{2})\b\s*(.*?)\s*(${COMMA_AMT})(Cr)? (${COMMA_AMT})(Cr|Dr)?$`);
  const rows: ParsedRow[] = [];
  let prev = opening;
  let fixed = 0;
  for (const l of lines) {
    const m = l.match(TX);
    if (!m) continue;
    const date = yearless(m[1], end);
    if (!date) continue;
    let amount = num(m[3]) * (m[4] ? 1 : -1);
    const balance = num(m[5]) * (m[6] && /cr/i.test(m[6]) ? 1 : -1);
    // The running balance is the source of truth for the sign.
    if (prev !== null && Math.abs(prev + amount - balance) > 0.009 && Math.abs(prev - amount - balance) <= 0.009) {
      amount = -amount;
      fixed++;
    }
    prev = balance;
    rows.push({ date, description: m[2].trim() || 'Bank charge', amount: r2(amount), balance });
  }
  if (fixed) warnings.push(`${fixed} line(s) had their in/out direction taken from the running balance.`);
  checkClosing(rows, opening, closing, warnings);
  return { rows, hints: [...hints] };
}

function parseCredit(lines: string[], warnings: string[]): { rows: ParsedRow[]; hints: string[] } {
  const hints = new Set<string>();
  let end: string | null = null;
  for (const l of lines) {
    const d = l.match(/Statement Date\s*:?\s*(\d{1,2} \w{3} \d{4})/i);
    if (d && !end) end = parseDate(d[1]);
    // The account number (4 groups of 4) on the product line, not the
    // masked card numbers ("5000 12** **** 1234").
    const a = l.match(/CREDIT\s+(\d{4} \d{4} \d{4} \d{4})\b/i) ?? l.match(/CSFZFN\d\s*:\s*(\d{4} \d{4} \d{4} \d{4})/i);
    if (a) hints.add(a[1].replace(/ /g, ''));
  }
  if (!end) {
    warnings.push('No statement date found, so the year of each line is a guess.');
    end = new Date().toISOString().slice(0, 10);
  }
  // Transactions follow the column header; the summary box above it has its
  // own Opening/Closing Balance lines (two columns: straight and budget).
  const start = lines.findIndex((l) => /^Tran$|Tran\s*Date|Transaction Details/i.test(l));
  const body = start >= 0 ? lines.slice(start) : lines;
  const OPEN = new RegExp(String.raw`^Opening Balance (${SPACE_AMT})(Cr|Dr)?$`, 'i');
  const CLOSE = new RegExp(String.raw`^Closing Balance (${SPACE_AMT})(Cr|Dr)?(?: ${SPACE_AMT})?$`, 'i');
  const TX = new RegExp(String.raw`^(\d{1,2} [A-Z][a-z]{2})\b\s*(.*?)\s*(${SPACE_AMT})(Cr)?$`);
  let owedOpening: number | null = null;
  let owedClosing: number | null = null;
  const rows: ParsedRow[] = [];
  for (const l of body) {
    const o = l.match(OPEN);
    if (o) {
      owedOpening = num(o[1]) * (/cr/i.test(o[2] ?? '') ? -1 : 1);
      continue;
    }
    const c = l.match(CLOSE);
    if (c) {
      owedClosing = num(c[1]) * (/cr/i.test(c[2] ?? '') ? -1 : 1);
      break;
    }
    if (/^Card (No\.|Total)/i.test(l)) continue;
    const m = l.match(TX);
    if (!m) continue;
    const date = yearless(m[1], end);
    if (!date) continue;
    rows.push({ date, description: m[2].trim() || 'Card fee', amount: r2(num(m[3]) * (m[4] ? 1 : -1)), balance: null });
  }
  // Card statements list card lines first, then fees, interest and payments —
  // not in date order. Running balances follow the dates, so the latest line's
  // balance is the closing balance.
  rows.sort((a, b) => a.date.localeCompare(b.date));
  checkClosing(rows, owedOpening === null ? null : -owedOpening, owedClosing === null ? null : -owedClosing, warnings);
  return { rows, hints: [...hints] };
}

function parseLoan(lines: string[], warnings: string[]): { rows: ParsedRow[]; hints: string[] } {
  const hints = new Set<string>();
  for (const l of lines) {
    const a = l.match(/Account Number\s*:\s*([\d-]{9,})/i);
    if (a) hints.add(a[1].replace(/\D/g, ''));
  }
  const BAL = new RegExp(String.raw`^(\d{1,2} [A-Z][a-z]{2} \d{4}) (Opening|Closing) Balance (${SPACE_AMT})(Dr|Cr)?$`, 'i');
  const TX = new RegExp(String.raw`^(\d{1,2} [A-Z][a-z]{2} \d{4})\b\s*(.*?)\s*(${SPACE_AMT}) (${SPACE_AMT})(Dr|Cr)?$`);
  const owed = (v: string, s?: string) => num(v) * (/cr/i.test(s ?? '') ? -1 : 1);
  let opening: number | null = null;
  let closing: number | null = null;
  let prevOwed: number | null = null;
  const rows: ParsedRow[] = [];
  for (const l of lines) {
    const b = l.match(BAL);
    if (b) {
      const v = owed(b[3], b[4]);
      if (/opening/i.test(b[2])) {
        opening = -v;
        prevOwed = v;
      } else closing = -v;
      continue;
    }
    const m = l.match(TX);
    if (!m) continue;
    const date = parseDate(m[1]);
    if (!date) continue;
    const amt = num(m[3]);
    const nowOwed = owed(m[4], m[5]);
    // More owed = money out of the loan account (interest, fees, insurance).
    let amount = -amt;
    if (prevOwed !== null) {
      const d = r2(nowOwed - prevOwed);
      amount = d > 0 ? -amt : amt;
      if (Math.abs(Math.abs(d) - amt) > 0.009) warnings.push(`${m[1]} ${m[2]}: the amount doesn't match the balance change.`);
    }
    prevOwed = nowOwed;
    rows.push({ date, description: m[2].trim() || 'Loan fee', amount: r2(amount), balance: -nowOwed });
  }
  checkClosing(rows, opening, closing, warnings);
  return { rows, hints: [...hints] };
}

export function parseFnbStatement(text: string): ParsedStatement {
  const kind = fnbKind(text);
  const lines = text.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const warnings: string[] = [];
  const r = kind === 'loan' ? parseLoan(lines, warnings) : kind === 'credit' ? parseCredit(lines, warnings) : parseCheque(lines, warnings);
  return { format: `fnb-pdf-${kind ?? 'cheque'}`, rows: r.rows, accountHints: r.hints, warnings };
}
