import { extractTextItems } from 'unpdf';
import { parseAmount, ParsedRow, ParsedStatement } from './parse';

// Discovery Bank "transaction history" export — a date range across ALL
// accounts in one PDF, one section per account:
//
//   Account holder: A N Other From: 2026-06-24 To: 2026-09-24
//   Account type: Credit Card Account Account number: 12345678901
//   Date        Description                    Debit     Credit    Balance
//   2026-01-05  CORNER CAFE                    R 250.00            R 1,250.00-
//   2026-01-06  Inter account transfer from…             R 1,250.00 R 0.00
//
// Debit and credit share nothing but their column, so each amount is placed
// by where it sits under the header (right edges line up). A trailing "-"
// on a balance means owed. The running balance then proves every row was
// read right: previous balance + amount = this balance.

export function isDiscoveryHistory(text: string): boolean {
  return /Discovery Bank Limited/i.test(text) && /Account holder:.*From:\s*\d{4}-\d{2}-\d{2}\s+To:/i.test(text) && /Date\s+Description\s+Debit\s+Credit\s+Balance/i.test(text);
}

const AMOUNT = /^R\s?\d{1,3}(?:,\d{3})*\.\d{2}-?$/;

interface Item {
  str: string;
  x: number;
  right: number;
  y: number;
  h: number;
}

export async function parseDiscoveryHistory(buf: Buffer): Promise<ParsedStatement> {
  const { items: pages } = await extractTextItems(new Uint8Array(buf));
  const rows: ParsedRow[] = [];
  const warnings: string[] = [];
  const hints = new Set<string>();
  const sectionNames = new Map<string, string>();

  let account: string | null = null;
  let cols: { debit: number; credit: number; balance: number } | null = null;
  let last: ParsedRow | null = null;

  for (const page of pages) {
    const items: Item[] = page
      .filter((it) => it.str.trim())
      .map((it) => ({ str: it.str.trim(), x: it.x, right: it.x + it.width, y: it.y, h: it.height }));
    // Rebuild visual rows, top to bottom.
    const lines: Item[][] = [];
    for (const it of items.sort((a, b) => b.y - a.y)) {
      const row = lines.find((r) => Math.abs(r[0].y - it.y) < Math.max(2, it.h * 0.5));
      if (row) row.push(it);
      else lines.push([it]);
    }
    for (const line of lines) {
      line.sort((a, b) => a.x - b.x);
      const text = line.map((i) => i.str).join(' ').replace(/\s+/g, ' ');

      const acct = text.match(/Account type:\s*(.+?)\s+Account number:\s*(\d{6,})/i);
      if (acct) {
        account = acct[2];
        hints.add(account);
        sectionNames.set(account, acct[1].trim());
        last = null;
        continue;
      }
      if (/^Date Description Debit Credit Balance$/i.test(text)) {
        const find = (label: string) => line.find((i) => i.str.toLowerCase() === label)?.right ?? 0;
        cols = { debit: find('debit'), credit: find('credit'), balance: find('balance') };
        last = null;
        continue;
      }
      if (!account || !cols) continue;

      const amounts = line.filter((i) => AMOUNT.test(i.str));
      const rest = line.filter((i) => !amounts.includes(i));
      const dm = rest.map((i) => i.str).join(' ').match(/^(\d{4}-\d{2}-\d{2})\s*(.*)$/);
      if (dm && amounts.length) {
        let debit: number | null = null;
        let credit: number | null = null;
        let balance: number | null = null;
        for (const a of amounts) {
          // Nearest column by right edge.
          const d = { debit: Math.abs(a.right - cols.debit), credit: Math.abs(a.right - cols.credit), balance: Math.abs(a.right - cols.balance) };
          const col = (Object.keys(d) as (keyof typeof d)[]).sort((p, q) => d[p] - d[q])[0];
          const v = parseAmount(a.str);
          if (col === 'debit') debit = v;
          else if (col === 'credit') credit = v;
          else balance = v;
        }
        if (debit === null && credit === null) continue;
        last = {
          date: dm[1],
          description: dm[2].replace(/\s+/g, ' ').trim(),
          amount: debit !== null ? -Math.abs(debit) : Math.abs(credit!),
          balance,
          accountHint: account,
        };
        rows.push(last);
        continue;
      }
      // A short text-only line straight after a row is its wrapped description.
      if (last && !amounts.length && !dm && text.length <= 40 && !/Discovery|FSP number|Account holder/i.test(text)) {
        last.description = `${last.description} ${text}`;
        last = null;
        continue;
      }
      last = null;
    }
  }

  // Running-balance check per account.
  for (const acct of hints) {
    const r = rows.filter((x) => x.accountHint === acct);
    let bad = 0;
    for (let i = 1; i < r.length; i++) {
      const prev = r[i - 1].balance;
      const cur = r[i].balance;
      if (prev !== null && cur !== null && Math.abs(prev + r[i].amount - cur) > 0.009) bad++;
    }
    if (bad) {
      warnings.push(`${sectionNames.get(acct)} …${acct.slice(-4)}: ${bad} row(s) don't follow from the running balance — check them after importing.`);
    }
  }

  return { format: 'discovery-history-pdf', rows, accountHints: [...hints], warnings, sectionNames: Object.fromEntries(sectionNames) };
}
