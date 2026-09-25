import { db } from '../db';
import { getSettings } from '../settings';
import { paydownByCategory } from './debts';
import { periodKpis } from './kpis';
import { addDays, Period, previousPeriod, todayIso } from './periods';

// Who pays what: each account's spending by category and payment method,
// and — for a household where one person pays most of the shared bills —
// how much the others should transfer to even it out.

const r2 = (n: number) => Math.round(n * 100) / 100;

export type Method = 'card' | 'debit_order' | 'eft' | 'cash' | 'charges' | 'transfer' | 'other';
export const METHODS: Method[] = ['card', 'debit_order', 'eft', 'cash', 'charges', 'transfer', 'other'];

/** How the money moved, read from the statement wording (FNB and Discovery).
 *  A money-out line with no recognisable wording is a card purchase: both
 *  banks print card lines as just the merchant. */
export function paymentMethod(description: string, amount: number, accountType: string): Method {
  const d = description.trim();
  if (/^(debit order|magtape debit|debicheck|byc debit)|internal d\/o/i.test(d)) return 'debit_order';
  if (/inter account transfer|^transfer\b|^payment thank you|^miles transfer/i.test(d)) return 'transfer';
  if (/cash withdrawal|\batm\b|cash deposit/i.test(d)) return 'cash';
  if (
    /^(bank charge|card fee|loan fee|fee\b|interest\b|int on debit|activity based|cpp insurance|fnb life|txn declined|intl payment fee|monthly account fee)/i.test(d)
  )
    return 'charges';
  if (/^(eft\b|fnb app (payment|transfer)|scheduled payment|payshap|fnb ob pmt|payment to|online banking|credit voucher)|\bcredit\b.*\bref|^payment$/i.test(d))
    return 'eft';
  if (/^(pos purchase|online\b)/i.test(d)) return 'card';
  if (amount < 0) return 'card';
  if (accountType === 'credit' || accountType === 'loan') return 'transfer';
  return 'other';
}

interface Line {
  id: string;
  account_id: string;
  date: string;
  description: string;
  amount: number;
  split_amount: number | null;
  category_id: string | null;
  kind: string | null;
  top_id: string | null;
  top_name: string | null;
  top_icon: string | null;
  personal: number;
}

/** Every transaction line of a period with its (top-level) category. A
 *  split transaction gives one line per split; the unsplit rest is a line
 *  with no category. */
function lines(from: string, to: string, accountIds?: string[]): Line[] {
  const rows = db
    .prepare(
      `SELECT t.id, t.account_id, t.date, t.description, t.amount, s.amount AS split_amount, s.category_id, c.kind,
              COALESCE(p.id, c.id) AS top_id, COALESCE(p.name, c.name) AS top_name, COALESCE(p.icon, c.icon) AS top_icon,
              MAX(COALESCE(c.personal, 0), COALESCE(p.personal, 0)) AS personal
       FROM transactions t
       LEFT JOIN transaction_splits s ON s.transaction_id = t.id
       LEFT JOIN categories c ON c.id = s.category_id
       LEFT JOIN categories p ON p.id = c.parent_id
       WHERE t.date BETWEEN ? AND ? AND t.ignored = 0`
    )
    .all(from, to) as Line[];
  const out: Line[] = [];
  const splitTotal = new Map<string, number>();
  for (const r of rows) {
    if (accountIds && !accountIds.includes(r.account_id)) continue;
    if (r.category_id) {
      out.push(r);
      splitTotal.set(r.id, (splitTotal.get(r.id) ?? 0) + (r.split_amount ?? 0));
    }
  }
  const seen = new Set<string>();
  for (const r of rows) {
    if (accountIds && !accountIds.includes(r.account_id)) continue;
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    const rest = r2(r.amount - (splitTotal.get(r.id) ?? 0));
    if (Math.abs(rest) > 0.009) out.push({ ...r, split_amount: rest, category_id: null, kind: null, top_id: null, top_name: null, top_icon: null, personal: 0 });
  }
  return out;
}

interface AccountRow {
  id: string;
  name: string;
  type: string;
  owner_id: string | null;
}

const emptyMethods = () => Object.fromEntries(METHODS.map((m) => [m, 0])) as Record<Method, number>;

