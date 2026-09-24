import { parse as parseCsv } from 'csv-parse/sync';

export interface ParsedRow {
  date: string; // YYYY-MM-DD
  description: string;
  amount: number; // negative = money out
  balance: number | null;
  /** Bank-supplied unique id (OFX FITID), when the format has one. */
  externalId?: string;
}

export interface ParsedStatement {
  format: string;
  rows: ParsedRow[];
  /** Account number(s) spotted in the file, for matching to an account. */
  accountHints: string[];
  warnings: string[];
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  // Afrikaans month names occasionally appear on SA statements
  mei: 5, okt: 10, des: 12,
};

function pad(n: number) {
  return String(n).padStart(2, '0');
}

function valid(y: number, m: number, d: number): string | null {
  if (y < 1990 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** South African banks write dates day-first (25/09/2026) or year-first
 *  (2026/09/25); never month-first. */
export function parseDate(raw: string): string | null {
  const s = raw.trim().replace(/^'+|'+$/g, '');
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return valid(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
  if (m) return valid(+m[3], +m[2], +m[1]);
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2})$/);
  if (m) return valid(2000 + +m[3], +m[2], +m[1]);
  m = s.match(/^(\d{1,2})[\s-]+([A-Za-z]{3,9})[\s-]+(\d{2,4})/);
  if (m) {
    const mon = MONTHS[m[2].toLowerCase().slice(0, 3)];
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    if (mon) return valid(y, mon, +m[1]);
  }
  m = s.match(/^(\d{4})(\d{2})(\d{2})/); // OFX / compact
  if (m) return valid(+m[1], +m[2], +m[3]);
  return null;
}

