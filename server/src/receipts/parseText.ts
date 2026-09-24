import { parseAmount, parseDate } from '../importers/parse';
import { amountCandidates, DIGITISH, repairGtin, resolveDate } from './ocrDigits';

export interface ExtractedItem {
  name: string;
  quantity: number;
  amount: number;
  /** EAN/GTIN barcode printed above the line (Checkers/Shoprite slips). */
  barcode?: string | null;
  /** Only the Claude engine suggests categories; name must match an existing category. */
  suggested_category?: string | null;
}

export interface ExtractedReceipt {
  merchant: string | null;
  date: string | null;
  total: number | null;
  /** OCR only: other values the printed total could be (a misread 9 etc.),
   *  cheapest first — tried against the bank amounts when matching. */
  total_alternatives?: number[];
  items: ExtractedItem[];
}

// Lines on a till slip that carry an amount but aren't a product.
const NOT_AN_ITEM =
  /\b(SUB\s*-?TOTAL|TOTAL|BALANCE|CHANGE|CASH|CARD|TENDER|VAT|TAX|AMOUNT DUE|DUE|SAVINGS?|YOU SAVED|DISCOUNT TOTAL|ROUNDING|POINTS|REWARDS?|SMART ?SHOPPER|VITALITY|EBUCKS|APPROVED|AUTH|CREDIT|DEBIT|MASTERCARD|VISA|ITEMS?\s*:?\s*\d|QTY|TEL|VAT NO|INVOICE|ELECTRONIC PAYMENT|PAYMENT|GROSS|NET|SINCE JOINING)\b/i;