/** Per account: money in and out, and the spending by category × method. */
export function accountBreakdown(period: Period) {
  const accounts = db.prepare('SELECT id, name, type, owner_id FROM accounts ORDER BY name').all() as AccountRow[];
  const owners = memberNames();
  const all = lines(period.start, period.end);
  return {
    period,
    methods: METHODS,
    accounts: accounts
      .map((a) => {
        const mine = all.filter((l) => l.account_id === a.id);
        const byCat = new Map<string, { category_id: string | null; name: string; icon: string | null; kind: string; total: number; methods: Record<Method, number> }>();
        const byMethod = emptyMethods();
        let moneyIn = 0;
        let moneyOut = 0;
        let spending = 0;
        let transfers = 0;
        let income = 0;
        const counted = new Set<string>();
        for (const l of mine) {
          if (!counted.has(l.id)) {
            counted.add(l.id);
            if (l.amount > 0) moneyIn += l.amount;
            else moneyOut -= l.amount;
          }
          const amt = l.split_amount ?? 0;
          const kind = l.kind ?? 'uncategorised';
          if (kind === 'income' || kind === 'loan') {
            income += amt;
            continue;
          }
          if (kind === 'transfer') {
            transfers -= amt;
            continue;
          }
          // Spending: expense and savings lines, and whatever isn't filed yet.
          // A refund (money in) in a spending category brings it down.
          if (kind === 'uncategorised' && amt > 0) continue;
          const m = paymentMethod(l.description, l.amount, a.type);
          const key = l.top_id ?? '';
          const row = byCat.get(key) ?? {
            category_id: l.top_id,
            name: l.top_name ?? 'Uncategorised',
            icon: l.top_icon,
            kind: l.kind ?? 'uncategorised',
            total: 0,
            methods: emptyMethods(),
          };
          row.total -= amt;
          row.methods[m] -= amt;
          byCat.set(key, row);
          byMethod[m] -= amt;
          spending -= amt;
        }
        const categories = [...byCat.values()]
          .map((c) => ({ ...c, total: r2(c.total), methods: Object.fromEntries(METHODS.map((m) => [m, r2(c.methods[m])])) as Record<Method, number> }))
          .filter((c) => Math.abs(c.total) > 0.009)
          .sort((x, y) => y.total - x.total);
        return {
          account_id: a.id,
          name: a.name,
          type: a.type,
          owner_id: a.owner_id,
          owner_name: a.owner_id ? owners.get(a.owner_id) ?? null : null,
          money_in: r2(moneyIn),
          money_out: r2(moneyOut),
          income: r2(income),
          spending: r2(spending),
          transfers_out: r2(transfers),
          by_method: Object.fromEntries(METHODS.map((m) => [m, r2(byMethod[m])])) as Record<Method, number>,
          categories,
          lines: mine.length,
        };
      })
      .filter((a) => a.lines > 0),
  };
}

// ---- Settle up ---------------------------------------------------------------

/** Household members are the personal categories ("Sam Personal"),
 *  shown by first name. */
export function memberNames(): Map<string, string> {
  const rows = db.prepare('SELECT id, name FROM categories WHERE personal = 1 AND archived = 0 AND parent_id IS NULL ORDER BY sort_order, name').all() as {
    id: string;
    name: string;
  }[];
  return new Map(rows.map((r) => [r.id, r.name.replace(/\s*\bpersonal\b\s*/i, ' ').trim() || r.name]));
}

interface MemberSums {
  income: number;
  /** Shared (non-personal) spending paid from this member's accounts. */
  paid: number;
  /** Everything they paid, shared or not, by category (key: the top-level
   *  category, or a debt's own line). */
  paid_by_category: Map<string, { key: string; name: string; icon: string | null; amount: number; shared: boolean }>;
  /** Of the shared, lines not filed yet (taken as shared until they are). */
  uncategorised: number;
  /** Another member's personal spending paid from this member's accounts. */
  paid_for: Map<string, number>;
}

/** Categories marked "not shared": whoever pays them carries them. */
export function ownCostKeys(): Set<string> {
  return new Set(getSettings().settle_exclude);
}

