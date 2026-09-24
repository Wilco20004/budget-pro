import { parseDate } from '../importers/parse';

// Tesseract misreads digits on small e-slip fonts in a consistent way: 9
// comes out as 5, 8 or "%", 6 as "€" or "¢", 1 as "i". A price like R27.99
// arrives as "R27.8%". Characters that can't be digits are mapped back;
// real digits are only changed where there's evidence — a barcode's check
// digit, or a price the product was bought at before. (Forcing the lines
// to add up to the TOTAL was tried: the total is misread the same way, and
// many wrong combinations add up, so it gave confident wrong answers.)

/** Characters that may stand in for digits, and what they may really be.
 *  Cost 0 = forced (not a digit, must be one); 1 = a digit read as another. */
const CHAR_OPTIONS: Record<string, [string, number][]> = {
  '0': [['0', 0], ['8', 1]],
  '1': [['1', 0], ['7', 1]],
  '2': [['2', 0]],
  '3': [['3', 0], ['8', 1]],
  '4': [['4', 0]],
  '5': [['5', 0], ['9', 1], ['6', 1]],
  '6': [['6', 0], ['8', 1], ['5', 1]],
  '7': [['7', 0], ['1', 1]],
  '8': [['8', 0], ['9', 1], ['6', 1], ['3', 1]],
  '9': [['9', 0], ['8', 1]],
  '%': [['9', 0], ['8', 0.5]],
  '€': [['6', 0], ['8', 0.5]],
  '¢': [['6', 0]],
  '&': [['6', 0.2], ['8', 0.2]],
  $: [['5', 0.2], ['9', 0.4]],
  S: [['5', 0.2], ['9', 0.4]],
  s: [['5', 0.2], ['9', 0.4]],
  B: [['8', 0]],
  Z: [['2', 0]],
  z: [['2', 0]],
  O: [['0', 0]],
  o: [['0', 0]],
  i: [['1', 0]],
  I: [['1', 0]],
  l: [['1', 0]],
  '|': [['1', 0]],
};

/** A character class for "a digit, or something OCR prints instead of one". */
export const DIGITISH = '[0-9%€¢&$SsBZzOoiIl|]';

const MAX_CANDIDATES = 48;

export interface Candidate {
  cents: number;
  cost: number;
}

function expand(chars: string): { s: string; cost: number }[] {
  let partial = [{ s: '', cost: 0 }];
  for (const ch of chars) {
    const opts = CHAR_OPTIONS[ch];
    if (!opts) return [];
    partial = partial
      .flatMap((p) => opts.map(([d, c]) => ({ s: p.s + d, cost: p.cost + c })))
      .sort((a, b) => a.cost - b.cost)
      .slice(0, MAX_CANDIDATES);
  }
  return partial;
}

/** Every value a price token ("R27.8%", "Ri5.5%", "R15.855") could really
 *  be, cheapest first. Negative for "-R5.00". */
export function amountCandidates(token: string): Candidate[] {
  const t = token.replace(/\s+/g, '');
  const neg = /^-/.test(t) || /-$/.test(t);
  const m = t.replace(/^-/, '').replace(/-$/, '').replace(/^[Rr]/, '').match(/^(.+?)[.,](.{2,3})$/);
  if (!m) return [];
  // A stray third decimal ("15.855") is noise on one of the last two.
  const decs = m[2].length === 3 ? [{ d: m[2].slice(0, 2), c: 0.5 }, { d: m[2][0] + m[2][2], c: 0.5 }] : [{ d: m[2], c: 0 }];
  const ints = expand(m[1]);
  const out = new Map<number, number>();
  for (const dv of decs) {
    for (const dec of expand(dv.d)) {
      for (const int of ints) {
        const cents = parseInt(int.s, 10) * 100 + parseInt(dec.s, 10);
        // Shop prices mostly end in 9 — a tie-breaker, not a rule.
        const cost = int.cost + dec.cost + dv.c - (dec.s.endsWith('9') ? 0.3 : 0);
        const v = neg ? -cents : cents;
        if (!out.has(v) || out.get(v)! > cost) out.set(v, cost);
      }
    }
  }
  return [...out.entries()]
    .map(([cents, cost]) => ({ cents, cost }))
    .sort((a, b) => a.cost - b.cost)
    .slice(0, MAX_CANDIDATES);
}