/** "R -1 234,56", "1,234.56", "(123.45)", "123.45 Dr" → number. */
export function parseAmount(raw: string): number | null {
  let s = String(raw).trim();
  if (!s) return null;
  let negative = false;
  if (/\bdr\b|debit/i.test(s)) negative = true;
  s = s.replace(/\b(cr|dr)\b/gi, '');
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/[R$€£\s ']/g, '');
  if (s.endsWith('-')) {
    negative = true;
    s = s.slice(0, -1);
  }
  if (/^-?[\d.]*,\d{1,2}$/.test(s)) {
    // comma decimal: 1.234,56 or 1234,56
    s = s.replace(/\./g, '').replace(',', '.');
  } else {
    s = s.replace(/,/g, '');
  }
  if (!/^[-+]?\d*\.?\d+$/.test(s)) return null;
  const n = parseFloat(s);
  if (!Number.isFinite(n)) return null;
  return negative ? -Math.abs(n) : n;
}

function findAccountHints(text: string): string[] {
  const hints = new Set<string>();
  for (const m of text.matchAll(/(?:account|acc|rekening)[^\d\n]{0,30}([\d][\d -]{5,20}\d)/gi)) {
    hints.add(m[1].replace(/[\s-]/g, ''));
  }
  return [...hints];
}

type Col = 'date' | 'description' | 'amount' | 'debit' | 'credit' | 'balance';

function classifyHeader(cell: string): Col | null {
  const c = cell.trim().toLowerCase();
  if (!c) return null;
  if (/balance|saldo/.test(c)) return 'balance';
  if (/^(transaction |posting |value |post |trans\.? )?date$|^datum$/.test(c)) return 'date';
  if (/debit|money out|withdrawal|paid out/.test(c)) return 'debit';
  if (/credit|money in|deposit|paid in/.test(c)) return 'credit';
  if (/^(transaction )?amount|^value$|^bedrag/.test(c)) return 'amount';
  if (/description|details|narrative|reference|merchant|beskrywing|^transaction$|payee/.test(c)) return 'description';
  return null;
}

export function parseCsvStatement(text: string): ParsedStatement {
  const records: string[][] = parseCsv(text.replace(/^﻿/, ''), {
    relax_column_count: true,
    relax_quotes: true,
    skip_empty_lines: true,
    trim: true,
  });
  const warnings: string[] = [];
  const accountHints = findAccountHints(text);

  // Header-mapped path: find the first row that names a date column and
  // some kind of amount column.
  let headerIdx = -1;
  let map: Partial<Record<Col, number>> = {};
  for (let i = 0; i < Math.min(records.length, 40); i++) {
    const m: Partial<Record<Col, number>> = {};
    records[i].forEach((cell, j) => {
      const col = classifyHeader(cell);
      if (col && m[col] === undefined) m[col] = j;
    });
    if (m.date !== undefined && (m.amount !== undefined || m.debit !== undefined || m.credit !== undefined)) {
      headerIdx = i;
      map = m;
      break;
    }
  }

  const rows: ParsedRow[] = [];
  if (headerIdx >= 0) {
    for (const rec of records.slice(headerIdx + 1)) {
      const date = parseDate(rec[map.date!] ?? '');
      if (!date) continue;
      let amount: number | null = null;
      if (map.amount !== undefined) amount = parseAmount(rec[map.amount] ?? '');
      if (amount === null && (map.debit !== undefined || map.credit !== undefined)) {
        const debit = map.debit !== undefined ? parseAmount(rec[map.debit] ?? '') : null;
        const credit = map.credit !== undefined ? parseAmount(rec[map.credit] ?? '') : null;
        if (debit) amount = -Math.abs(debit);
        else if (credit) amount = Math.abs(credit);
      }
      if (amount === null) continue;
      let description = map.description !== undefined ? rec[map.description] ?? '' : '';
      if (!description) {
        // No description column named — use the longest non-numeric cell.
        description = rec.filter((c, j) => j !== map.date && parseAmount(c) === null).sort((a, b) => b.length - a.length)[0] ?? '';
      }
      rows.push({
        date,
        description: description.replace(/\s+/g, ' ').trim(),
        amount,
        balance: map.balance !== undefined ? parseAmount(rec[map.balance] ?? '') : null,
      });
    }
    return { format: 'csv', rows, accountHints, warnings };
  }

  // Headerless fallback (older FNB exports prefix each line with a record
  // type number): date cell, then amount, then balance, and the longest text
  // cell is the description.
  warnings.push('No header row found — columns were guessed. Check a few rows before relying on them.');
  for (const rec of records) {
    const di = rec.findIndex((c) => parseDate(c) !== null && /[-/.\s]/.test(c.trim()));
    if (di < 0) continue;
    const nums: number[] = [];
    let description = '';
    rec.forEach((c, j) => {
      if (j <= di) return;
      const n = parseAmount(c);
      if (n !== null && /\d/.test(c)) nums.push(n);
      else if (c.length > description.length) description = c;
    });
    if (nums.length === 0) continue;
    rows.push({
      date: parseDate(rec[di])!,
      description: description.replace(/\s+/g, ' ').trim(),
      amount: nums[0],
      balance: nums.length > 1 ? nums[1] : null,
    });
  }
  return { format: 'csv-guessed', rows, accountHints, warnings };
}

function ofxTag(block: string, tag: string): string | null {
  const m = block.match(new RegExp(`<${tag}>([^<\\r\\n]*)`, 'i'));
  return m ? m[1].trim() : null;
}

export function parseOfxStatement(text: string): ParsedStatement {
  const rows: ParsedRow[] = [];
  const accountHints: string[] = [];
  const acct = ofxTag(text, 'ACCTID');
  if (acct) accountHints.push(acct.replace(/\D/g, ''));
  for (const m of text.matchAll(/<STMTTRN>([\s\S]*?)(?:<\/STMTTRN>|(?=<STMTTRN>)|(?=<\/BANKTRANLIST>))/gi)) {
    const b = m[1];
    const date = parseDate(ofxTag(b, 'DTPOSTED') ?? '');
    const amount = parseAmount(ofxTag(b, 'TRNAMT') ?? '');
    if (!date || amount === null) continue;
    const name = ofxTag(b, 'NAME') ?? '';
    const memo = ofxTag(b, 'MEMO') ?? '';
    rows.push({
      date,
      amount,
      description: [name, memo && memo !== name ? memo : ''].filter(Boolean).join(' ').trim(),
      balance: null,
      externalId: ofxTag(b, 'FITID') ?? undefined,
    });
  }
  return { format: 'ofx', rows, accountHints, warnings: [] };
}

export async function parseStatement(filename: string, buf: Buffer): Promise<ParsedStatement> {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.pdf') || buf.subarray(0, 5).toString('latin1') === '%PDF-') {
    // Lazy imports: pdf.js is only loaded when a PDF actually arrives.
    const { pdfText } = await import('../receipts/engines.js');
    const { isDiscoveryStatement, parseDiscoveryStatement } = await import('./discoveryPdf.js');
    let text: string;
    try {
      text = await pdfText(buf);
    } catch (e) {
      throw new Error(
        `Couldn't read that PDF (${(e as Error).message}). If it's password-protected, open it and "Print → Save as PDF" to save an unlocked copy.`
      );
    }
    if (isDiscoveryStatement(text)) return parseDiscoveryStatement(text, filename);
    throw new Error('Only Discovery Bank PDF statements can be read so far — for other banks, download the CSV instead.');
  }
  const text = buf.toString('utf-8');
  if (lower.endsWith('.ofx') || lower.endsWith('.qfx') || /<OFX>/i.test(text.slice(0, 2000))) {
    return parseOfxStatement(text);
  }
  return parseCsvStatement(text);
}
