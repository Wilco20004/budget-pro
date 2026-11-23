import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client';
import { dayMonth, money } from '../format';
import { BudgetLine, PeriodKpis } from '../types';

type Weekly = PeriodKpis['weekly'];

/** "6–12 Nov", or "27 Nov – 3 Dec" across a month end. */
function range(start: string, end: string) {
  const [a, b] = [dayMonth(start), dayMonth(end)];
  return a.split(' ')[1] === b.split(' ')[1] ? `${a.split(' ')[0]}–${b}` : `${a} – ${b}`;
}

const key = (id: string, n: number) => `${id}:${n}`;

const toEntries = (m: Record<string, string>) =>
  Object.entries(m)
    .filter(([, v]) => v.trim())
    .map(([k, v]) => {
      const [category_id, n] = k.split(':');
      return { category_id, n: Number(n), v: v.trim() };
    });

/** Day-to-day categories × payday weeks. Type an amount to set a week by hand;
 *  a blank week gets its share (by days) of what the category's set weeks
 *  leave of its plan. Uses the plan as typed on this page, saved or not.
 *  Tablet and computer only: a phone shows a note instead. */
export default function WeekGrid({
  periodStart,
  weekly,
  lines,
  planOf,
  onSaved,
}: {
  periodStart: string;
  weekly: Weekly;
  lines: BudgetLine[];
  planOf: (l: BudgetLine) => number;
  onSaved: () => void;
}) {
  const saved = useMemo(() => {
    const m: Record<string, string> = {};
    for (const c of weekly.categories) {
      if (!c.category_id) continue;
      c.weeks.forEach((w, i) => {
        if (w.custom) m[key(c.category_id!, i + 1)] = String(w.plan);
      });
    }
    return m;
  }, [weekly]);
  const savedNotes = useMemo(() => {
    const m: Record<string, string> = {};
    for (const c of weekly.categories) {
      if (!c.category_id) continue;
      c.weeks.forEach((w, i) => {
        if (w.note) m[key(c.category_id!, i + 1)] = w.note;
      });
    }
    return m;
  }, [weekly]);
  const [cells, setCells] = useState<Record<string, string>>(saved);
  const [notes, setNotes] = useState<Record<string, string>>(savedNotes);
  // The category and week whose note is open for editing.
  const [editing, setEditing] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // A reload (Save plan above, or after Save weeks) refreshes the saved
  // amounts, but never throws away weeks typed here and not saved yet.
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  useEffect(() => {
    if (dirtyRef.current) return;
    setCells(saved);
    setNotes(savedNotes);
  }, [saved, savedNotes]);

  const weeks = weekly.weeks;
  const fromK = new Map(weekly.categories.map((c) => [c.category_id, c]));
  const dayLines = lines.filter((l) => l.kind === 'expense' && l.bucket === 'day_to_day');
  const hasCells = (id: string) => weeks.some((w) => cells[key(id, w.n)]?.trim() || notes[key(id, w.n)]?.trim());
  // A subcategory without a plan of its own (Meat under Groceries) is planned
  // as part of its parent: its spending shows on the parent's row.
  const dayIds = new Set(dayLines.map((l) => l.category_id));
  // Categories the server counts that the Plan page doesn't list (archived, with
  // a plan or spending this period), so the totals match the dashboard.
  const extra = weekly.categories.filter((c) => c.category_id && !dayIds.has(c.category_id));
  const foldInto = new Map<string, string>();
  for (const l of dayLines) {
    if (l.parent_id && dayIds.has(l.parent_id) && planOf(l) <= 0 && !hasCells(l.category_id)) foldInto.set(l.category_id, l.parent_id);
  }
  const spentRaw = (id: string | null, i: number) => fromK.get(id)?.weeks[i]?.spent ?? 0;
  const spentOf = (id: string | null, i: number) =>
    spentRaw(id, i) + [...foldInto].filter(([, parent]) => parent === id).reduce((a, [kid]) => a + spentRaw(kid, i), 0);
  // Rows: day-to-day lines in Plan order (with a plan, cells or spending), then Uncategorised.
  const rows = dayLines
    .filter((l) => !foldInto.has(l.category_id))
    .filter((l) => planOf(l) > 0 || hasCells(l.category_id) || weeks.some((_, i) => spentOf(l.category_id, i) > 0))
    .map((l) => ({ id: l.category_id as string | null, name: l.name, icon: l.icon, sub: !!l.parent_id, planned: planOf(l) }));
  for (const c of extra) rows.push({ id: c.category_id, name: c.name, icon: c.icon, sub: !!c.parent_id, planned: c.planned });
  const unc = fromK.get(null);
  if (unc) rows.push({ id: null, name: unc.name, icon: unc.icon, sub: false, planned: 0 });

  const typed = (id: string, n: number) => {
    const v = cells[key(id, n)]?.trim();
    return v ? Math.max(0, parseFloat(v) || 0) : null;
  };
  // The same split the server makes, live.
  const split = (row: (typeof rows)[number]) => {
    if (!row.id) return { setTotal: 0, cells: weeks.map(() => ({ plan: 0, custom: false })) };
    const set = weeks.map((w) => typed(row.id!, w.n));
    const setTotal = set.reduce<number>((a, v) => a + (v ?? 0), 0);
    const freeDays = weeks.reduce((a, w, i) => a + (set[i] === null ? w.days : 0), 0);
    const rest = Math.max(0, row.planned - setTotal);
    return {
      setTotal,
      cells: weeks.map((w, i) => ({ plan: set[i] ?? (freeDays ? (rest * w.days) / freeDays : 0), custom: set[i] !== null })),
    };
  };
  const plans = rows.map(split);
  const weekTotal = (i: number) => plans.reduce((a, p) => a + p.cells[i].plan, 0);
  const weekSpent = (i: number) => rows.reduce((a, r) => a + spentOf(r.id, i), 0);
  const budget = rows.reduce((a, r) => a + r.planned, 0);
  const total = weeks.reduce((a, _, i) => a + weekTotal(i), 0);
  const anySet = Object.values(cells).some((v) => v.trim());

  // keepNotes: "All automatic" clears the amounts only.
  async function save(next: Record<string, string>, keepNotes = false) {
    try {
      setError(null);
      await api.saveWeeks(
        periodStart,
        toEntries(next).map((e) => ({ category_id: e.category_id, n: e.n, amount: parseFloat(e.v) || 0 })),
        keepNotes ? undefined : toEntries(notes).map((e) => ({ category_id: e.category_id, n: e.n, note: e.v }))
      );
      setEditing(null);
      setDirty(false);
      dirtyRef.current = false;
      setNote('Weeks saved.');
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (!weeks.length || !rows.length) return null;

  return (
    <div className="card" id="weeks">
      <div className="row" style={{ marginBottom: '0.5rem' }}>
        <h2 style={{ margin: 0 }}>Day-to-day by week</h2>
        <span className="spacer" />
        <span className="small muted">
          {money(budget, { whole: true })} over {weeks.length} weeks
        </span>
      </div>
      <p className="small muted phone-only" style={{ margin: 0 }}>
        Planning each category by week needs more room: open the Plan page on a tablet or computer. Each week’s total
        and what’s left are on the dashboard.
      </p>
      <div className="hide-phone">
        <p className="small muted" style={{ marginTop: 0 }}>
          Type an amount to set a week by hand; a blank week gets its share, by days, of what the category’s set weeks
          leave. Under each amount: what’s been spent that week. 📝 adds a note on what’s planned (a school trip, a
          birthday).
        </p>
        {error && <div className="error">{error}</div>}
        <div className="table-wrap">
          <table className="week-grid">
            <thead>
              <tr>
                <th>Category</th>
                {weeks.map((w) => (
                  <th key={w.n} className="num">
                    Week {w.n}
                    <div className="small muted" style={{ fontWeight: 400 }}>
                      {range(w.start, w.end)}
                    </div>
                  </th>
                ))}
                <th className="num">Period</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => {
                const { setTotal, cells: p } = plans[ri];
                const allSet = p.every((x) => x.custom);
                const over = r.id && setTotal > r.planned + 0.5;
                const short = r.id && allSet && setTotal < r.planned - 0.5;
                const rowNotes = r.id ? weeks.filter((w) => notes[key(r.id!, w.n)]?.trim()) : [];
                const open = r.id ? weeks.find((w) => editing === key(r.id!, w.n)) : undefined;
                return (
                  <Fragment key={r.id ?? 'unc'}>
                  <tr className={rowNotes.length || open ? 'has-notes' : undefined}>
                    <td>
                      {r.sub && <span className="muted">↳ </span>}
                      <span className="icon">{r.icon}</span> {r.name}
                      {rowNotes.length > 0 && (
                        <div className="small muted week-notes">
                          {rowNotes.map((w) => (
                            <button key={w.n} className="link small" onClick={() => setEditing(key(r.id!, w.n))} title="Edit this note">
                              Wk {w.n}: {notes[key(r.id!, w.n)]}
                            </button>
                          ))}
                        </div>
                      )}
                    </td>
                    {weeks.map((w, i) => {
                      const spent = spentOf(r.id, i);
                      const started = w.state !== 'future';
                      return (
                        <td key={w.n} className="num">
                          {r.id ? (
                            <span className="cell-with-note">
                            <button
                              className={'note-btn' + (notes[key(r.id, w.n)]?.trim() ? ' has' : '')}
                              title={notes[key(r.id, w.n)]?.trim() ? 'Note: ' + notes[key(r.id, w.n)] : 'Add a note for this week'}
                              aria-label={'Note for ' + r.name + ', week ' + w.n}
                              onClick={() => setEditing(editing === key(r.id!, w.n) ? null : key(r.id!, w.n))}
                            >
                              📝
                            </button>
                            <input
                              type="number"
                              step="1"
                              min="0"
                              inputMode="decimal"
                              aria-label={`${r.name}, week ${w.n}`}
                              value={cells[key(r.id, w.n)] ?? ''}
                              placeholder={String(Math.round(p[i].plan))}
                              onChange={(e) => {
                                setCells({ ...cells, [key(r.id!, w.n)]: e.target.value });
                                setDirty(true);
                                setNote(null);
                              }}
                            />
                            </span>
                          ) : (
                            <span className="muted">—</span>
                          )}
                          {started && (spent > 0 || r.id === null) && (
                            <div
                              className="small"
                              style={{ color: spent > p[i].plan + 0.5 ? 'var(--critical-text)' : 'var(--muted)' }}
                              title="Spent this week"
                            >
                              {money(spent, { whole: true })}
                            </div>
                          )}
                        </td>
                      );
                    })}
                    <td className="num">
                      {r.id ? money(r.planned, { whole: true }) : <span className="muted">no plan</span>}
                      {over && (
                        <div className="small" style={{ color: 'var(--critical-text)' }}>
                          weeks {money(setTotal - r.planned, { whole: true })} over
                        </div>
                      )}
                      {short && (
                        <div className="small" style={{ color: 'var(--warning-text)' }}>
                          {money(r.planned - setTotal, { whole: true })} not in a week
                        </div>
                      )}
                    </td>
                  </tr>
                  {open && r.id && (
                    <tr className="note-edit">
                      <td colSpan={weeks.length + 2}>
                        <label className="row small" style={{ gap: 8 }}>
                          <span style={{ whiteSpace: 'nowrap' }}>
                            {r.icon} {r.name} · week {open.n} ({range(open.start, open.end)})
                          </span>
                          <input
                            autoFocus
                            maxLength={200}
                            placeholder="What’s planned this week, e.g. school trip R350, birthday party"
                            value={notes[key(r.id, open.n)] ?? ''}
                            onChange={(e) => {
                              setNotes({ ...notes, [key(r.id!, open.n)]: e.target.value });
                              setDirty(true);
                              setNote(null);
                            }}
                            onKeyDown={(e) => (e.key === 'Enter' || e.key === 'Escape') && setEditing(null)}
                            style={{ flex: 1 }}
                          />
                          <button className="small" onClick={() => setEditing(null)}>
                            Done
                          </button>
                        </label>
                      </td>
                    </tr>
                  )}
                  </Fragment>
                );
              })}
              <tr className="group-row">
                <td>Week total</td>
                {weeks.map((w, i) => (
                  <td key={w.n} className="num">
                    {money(weekTotal(i), { whole: true })}
                    {w.state !== 'future' && (
                      <div
                        className="small"
                        style={{ fontWeight: 400, color: weekSpent(i) > weekTotal(i) + 0.5 ? 'var(--critical-text)' : 'var(--muted)' }}
                      >
                        {money(weekSpent(i), { whole: true })} spent
                      </div>
                    )}
                  </td>
                ))}
                <td className="num">
                  {money(total, { whole: true })}
                  {Math.abs(total - budget) >= 1 && (
                    <div className="small" style={{ fontWeight: 400, color: 'var(--critical-text)' }}>
                      {total > budget ? `${money(total - budget, { whole: true })} over plan` : `${money(budget - total, { whole: true })} unplanned`}
                    </div>
                  )}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="row" style={{ marginTop: '0.6rem' }}>
          {note && !dirty && <span className="small" style={{ color: 'var(--good-text)' }}>✓ {note}</span>}
          {dirty && <span className="small muted">Not saved yet</span>}
          <span className="spacer" />
          {anySet && (
            <button onClick={() => save({}, true)} title="Clear every amount set by hand (notes stay)">
              All automatic
            </button>
          )}
          {dirty && (
            <button
              onClick={() => {
                setCells(saved);
                setNotes(savedNotes);
                setEditing(null);
                setDirty(false);
                dirtyRef.current = false;
              }}
            >
              Undo
            </button>
          )}
          <button className="primary" onClick={() => save(cells)} disabled={!dirty}>
            Save weeks
          </button>
        </div>
      </div>
    </div>
  );
}