/** EAN-8/12/13/14 check digit. */
export function validGtin(code: string): boolean {
  if (!/^\d{8}$|^\d{12,14}$/.test(code)) return false;
  const d = code.split('').map(Number);
  const check = d.pop()!;
  const sum = d.reverse().reduce((a, x, i) => a + x * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

/** A barcode as OCR read it ("6001045058054") made valid again: lookalike
 *  characters are mapped, then any single digit is tried against the check
 *  digit. Several fixes can pass the check, so one is only taken when it's
 *  unique, or the only one already in the product database — which also
 *  allows two typical misreads (5→9 twice) for products bought before. */
export function repairGtin(raw: string, isKnown: (code: string) => boolean = () => false): string | null {
  const forced = expand(raw)[0]?.s;
  if (!forced) return null;
  if (validGtin(forced)) return forced;
  const fixes = new Set<string>();
  for (let i = 0; i < forced.length; i++) {
    for (let d = 0; d <= 9; d++) {
      const v = forced.slice(0, i) + d + forced.slice(i + 1);
      if (v !== forced && validGtin(v)) fixes.add(v);
    }
  }
  const known = [...fixes].filter(isKnown);
  if (known.length === 1) return known[0];
  if (fixes.size === 1 && !known.length) return [...fixes][0];
  // Two lookalike misreads, only accepted when it lands on a known product.
  const alts = (i: number) => (CHAR_OPTIONS[forced[i]] ?? []).filter(([d, c]) => c > 0 && d !== forced[i]).map(([d]) => d);
  const twice = new Set<string>();
  for (let i = 0; i < forced.length; i++) {
    for (const a of alts(i)) {
      for (let j = i + 1; j < forced.length; j++) {
        for (const b of alts(j)) {
          const v = forced.slice(0, i) + a + forced.slice(i + 1, j) + b + forced.slice(j + 1);
          if (validGtin(v) && isKnown(v)) twice.add(v);
        }
      }
    }
  }
  return twice.size === 1 ? [...twice][0] : null;
}

/** The slip date from several reads of it (Checkers prints "Date Time Store"
 *  rows three times). Each read is expanded like a price; impossible dates
 *  (in the future, or years ago) are dropped, and the date most reads agree
 *  on wins. */
export function resolveDate(reads: string[], now = new Date()): string | null {
  const latest = new Date(now.getTime() + 86400000).toISOString().slice(0, 10);
  const earliest = new Date(now.getTime() - 2 * 365 * 86400000).toISOString().slice(0, 10);
  const score = new Map<string, number>();
  for (const raw of reads) {
    const m = raw.match(new RegExp(`^(${DIGITISH}{1,2})([-/.])(${DIGITISH}{1,2})\\2(${DIGITISH}{2,4})$`));
    if (!m) continue;
    const best = new Map<string, number>();
    for (const d of expand(m[1]))
      for (const mo of expand(m[3]))
        for (const y of expand(m[4])) {
          const iso = parseDate(`${d.s}/${mo.s}/${y.s}`);
          if (!iso || iso > latest || iso < earliest) continue;
          const cost = d.cost + mo.cost + y.cost;
          if (!best.has(iso) || best.get(iso)! > cost) best.set(iso, cost);
        }
    for (const [iso, cost] of best) score.set(iso, (score.get(iso) ?? 0) + 1 / (1 + cost));
  }
  let pick: string | null = null;
  for (const [iso, s] of score) {
    if (!pick || s > score.get(pick)! || (s === score.get(pick)! && iso > pick)) pick = iso;
  }
  return pick;
}