// Amount at the end of a line: "R39.99", "39.99", "-R10.00", "R39.99A" (VAT
// flag), "5.00-". OCR sometimes reads the R as r, and digits as lookalikes
// ("R27.8%") — those are accepted here and mapped back in ocrDigits.ts.
const AMOUNT_AT_END = /^(.*?[A-Za-z].*?)\s+(-?[Rr]?\s?\d{1,5}[.,]\d{2})(?:\s*-)?\s*[A-Z*#]?$/;
const OCR_AMOUNT_AT_END = new RegExp(
  String.raw`^(.*?[A-Za-z].*?)\s+(-?[Rr]?\s?${DIGITISH}{1,5}[.,]${DIGITISH}{2,3})(?:\s*-)?\s*[A-Z*#]?$`
);
const GTIN = /^Item\s*\/\s*G\s*T\s*I\s*N\s*[:.]?\s*(\S+)/i;
const DATE_HEADER = /^Date\s+T\S*\s+Store|^Date\s+Time/i;

/** What the product database already knows, for correcting OCR. */
export interface KnownProducts {
  barcode(code: string): boolean;
  /** Unit prices this barcode was bought at before. */
  prices(code: string): number[];
}

interface RawLine {
  name: string;
  quantity: number;
  token: string;
  barcode: string | null;
  promo: boolean;
}

/** Pulls merchant/date/total/lines out of OCR or PDF text. Till slips are
 *  "NAME ........ 12.99" (sometimes with a trailing VAT flag letter). Checkers
 *  / Shoprite print "Item/GTIN <barcode>" above each product and multi-buys
 *  as "4 @ R3.89" under the line. With ocr, misread digits are corrected
 *  where there's evidence (see ocrDigits.ts). */
export function parseReceiptText(text: string, opts: { ocr?: boolean; now?: Date; known?: KnownProducts } = {}): ExtractedReceipt {
  const ocr = Boolean(opts.ocr);
  const known = opts.known;
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  // Prefer the "Date Time Store ..." rows' value (DD/MM/YY) — agreed over
  // every copy printed; else the first plausible date anywhere.
  let date: string | null = null;
  const headerReads = lines.flatMap((l, i) => (DATE_HEADER.test(l) && lines[i + 1] ? [lines[i + 1].split(' ')[0]] : []));
  if (headerReads.length) date = resolveDate(ocr ? headerReads : headerReads.filter((r) => /^[\d/.-]+$/.test(r)), opts.now);
  if (!date) {
    const dateRe = /(\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}|\d{1,2} [A-Za-z]{3,9} \d{4})/;
    const latest = new Date((opts.now ?? new Date()).getTime() + 86400000).toISOString().slice(0, 10);
    for (const l of lines) {
      const m = l.match(dateRe);
      const d = m ? parseDate(m[1]) : null;
      if (d && d <= latest) {
        date = d;
        break;
      }
    }
  }

  // The total is printed several times (TOTAL, card APPROVED AMOUNT,
  // Electronic Payment); take the value most of them agree on.
  const votes = new Map<number, number>();
  const vote = (n: number | null, w: number) => n !== null && n > 0 && votes.set(n, (votes.get(n) ?? 0) + w);
  for (const l of lines) {
    const amt = l.match(/(-?[Rr]?\s?\d[\d ,]*[.,]\d{2})\s*$/);
    if (/\bTOTAL\b/i.test(l) && !/SUB\s*-?TOTAL|SAVING|VAT|TAX|ITEMS|AGREE/i.test(l)) vote(amt ? parseAmount(amt[1]) : null, 1.1);
    else if (/ELECTRONIC PAYMENT|\bTENDER\b/i.test(l)) vote(amt ? parseAmount(amt[1]) : null, 1);
    const ap = l.match(/APPROVED\s+\S*MOUNT\s*:?\s*([Rr]?\s?\d[\d ,]*[.,]\d{2})/i);
    if (ap) vote(parseAmount(ap[1]), 1);
  }
  let total: number | null = null;
  for (const [v, w] of votes) if (total === null || w > votes.get(total)! || (w === votes.get(total)! && v > total)) total = v;

  // OCR: what each printed total could really be. A bank amount is exact, so
  // a unique transaction matching one of these is good evidence (see
  // matchByAlternatives). Garbled totals ("R8€.57") count here too.
  let total_alternatives: number[] | undefined;
  if (ocr) {
    const alt = new Map<number, number>();
    const re = new RegExp(String.raw`(${DIGITISH}{1,5}[.,]${DIGITISH}{2})\s*$`);
    for (const l of lines) {
      const isTotal = /\bTOTAL\b/i.test(l) && !/SUB\s*-?TOTAL|SAVING|VAT|TAX|ITEMS|AGREE/i.test(l);
      if (!isTotal && !/APPROVED\s+\S*MOUNT|ELECTRONIC PAYMENT/i.test(l)) continue;
      const m = l.replace(/\s+/g, '').match(re);
      for (const c of m ? amountCandidates(m[1]) : []) {
        if (c.cost <= 2 && c.cents > 0 && (!alt.has(c.cents) || alt.get(c.cents)! > c.cost)) alt.set(c.cents, c.cost);
      }
    }
    total_alternatives = [...alt].sort((a, b) => a[1] - b[1]).map(([c]) => c / 100);
    if (total === null && total_alternatives.length) total = total_alternatives[0];
  }

  const raw: RawLine[] = [];
  let pendingBarcode: string | null = null;
  const amountRe = ocr ? OCR_AMOUNT_AT_END : AMOUNT_AT_END;
  for (const l of lines) {
    const g = l.match(GTIN);
    if (g) {
      // OCR can mangle digits into lookalikes; only keep a clean barcode.
      pendingBarcode = ocr ? repairGtin(g[1], known?.barcode) : /^\d{8,14}$/.test(g[1]) ? g[1] : null;
      continue;
    }
    // "4 @ R3.89" under a line: that line was 4 of them.
    const multi = l.match(/^(\d+(?:[.,]\d+)?)\s*(?:@|X)\s*[Rr]?\s?\d/i);
    if (multi && raw.length > 0) {
      const last = [...raw].reverse().find((r) => !r.promo);
      if (last) last.quantity = parseFloat(multi[1].replace(',', '.'));
      continue;
    }
    if (NOT_AN_ITEM.test(l)) continue;
    const m = l.match(amountRe);
    if (!m) continue;
    let name = m[1].replace(/^\d{6,}\s*/, '').replace(/[.\s]+$/, '').trim();
    // VAT summary rows ("A 0% R0.00 R84.97", "15% R29.97 R229.79") carry
    // more amounts or a percentage in the "name" — never a product.
    if (/%/.test(name) || /\d[.,]\d{2}/.test(name) || !name) continue;
    let token = m[2].replace(/\s+/g, '');
    if (/-\s*[A-Z*#]?$/.test(l) && !token.startsWith('-')) token = '-' + token; // "PROMO 5.00-"
    let quantity = 1;
    const qty = name.match(/^(\d{1,2})\s*(?:X|@)\s+(.*)$/i);
    if (qty) {
      quantity = parseInt(qty[1], 10);
      name = qty[2];
    }
    // Promotions (XTRASAVE, PROMO, ...) reduce the previous item rather
    // than being an item of their own.
    const promo = token.startsWith('-') && raw.length > 0 && /PROMO|DISC|SAVE|LESS|OFF/i.test(name);
    raw.push({ name, quantity, token, barcode: promo ? null : pendingBarcode, promo });
    if (!promo) pendingBarcode = null;
  }

  // Amounts: exact for PDF text. For OCR, lookalike characters are mapped
  // back, and a known product's earlier price wins when the reading could
  // be it ("R36.5%" for a product last bought at R36.99).
  let cents: number[];
  if (ocr) {
    cents = raw.map((r) => {
      const cands = amountCandidates(r.token);
      if (!cands.length) return NaN;
      const before = r.barcode && known ? known.prices(r.barcode).map((p) => Math.round(p * r.quantity * 100)) : [];
      if (!before.length) return cands[0].cents;
      // The barcode passed its check digit, so the product is certain: its
      // earlier price wins if the reading is at most two digits off it.
      const read = String(Math.abs(cands[0].cents));
      const near = before.find((p) => {
        const s = String(Math.abs(p));
        return s.length === read.length && [...s].filter((ch, k) => ch !== read[k]).length <= 2 && Math.sign(p) === Math.sign(cands[0].cents);
      });
      return near ?? cands[0].cents;
    });
  } else {
    cents = raw.map((r) => {
      const n = parseAmount(r.token.replace(/^(-?)r/, '$1R'));
      return n === null ? NaN : Math.round((r.token.startsWith('-') || r.token.endsWith('-') ? -Math.abs(n) : n) * 100);
    });
  }

  const items: ExtractedItem[] = [];
  raw.forEach((r, i) => {
    if (!Number.isFinite(cents[i])) return;
    const amount = cents[i] / 100;
    if (r.promo && items.length > 0) {
      items[items.length - 1].amount = Math.round((items[items.length - 1].amount + amount) * 100) / 100;
      return;
    }
    items.push({ name: r.name, quantity: r.quantity, amount, barcode: r.barcode });
  });

  // Lines adding up to one of the total's plausible readings confirm it.
  if (ocr && total_alternatives?.length) {
    const sum = Math.round(items.reduce((a, i) => a + i.amount, 0) * 100) / 100;
    if (sum !== total && total_alternatives.includes(sum)) total = sum;
  }

  return { merchant: lines[0] ?? null, date, total, total_alternatives, items };
}
