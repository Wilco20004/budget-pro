import { ParsedMail } from 'mailparser';
import { parseAmount, parseDate } from '../importers/parse';
import { ExtractedItem, ExtractedReceipt } from '../receipts/parseText';
import { htmlToLines } from './htmlText';

// Checkers Sixty60 "invoice for order …" emails. As lines (htmlToLines):
//
//   Date placed: 12 Sep, 2026 12:00 PM
//   Product Detail / Price (per item) / Total
//   Some Product 500g          ← name ("* " prefix = zero-rated for VAT)
//   Qty 2                      ← or "Qty 1 (0.36 kg)" for weighed items
//   V                          ← Vitality HealthyFood marker (optional)
//   R 12.99                    ← price per item
//   R 25.98                    ← line total
//   ** Buy 2 For R22 **        ← deal on the item(s) above …
//   - R 3.98                   ← … and its discount
//   *These items are zero-rated for VAT / Product sub-total
//   Invoice Summary: Product total, delivery fees, discounts, Total
//   Payment Summary: Payment made at order placement R x   ← the card charge
//                    Wallet payment made at order placement R y
//                    or Credit applied to wallet - R z
//
// The bank shows the card charge, which differs from the order total when
// the Sixty60 wallet paid part of it, or when the order came out cheaper
// than charged and the difference went back to the wallet. Those appear as
// a wallet line, so the lines always add up to what the bank took.

const MONEY = /^(-\s*)?R\s*(\d[\d,]*\.\d{2})$/;

function money(line: string | undefined): number | null {
  const m = line?.match(MONEY);
  if (!m) return null;
  const n = parseAmount(m[2]);
  return n === null ? null : m[1] ? -n : n;
}

/** The amount on the line after `label` (first occurrence at or after `from`). */
function after(lines: string[], label: RegExp, from = 0): number | null {
  for (let i = from; i < lines.length - 1; i++) if (label.test(lines[i])) return money(lines[i + 1]);
  return null;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function isSixty60(mail: ParsedMail): boolean {
  return /sixty60/i.test(`${mail.from?.text ?? ''} ${mail.subject ?? ''}`) && Boolean(mail.html);
}

export function parseSixty60(mail: ParsedMail): ExtractedReceipt | null {
  if (!isSixty60(mail)) return null;
  const lines = htmlToLines(mail.html || '').split('\n');

  const placed = lines.join('\n').match(/Date placed:\s*(\d{1,2}) ([A-Za-z]{3,9}),? (\d{4})/i);
  const date = placed ? parseDate(`${placed[1]} ${placed[2]} ${placed[3]}`) : null;

  const start = lines.findIndex((l) => /^Product Detail$/i.test(l));
  if (start < 0) return null;
  const items: (ExtractedItem & { amounts: number[] })[] = [];
  // "Buy 2 For R75" can cover two different products listed above it; the
  // discount is shared across them (by value) so neither gets a silly price.
  let dealUnits: number | null = null;
  let dealStart = 0;
  const applyDiscount = (amt: number) => {
    const group: typeof items = [];
    if (dealUnits) {
      // At least N units back, and every neighbouring item of the same brand
      // (a deal applied twice covers 4 Rhodes juices, not 2).
      const brand = (it: { name: string }) => it.name.split(' ')[0].toLowerCase();
      const lastBrand = brand(items[items.length - 1]);
      let units = 0;
      for (let k = items.length - 1; k >= dealStart && (units < dealUnits || brand(items[k]) === lastBrand); k--) {
        group.unshift(items[k]);
        units += items[k].quantity;
      }
    }
    if (!group.length && items.length) group.push(items[items.length - 1]);
    const base = group.reduce((a, it) => a + it.amount, 0);
    let left = Math.round(amt * 100);
    group.forEach((it, k) => {
      const share = k === group.length - 1 ? left : Math.round((Math.round(amt * 100) * it.amount) / (base || 1));
      it.amount = r2(it.amount + share / 100);
      left -= share;
    });
    dealUnits = null;
    dealStart = items.length;
  };
  let i = start + 1;
  while (i < lines.length && /^(Price \(per item\)|Total)$/i.test(lines[i])) i++;
  for (; i < lines.length; i++) {
    const l = lines[i];
    if (/^\*These items|^Product sub-total/i.test(l)) break;
    const last = items[items.length - 1];
    const qty = l.match(/^Qty\s+(\d+(?:[.,]\d+)?)/i);
    if (qty && last) {
      last.quantity = parseFloat(qty[1].replace(',', '.'));
      continue;
    }
    if (/^V$/.test(l)) continue;
    if (/^\*\*.*\*\*$/.test(l)) {
      // Deal name; its "- R x" follows. "Buy N …" spans N units above.
      const n = l.match(/Buy\s+(\d+)/i);
      dealUnits = n ? parseInt(n[1], 10) : null;
      continue;
    }
    const amt = money(l);
    if (amt !== null) {
      if (!last) continue;
      if (amt < 0) applyDiscount(amt);
      else if (last.amounts.length < 2) {
        last.amounts.push(amt);
        last.amount = amt; // the second amount (line total) replaces the unit price
      }
      continue;
    }
    items.push({ name: l.replace(/^\*\s*/, '').trim(), quantity: 1, amount: 0, amounts: [] });
  }
  const products = items.filter((it) => it.amounts.length > 0).map(({ amounts: _a, ...it }) => it);
  if (!products.length) return null;

  const summary = lines.findIndex((l) => /^Invoice Summary$/i.test(l));
  const productTotal = after(lines, /^Product total$/i, Math.max(summary, 0));
  const orderTotal = after(lines, /^Total$/i, Math.max(summary, 0));
  const card = after(lines, /^Payment made at order placement$/i);

  const out: ExtractedItem[] = [...products];
  // Delivery fee less its discount, minimum-spend saving: whatever the order
  // total adds on top of the products.
  if (productTotal !== null && orderTotal !== null && Math.abs(orderTotal - productTotal) > 0.005) {
    out.push({ name: 'Sixty60 delivery fee', quantity: 1, amount: r2(orderTotal - productTotal) });
  }
  const total = orderTotal ?? productTotal ?? r2(products.reduce((a, p) => a + p.amount, 0));
  if (card !== null && Math.abs(card - total) > 0.005) {
    out.push(
      card > total
        ? { name: 'Sixty60 wallet credit', quantity: 1, amount: r2(card - total) }
        : { name: 'Paid from Sixty60 wallet', quantity: 1, amount: r2(card - total) }
    );
  }
  return { merchant: 'Checkers Sixty60', date, total: card ?? total, items: out };
}