function debtLines(): Map<string, { account_id: string; name: string; icon: string | null }> {
  const rows = db.prepare('SELECT a.id, a.debt_category_id, c.name, c.icon FROM accounts a JOIN categories c ON c.id = a.debt_category_id').all() as {
    id: string;
    debt_category_id: string;
    name: string;
    icon: string | null;
  }[];
  return new Map(rows.map((r) => [r.debt_category_id, { account_id: r.id, name: r.name, icon: r.icon }]));
}

function memberSums(period: Period, members: Map<string, string>, accounts: AccountRow[]): Map<string, MemberSums> {
  const out = new Map<string, MemberSums>();
  for (const id of members.keys()) out.set(id, { income: 0, paid: 0, paid_by_category: new Map(), uncategorised: 0, paid_for: new Map() });
  const ownerOf = new Map(accounts.filter((a) => a.owner_id && out.has(a.owner_id)).map((a) => [a.id, a.owner_id!]));
  const own = ownCostKeys();
  const debts = debtLines();
  const add = (m: MemberSums, key: string, name: string, icon: string | null, amount: number) => {
    const shared = !own.has(key);
    if (shared) m.paid += amount;
    const c = m.paid_by_category.get(key) ?? { key, name, icon, amount: 0, shared };
    c.amount += amount;
    m.paid_by_category.set(key, c);
  };
  for (const l of lines(period.start, period.end)) {
    const owner = ownerOf.get(l.account_id);
    if (!owner) continue;
    const m = out.get(owner)!;
    const amt = l.split_amount ?? 0;
    if (l.kind === 'income') m.income += amt;
    else if (l.kind === 'expense' && !l.personal) {
      // A card or loan's own line (its interest, fees, cover and paydown)
      // is kept apart from Debt repayments so it can be marked not shared.
      const debt = debts.get(l.category_id!);
      if (debt) add(m, l.category_id!, debt.name, debt.icon, -amt);
      else add(m, l.top_id!, l.top_name!, l.top_icon, -amt);
    } else if (l.kind === 'expense' && l.top_id !== owner && out.has(l.top_id!)) m.paid_for.set(l.top_id!, (m.paid_for.get(l.top_id!) ?? 0) - amt);
    else if (!l.kind && amt < 0) {
      add(m, '', 'Uncategorised', null, -amt);
      if (!own.has('')) m.uncategorised -= amt;
    }
  }
  // A debt's paydown is paid by whoever owns the card or loan.
  for (const [cat, v] of paydownByCategory(period)) {
    const d = debts.get(cat);
    const owner = d && ownerOf.get(d.account_id);
    if (!owner || !v) continue;
    add(out.get(owner)!, cat, d.name, d.icon, v);
  }
  return out;
}

/** Does a money-in line's wording say who sent it? ("THANKS LOVE" = from
 *  Sam, paid from an account BudgetPro doesn't track.) */
function contributor(description: string, receiver: string): string | null {
  const d = description.toUpperCase();
  for (const c of getSettings().settle_incoming) {
    if (c.member_id === receiver) continue;
    const pats = c.pattern.split('|').map((p) => p.trim().toUpperCase()).filter(Boolean);
    if (pats.some((p) => d.includes(p))) return c.member_id;
  }
  return null;
}

/** Money sent from one member to another: a line out on one's account and
 *  the same amount in on the other's within three days, or money in whose
 *  wording names the sender. Only transfers (or lines not filed yet) count. */
