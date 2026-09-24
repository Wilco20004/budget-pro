import { parseAmount, parseDate } from '../importers/parse';

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
  items: ExtractedItem[];
}

// Lines on a till slip that carry an amount but aren't a product.
const NOT_AN_ITEM =
  /\b(SUB\s*-?TOTAL|TOTAL|BALANCE|CHANGE|CASH|CARD|TENDER|VAT|TAX|AMOUNT DUE|DUE|SAVINGS?|YOU SAVED|DISCOUNT TOTAL|ROUNDING|POINTS|REWARDS?|SMART ?SHOPPER|VITALITY|EBUCKS|APPROVED|AUTH|CREDIT|DEBIT|MASTERCARD|VISA|ITEMS?\s*:?\s*\d|QTY|TEL|VAT NO|INVOICE|ELECTRONIC PAYMENT|PAYMENT|GROSS|NET|SINCE JOINING)\b/i;

// Amount at the end of a line: "R39.99", "39.99", "-R10.00", "R39.99A" (VAT
// flag), "5.00-". OCR sometimes reads the R as r.
const AMOUNT_AT_END = /^(.*?[A-Za-z].*?)\s+(-?[Rr]?\s?\d{1,5}[.,]\d{2})(?:\s*-)?\s*[A-Z*#]?$/;
const GTIN = /^Item\s*\/\s*G\s*T\s*I\s*N\s*[:.]?\s*(\S+)/i;

/** Pulls merchant/date/total/lines out of OCR or PDF text. Till slips are
 *  "NAME ........ 12.99" (sometimes with a trailing VAT flag letter). Checkers
 *  / Shoprite print "Item/GTIN <barcode>" above each product and multi-buys
 *  as "4 @ R3.89" under the line. */
export function parseReceiptText(text: string): ExtractedReceipt {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  // Prefer the "Date Time Store ..." row's value (DD/MM/YY); else the first date anywhere.
  let date: string | null = null;
  const dateRe = /(\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}|\d{1,2} [A-Za-z]{3,9} \d{4})/;
  const headerIdx = lines.findIndex((l) => /^Date\s+Time/i.test(l));
  const candidates = headerIdx >= 0 ? [...lines.slice(headerIdx + 1, headerIdx + 2), ...lines] : lines;
  for (const l of candidates) {
    const m = l.match(dateRe);
    const d = m ? parseDate(m[1]) : null;
    if (d) {
      date = d;
      break;
    }
  }

  let total: number | null = null;
  for (const l of lines) {
    if (/\bTOTAL\b/i.test(l) && !/SUB\s*-?TOTAL|SAVING|VAT|TAX|ITEMS|AGREE/i.test(l)) {
      const m = l.match(/(-?[Rr]?\s?\d[\d ,]*[.,]\d{2})\s*$/);
      const n = m ? parseAmount(m[1]) : null;
      if (n !== null && (total === null || n > total)) total = n;
    }
  }
  // Card slips also print the authorised amount — a good fallback (and
  // the most reliable number on the slip, since it's printed twice).
  if (total === null) {
    for (const l of lines) {
      const m = l.match(/APPROVED\s+AMOUNT\s*:?\s*([Rr]?\s?\d[\d ,]*[.,]\d{2})/i);
      const n = m ? parseAmount(m[1]) : null;
      if (n !== null) {
        total = n;
        break;
      }
    }
  }

  const items: ExtractedItem[] = [];
  let pendingBarcode: string | null = null;
  for (const l of lines) {
    const g = l.match(GTIN);
    if (g) {
      // OCR can mangle digits into lookalikes; only keep a clean barcode.
      pendingBarcode = /^\d{8,14}$/.test(g[1]) ? g[1] : null;
      continue;
    }
    // "4 @ R3.89" under a line: that line was 4 of them.
    const multi = l.match(/^(\d+(?:[.,]\d+)?)\s*(?:@|X)\s*[Rr]?\s?\d/i);
    if (multi && items.length > 0) {
      items[items.length - 1].quantity = parseFloat(multi[1].replace(',', '.'));
      continue;
    }
    if (NOT_AN_ITEM.test(l)) continue;
    const m = l.match(AMOUNT_AT_END);
    if (!m) continue;
    let name = m[1].replace(/^\d{6,}\s*/, '').replace(/[.\s]+$/, '').trim();
    // VAT summary rows ("A 0% R0.00 R84.97", "15% R29.97 R229.79") carry
    // more amounts or a percentage in the "name" — never a product.
    if (/%/.test(name) || /\d[.,]\d{2}/.test(name)) continue;
    let amount = parseAmount(m[2].replace(/^(-?)r/, '$1R'));
    if (amount === null || !name) continue;
    if (/-\s*[A-Z*#]?$/.test(l)) amount = -Math.abs(amount); // "PROMO 5.00-"
    let quantity = 1;
    const qty = name.match(/^(\d{1,2})\s*(?:X|@)\s+(.*)$/i);
    if (qty) {
      quantity = parseInt(qty[1], 10);
      name = qty[2];
    }
    // Promotions (XTRASAVE, PROMO, ...) reduce the previous item rather
    // than being an item of their own.
    if (amount < 0 && items.length > 0 && /PROMO|DISC|SAVE|LESS|OFF/i.test(name)) {
      items[items.length - 1].amount = Math.round((items[items.length - 1].amount + amount) * 100) / 100;
      continue;
    }
    items.push({ name, quantity, amount, barcode: pendingBarcode });
    pendingBarcode = null;
  }

  return { merchant: lines[0] ?? null, date, total, items };
}
