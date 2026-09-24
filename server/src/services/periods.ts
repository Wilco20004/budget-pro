import { getSettings, WeekendRule } from '../settings';

// Budget periods run payday to payday: with period_start_day = 25 the
// "September" period is 25 Aug – 24 Sep. Dates are plain YYYY-MM-DD strings
// throughout (no time zones — a bank statement date is a calendar date).

export interface Period {
  /** First day of the period, YYYY-MM-DD — also the period's id. */
  start: string;
  /** Last day of the period (inclusive). */
  end: string;
  /** Human label, e.g. "25 Aug – 24 Sep 2026". */
  label: string;
  days: number;
}

export function toIso(y: number, m: number, d: number): string {
  // m is 0-based like Date
  const dt = new Date(Date.UTC(y, m, d));
  return dt.toISOString().slice(0, 10);
}

export function parseIso(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function addDays(s: string, n: number): string {
  const dt = parseIso(s);
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

export function todayIso(): string {
  const d = new Date();
  return toIso(d.getFullYear(), d.getMonth(), d.getDate());
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
}

/** The nominal payday in a month, moved off weekends per the rule. A start
 *  day of 31 means "last day of the month" in short months. */
function periodStartForMonth(y: number, m: number, startDay: number, rule: WeekendRule): string {
  const day = Math.min(startDay, daysInMonth(y, m));
  const dt = new Date(Date.UTC(y, m, day));
  const dow = dt.getUTCDay(); // 0 Sun, 6 Sat
  if (rule === 'previous_business_day') {
    if (dow === 6) dt.setUTCDate(dt.getUTCDate() - 1);
    if (dow === 0) dt.setUTCDate(dt.getUTCDate() - 2);
  } else if (rule === 'next_business_day') {
    if (dow === 6) dt.setUTCDate(dt.getUTCDate() + 2);
    if (dow === 0) dt.setUTCDate(dt.getUTCDate() + 1);
  }
  return dt.toISOString().slice(0, 10);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmt(s: string, withYear: boolean): string {
  const d = parseIso(s);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}${withYear ? ' ' + d.getUTCFullYear() : ''}`;
}

function build(start: string, nextStart: string): Period {
  const end = addDays(nextStart, -1);
  const days = Math.round((parseIso(nextStart).getTime() - parseIso(start).getTime()) / 86400000);
  const sameYear = start.slice(0, 4) === end.slice(0, 4);
  return { start, end, days, label: `${fmt(start, !sameYear)} – ${fmt(end, true)}` };
}

/** The period containing the given date. */
export function periodFor(date: string, settings = getSettings()): Period {
  const { period_start_day: day, weekend_rule: rule } = settings;
  const d = parseIso(date);
  let y = d.getUTCFullYear();
  let m = d.getUTCMonth();
  // The weekend rule can pull next month's start back into this month (or
  // push this month's start forward), so check the neighbours too.
  let start = periodStartForMonth(y, m, day, rule);
  if (date < start) {
    m -= 1;
    if (m < 0) { m = 11; y -= 1; }
    start = periodStartForMonth(y, m, day, rule);
  }
  let ny = y, nm = m + 1;
  if (nm > 11) { nm = 0; ny += 1; }
  let next = periodStartForMonth(ny, nm, day, rule);
  if (date >= next) {
    start = next;
    nm += 1;
    if (nm > 11) { nm = 0; ny += 1; }
    next = periodStartForMonth(ny, nm, day, rule);
  }
  return build(start, next);
}

export function currentPeriod(): Period {
  return periodFor(todayIso());
}

export function previousPeriod(p: Period): Period {
  return periodFor(addDays(p.start, -1));
}

export function nextPeriod(p: Period): Period {
  return periodFor(addDays(p.end, 1));
}

/** The last `count` periods ending with (and including) `anchor`, oldest first. */
export function recentPeriods(count: number, anchor: Period = currentPeriod()): Period[] {
  const out: Period[] = [anchor];
  while (out.length < count) out.unshift(previousPeriod(out[0]));
  return out;
}

/** Accepts a period id (its start date) or any date inside it. */
export function resolvePeriod(input?: unknown): Period {
  if (typeof input === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input)) return periodFor(input);
  return currentPeriod();
}