function memberTransfers(period: Period, accounts: AccountRow[]) {
  const owned = accounts.filter((a) => a.owner_id);
  if (!owned.length) return [];
  const ownerOf = new Map(owned.map((a) => [a.id, a.owner_id!]));
  const nameOf = new Map(accounts.map((a) => [a.id, a.name]));
  const cand = db
    .prepare(
      `SELECT t.id, t.account_id, t.date, t.description, t.amount FROM transactions t
       WHERE t.date BETWEEN ? AND ? AND t.ignored = 0
         AND NOT EXISTS (SELECT 1 FROM transaction_splits s JOIN categories c ON c.id = s.category_id
                         WHERE s.transaction_id = t.id AND c.kind != 'transfer')
       ORDER BY t.date`
    )
    .all(period.start, addDays(period.end, 3)) as { id: string; account_id: string; date: string; description: string; amount: number }[];
  const ins = cand.filter((t) => t.amount > 0 && ownerOf.has(t.account_id));
  const used = new Set<string>();
  const out: { from: string; to: string; amount: number; date: string; description: string; from_account: string; to_account: string }[] = [];
  for (const i of ins) {
    if (i.date > period.end) continue;
    const to = ownerOf.get(i.account_id)!;
    const from = contributor(i.description, to);
    if (!from) continue;
    used.add(i.id);
    out.push({ from, to, amount: r2(i.amount), date: i.date, description: i.description, from_account: 'an untracked account', to_account: nameOf.get(i.account_id) ?? '' });
  }
  for (const t of cand) {
    if (t.amount >= 0 || t.date > period.end) continue;
    const from = ownerOf.get(t.account_id);
    if (!from) continue;
    const match = ins.find(
      (i) => !used.has(i.id) && ownerOf.get(i.account_id) !== from && Math.abs(i.amount + t.amount) < 0.005 && i.date >= t.date && i.date <= addDays(t.date, 3)
    );
    if (!match) continue;
    used.add(match.id);
    out.push({
      from,
      to: ownerOf.get(match.account_id)!,
      amount: r2(-t.amount),
      date: t.date,
      description: t.description,
      from_account: nameOf.get(t.account_id) ?? '',
      to_account: nameOf.get(match.account_id) ?? '',
    });
  }
  return out;
}

export type SplitRule = 'income' | 'equal';

/** Shares of the shared costs: by income (this period's, else last
 *  period's), or equal. */
function shares(rule: SplitRule, ids: string[], income: Map<string, number>, lastIncome: Map<string, number>): { shares: Map<string, number>; basis: string } {
  const equal = new Map(ids.map((id) => [id, 1 / ids.length]));
  if (rule === 'equal') return { shares: equal, basis: 'equal' };
  for (const [src, label] of [
    [income, 'income this period'],
    [lastIncome, 'income last period'],
  ] as const) {
    const total = ids.reduce((s, id) => s + Math.max(0, src.get(id) ?? 0), 0);
    if (total > 0 && ids.every((id) => (src.get(id) ?? 0) > 0)) return { shares: new Map(ids.map((id) => [id, Math.max(0, src.get(id) ?? 0) / total])), basis: label };
  }
  return { shares: equal, basis: 'equal (no income from everyone yet)' };
}

