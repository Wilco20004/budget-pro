let currency = 'R';

export function setCurrency(symbol: string) {
  currency = symbol || 'R';
}

const nf = new Intl.NumberFormat('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nf0 = new Intl.NumberFormat('en-ZA', { maximumFractionDigits: 0 });

/** "R 1 234.56" — sign in front of the symbol for negatives. */
export function money(n: number | null | undefined, opts: { whole?: boolean; signed?: boolean } = {}): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const f = opts.whole ? nf0 : nf;
  const s = f.format(Math.abs(n)).replace(/,/g, '.').replace(/ /g, ' ');
  const sign = n < 0 ? '−' : opts.signed && n > 0 ? '+' : '';
  return `${sign}${currency} ${s}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function shortDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

export function dayMonth(iso: string): string {
  const [, m, d] = iso.slice(0, 10).split('-').map(Number);
  return `${d} ${MONTHS[m - 1]}`;
}

export function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** No crypto.randomUUID — the add-on is usually opened over plain HTTP on a
 *  LAN IP, where it's undefined. This is only for React keys. */
let keySeq = 0;
export function tempKey(): string {
  keySeq += 1;
  return `${Date.now().toString(36)}-${keySeq}-${Math.random().toString(36).slice(2, 8)}`;
}

export const STATUS_LABEL: Record<string, string> = {
  uncategorized: 'Uncategorised',
  needs_slip: 'Needs slip',
  reconciled: 'Reconciled',
  ignored: 'Ignored',
};

/** Why a slip-required transaction was reconciled without a slip. */
export const NO_SLIP_LABEL: Record<string, string> = {
  lost: 'slip lost',
  single_category: 'all one category',
};

export const STATUS_ICON: Record<string, string> = {
  uncategorized: '●',
  needs_slip: '🧾',
  reconciled: '✓',
  ignored: '–',
};
