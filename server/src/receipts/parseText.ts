import { parseAmount, parseDate } from '../importers/parse';

export interface ExtractedItem {
  name: string;
  quantity: number;
  amount: number;
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
  /\b(SUB\s*-?TOTAL|TOTAL|BALANCE|CHANGE|CASH|CARD|TENDER|VAT|TAX|AMOUNT DUE|DUE|SAVINGS?|YOU SAVED|DISCOUNT TOTAL|ROUNDING|POINTS|REWARDS?|XTRA ?SAVINGS|SMART ?SHOPPER|VITALITY|EBUCKS|APPROVED|AUTH|CREDIT|DEBIT|MASTERCARD|VISA|ITEMS?\s*:?\s*\d|QTY|TEL|VAT NO|INVOICE)\b/i;

/** Pulls merchant/date/total/lines out of OCR or PDF text. Till slips are
 *  "NAME ........ 12.99" (sometimes with a trailing VAT flag letter), with
 *  multi-buy lines like "2 @ 15.99" on the line under the name. */
export function parseReceiptText(text: string): ExtractedReceipt {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  let date: string | null = null;
  for (const l of lines) {
    const m = l.match(/(\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}|\d{1,2} [A-Za-z]{3,9} \d{4})/);
    if (m) {
      const d = parseDate(m[1]);
      if (d) {
        date = d;
        break;
      }
    }
  }

  let total: number | null = null;
  for (const l of lines) {
    if (/\bTOTAL\b/i.test(l) && !/SUB\s*-?TOTAL|SAVING|VAT|TAX|ITEMS/i.test(l)) {
      const m = l.match(/(-?\d[\d ,]*[.,]\d{2})\s*$/);
      const n = m ? parseAmount(m[1]) : null;
      if (n !== null && (total === null || n > total)) total = n;
    }
  }

  const items: ExtractedItem[] = [];
  const amountAtEnd = /^(.*?[A-Za-z].*?)\s+(-?R?\s?\d{1,5}[.,]\d{2})(?:\s*-)?\s*[A-Z*#]?$/;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (NOT_AN_ITEM.test(l)) continue;
    const m = l.match(amountAtEnd);
    if (!m) continue;
    let name = m[1].replace(/^\d{6,}\s*/, '').replace(/[.\s]+$/, '').trim();
    let amount = parseAmount(m[2]);
    if (amount === null || !name) continue;
    if (/-\s*[A-Z*#]?$/.test(l)) amount = -Math.abs(amount); // "PROMO 5.00-"
    let quantity = 1;
    // "2 @ 15.99  31.98" or "2 X 15.99" — the name was on the line above.
    const multi = name.match(/^(\d+(?:[.,]\d+)?)\s*(?:@|X)\s*\d/i);
    if (multi && items.length > 0 && i > 0) {
      const prev = items[items.length - 1];
      prev.quantity = parseFloat(multi[1].replace(',', '.'));
      prev.amount = amount;
      continue;
    }
    const qty = name.match(/^(\d{1,2})\s*(?:X|@)\s+(.*)$/i);
    if (qty) {
      quantity = parseInt(qty[1], 10);
      name = qty[2];
    }
    // Promotions/discount lines reduce the previous item rather than being
    // an item of their own.
    if (amount < 0 && items.length > 0 && /PROMO|DISC|SAVE|LESS|OFF/i.test(name)) {
      items[items.length - 1].amount += amount;
      continue;
    }
    items.push({ name, quantity, amount });
  }

  return { merchant: lines[0] ?? null, date, total, items };
}