export function settleUp(period: Period) {
  const members = memberNames();
  const accounts = db.prepare('SELECT id, name, type, owner_id FROM accounts ORDER BY name').all() as AccountRow[];
  const ids = [...members.keys()];
  const rule = getSettings().settle_split;
  const now = memberSums(period, members, accounts);
  const prev = memberSums(previousPeriod(period), members, accounts);
  const { shares: share, basis } = shares(
    rule,
    ids,
    new Map(ids.map((id) => [id, now.get(id)!.income])),
    new Map(ids.map((id) => [id, prev.get(id)!.income]))
  );
  const transfers = memberTransfers(period, accounts);
  const sharedPaid = r2(ids.reduce((s, id) => s + now.get(id)!.paid, 0));

  // What the budget plans for shared spending (top-level, not personal).
  const kpis = periodKpis(period);
  const own = ownCostKeys();
  const top = new Map(kpis.categories.map((c) => [c.category_id, c]));
  const plannedShared = r2(
    kpis.categories
      .filter((c) => c.kind === 'expense' && !c.personal)
      .reduce((s, c) => {
        // Top-level lines carry their children's plan; a child marked not
        // shared comes off its parent's.
        if (!c.parent_id) return own.has(c.category_id ?? '') ? s : s + c.planned;
        return own.has(c.category_id ?? '') && !own.has(c.parent_id) && top.has(c.parent_id) ? s - c.planned : s;
      }, 0)
  );

  // At full budget, each member pays their own share of the plan. What
  // they'll pay themselves is what they have so far, or last period's if
  // that was more (their debit orders come round again); the rest of the
  // plan is taken to be paid by whoever pays the most.
  const expected = new Map(ids.map((id) => [id, Math.max(now.get(id)!.paid, prev.get(id)!.paid)]));
  const expectedTotal = [...expected.values()].reduce((s, v) => s + v, 0);
  const plannedBase = Math.max(plannedShared, expectedTotal);
  const rest = plannedBase - expectedTotal;
  const topPayer = ids.reduce<string | null>((best, id) => (best === null || expected.get(id)! > expected.get(best)! ? id : best), null);
  if (topPayer && rest > 0) expected.set(topPayer, expected.get(topPayer)! + rest);

  const rows = ids.map((id) => {
    const m = now.get(id)!;
    const sent = r2(transfers.filter((t) => t.from === id).reduce((s, t) => s + t.amount, 0));
    const received = r2(transfers.filter((t) => t.to === id).reduce((s, t) => s + t.amount, 0));
    // Paying for someone else's spending money is like sending it to them.
    const paidFor = r2([...m.paid_for.values()].reduce((s, v) => s + v, 0));
    const paidForYou = r2(ids.reduce((s, other) => s + (now.get(other)!.paid_for.get(id) ?? 0), 0));
    const extra = paidFor - paidForYou;
    const fair = r2(sharedPaid * share.get(id)!);
    // Positive: put in more than their share so far.
    const position = r2(m.paid + sent - received + extra - fair);
    const plannedPosition = r2(expected.get(id)! + sent - received + extra - plannedBase * share.get(id)!);
    return {
      member_id: id,
      name: members.get(id)!,
      accounts: accounts.filter((a) => a.owner_id === id).map((a) => ({ id: a.id, name: a.name })),
      income: r2(m.income),
      share: r2(share.get(id)! * 100),
      paid: r2(m.paid),
      paid_last_period: r2(prev.get(id)!.paid),
      fair_share: fair,
      planned_share: r2(plannedBase * share.get(id)!),
      sent,
      received,
      uncategorised: r2(m.uncategorised),
      paid_for_others: [...m.paid_for.entries()].filter(([, v]) => Math.abs(v) > 0.009).map(([to, v]) => ({ member_id: to, name: members.get(to)!, amount: r2(v) })),
      paid_for_you: paidForYou,
      position,
      planned_position: plannedPosition,
      paid_by_category: [...m.paid_by_category.values()].map((c) => ({ ...c, amount: r2(c.amount) })).filter((c) => Math.abs(c.amount) > 0.009).sort((a, b) => b.amount - a.amount),
    };
  });

  return {
    period,
    rule,
    basis,
    shared_paid: sharedPaid,
    planned_shared: plannedShared,
    own_costs: [...own],
    period_open: period.end >= todayIso(),
    members: rows,
    transfers: transfers.filter((t) => members.has(t.from) && members.has(t.to)).map((t) => ({ ...t, from_name: members.get(t.from)!, to_name: members.get(t.to)! })),
    incoming_rules: getSettings().settle_incoming.filter((c) => members.has(c.member_id)).map((c) => ({ ...c, name: members.get(c.member_id)! })),
    settle: settlements(rows.map((r) => ({ id: r.member_id, name: r.name, position: r.position }))),
    settle_planned: settlements(rows.map((r) => ({ id: r.member_id, name: r.name, position: r.planned_position }))),
    unowned_accounts: accounts.filter((a) => !a.owner_id || !members.has(a.owner_id)).map((a) => ({ id: a.id, name: a.name })),
  };
}

/** Who pays whom to even out: the one furthest behind pays the one
 *  furthest ahead, until everyone's square. */
function settlements(ps: { id: string; name: string; position: number }[]) {
  const owe = ps.filter((p) => p.position < -0.5).map((p) => ({ ...p, left: -p.position })).sort((a, b) => b.left - a.left);
  const get = ps.filter((p) => p.position > 0.5).map((p) => ({ ...p, left: p.position })).sort((a, b) => b.left - a.left);
  const out: { from_id: string; from: string; to_id: string; to: string; amount: number }[] = [];
  for (const o of owe) {
    for (const g of get) {
      if (o.left < 0.5) break;
      if (g.left < 0.5) continue;
      const amt = Math.min(o.left, g.left);
      out.push({ from_id: o.id, from: o.name, to_id: g.id, to: g.name, amount: r2(amt) });
      o.left -= amt;
      g.left -= amt;
    }
  }
  return out;
}
