import { useState } from 'react';
import { api } from '../api/client';
import { dayMonth, money, todayIso } from '../format';

/** "6–12 Nov", or "27 Nov – 3 Dec" across a month end: short enough for a phone. */
function range(start: string, end: string) {
  const [a, b] = [dayMonth(start), dayMonth(end)];
  return a.split(' ')[1] === b.split(' ')[1] ? `${a.split(' ')[0]}–${b}` : `${a} – ${b}`;
}
import { PeriodKpis } from '../types';

/** Day-to-day money per payday week: this week's allowance and what's left,
 *  then every week of the period with its plan and transfer amount. Each
 *  week's plan can be set by hand (a week away, a holiday week); the weeks
 *  left blank share what remains of the day-to-day budget. */
export default function WeeklyPlan({ k, onChange }: { k: PeriodKpis; onChange: () => void }) {
  const { budget, planned, current, weeks } = k.weekly;
  const [edit, setEdit] = useState<Record<number, string> | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!budget && !weeks.some((w) => w.spent) && !weeks.some((w) => w.custom)) return null;
  const now = current !== null ? weeks[current] : null;
  const daysLeft = now ? Math.round((Date.parse(now.end) - Date.parse(todayIso())) / 86400000) + 1 : 0;
  const carried = now && now.allowance !== null ? now.allowance - now.base : 0;

  // While editing: the same split the server makes, so the blanks update as you type.
  const typed = (n: number) => {
    const v = edit?.[n]?.trim();
    return v ? Math.max(0, parseFloat(v) || 0) : null;
  };
  const setTotal = edit ? weeks.reduce((a, w) => a + (typed(w.n) ?? 0), 0) : 0;
  const freeDays = edit ? weeks.reduce((a, w) => a + (typed(w.n) === null ? w.days : 0), 0) : 0;
  const share = (days: number) => (freeDays ? (Math.max(0, budget - setTotal) * days) / freeDays : 0);
  const planOf = (w: (typeof weeks)[number]) => (edit ? typed(w.n) ?? share(w.days) : w.base);
  const total = edit ? weeks.reduce((a, w) => a + planOf(w), 0) : planned;
  const anyCustom = weeks.some((w) => w.custom);
  // What to move to the spending account when the week starts.
  const transfer = (w: (typeof weeks)[number]) => Math.max(0, w.allowance ?? w.base);

  function startEdit() {
    setError(null);
    setEdit(Object.fromEntries(weeks.map((w) => [w.n, w.custom ? String(w.base) : ''])));
  }
  async function save(values: Record<number, string>) {
    try {
      await api.saveWeeks(
        k.period.start,
        weeks.map((w) => ({ n: w.n, amount: values[w.n]?.trim() ? parseFloat(values[w.n]) || 0 : null }))
      );
      setEdit(null);
      onChange();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="card">
      <div className="row" style={{ marginBottom: '0.5rem' }}>
        <h2 style={{ margin: 0 }}>{now ? `This week (week ${now.n} of ${weeks.length})` : 'Weekly spending'}</h2>
        <span className="spacer" />
        <span className="small muted">day-to-day budget {money(budget, { whole: true })} this period</span>
        {!edit && (
          <button className="link small" onClick={startEdit} title="Set a different amount for a week (a week away, a holiday week)">
            Edit weeks
          </button>
        )}
      </div>
      {error && <div className="error">{error}</div>}

      {!edit && now && now.allowance !== null && now.left !== null && (
        <div style={{ marginBottom: '0.9rem' }}>
          <div className="row" style={{ alignItems: 'baseline' }}>
            <span style={{ fontSize: '1.6rem', fontWeight: 600, color: now.left < 0 ? 'var(--critical-text)' : undefined }}>
              {money(now.left, { whole: true })}
            </span>
            <span className="muted">
              {now.left < 0 ? 'over' : 'left'} ·{' '}
              {now.allowance > 0
                ? `${money(now.spent, { whole: true })} of ${money(now.allowance, { whole: true })} spent`
                : `${money(now.spent, { whole: true })} spent, with nothing left from earlier weeks`}
            </span>
            <span className="spacer" />
            <span className="small muted">
              {range(now.start, now.end)} · {daysLeft} day{daysLeft === 1 ? '' : 's'} left
            </span>
          </div>
          <div className="goal-bar" title={`${money(now.spent)} of ${money(now.allowance)}`} style={{ marginTop: 6 }}>
            <div
              className="goal-fill"
              style={{
                width: `${Math.min(100, now.allowance > 0 ? (now.spent / now.allowance) * 100 : 100)}%`,
                background: now.left < 0 ? 'var(--critical-text)' : undefined,
              }}
            />
          </div>
          {Math.abs(carried) >= 1 && (
            <div className="small muted" style={{ marginTop: 4 }}>
              {money(now.base, { whole: true })} for the week {carried > 0 ? '+' : '−'} {money(Math.abs(carried), { whole: true })}{' '}
              {carried > 0 ? 'left over from' : 'overspent in'} earlier weeks
            </div>
          )}
        </div>
      )}

      <div className="table-wrap">
        <table className="weekly-table">
          <thead>
            <tr>
              <th>Week</th>
              <th className="num" title="What the week plans to spend: set by hand, or its share by days of what's left">
                Plan
              </th>
              <th className="num col-transfer" title="What to move to your spending account at the start of the week: the plan plus what earlier weeks left over, less what they overspent">
                Transfer
              </th>
              <th className="num">Spent</th>
              <th className="num">Left</th>
            </tr>
          </thead>
          <tbody>
            {weeks.map((w) => (
              <tr key={w.n} style={w.state === 'current' ? { fontWeight: 600 } : undefined}>
                <td>
                  {w.n}
                  <span className="small muted week-dates">
                    {range(w.start, w.end)}
                    {w.days !== 7 ? ` (${w.days} days)` : ''}
                  </span>
                  {!edit && <span className="small muted week-transfer">transfer {money(transfer(w), { whole: true })}</span>}
                </td>
                <td className="num">
                  {edit ? (
                    <input
                      type="number"
                      step="1"
                      min="0"
                      inputMode="decimal"
                      value={edit[w.n] ?? ''}
                      placeholder={`auto ${Math.round(share(w.days))}`}
                      onChange={(e) => setEdit({ ...edit, [w.n]: e.target.value })}
                      style={{ width: '100%', maxWidth: '7.5rem', minWidth: '4.5rem', textAlign: 'right' }}
                    />
                  ) : (
                    <span title={w.custom ? 'Set by hand' : 'Automatic: its share by days'}>
                      {money(w.base, { whole: true })}
                      {w.custom ? <span className="small muted"> ✎</span> : null}
                    </span>
                  )}
                </td>
                <td className="num col-transfer" title={w.allowance !== null ? `Allowance ${money(w.allowance, { whole: true })}` : undefined}>
                  {edit ? (
                    <span className="muted">—</span>
                  ) : w.allowance !== null ? (
                    money(transfer(w), { whole: true })
                  ) : (
                    <span className="muted">{money(transfer(w), { whole: true })}</span>
                  )}
                </td>
                <td className="num">{w.state === 'future' ? <span className="muted">—</span> : money(w.spent, { whole: true })}</td>
                <td className="num" style={{ color: w.left !== null && w.left < 0 ? 'var(--critical-text)' : undefined }}>
                  {w.left !== null ? money(w.left, { whole: true }) : <span className="muted">—</span>}
                </td>
              </tr>
            ))}
            {(edit || anyCustom) && (
              <tr className="group-row">
                <td>Total</td>
                <td className="num">{money(total, { whole: true })}</td>
                <td className="col-transfer" />
                <td colSpan={2} className="small" style={{ color: Math.abs(total - budget) >= 1 ? 'var(--critical-text)' : undefined }}>
                  {Math.abs(total - budget) < 1
                    ? 'the whole day-to-day budget'
                    : total > budget
                      ? `${money(total - budget, { whole: true })} more than the day-to-day budget`
                      : `${money(budget - total, { whole: true })} of the day-to-day budget not given to a week`}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {edit ? (
        <div className="row" style={{ marginTop: '0.6rem' }}>
          <span className="small muted">Leave a week blank and it shares what's left, by days.</span>
          <span className="spacer" />
          {anyCustom && (
            <button onClick={() => save({})} title="Clear every hand-set week">
              All automatic
            </button>
          )}
          <button onClick={() => setEdit(null)}>Cancel</button>
          <button className="primary" onClick={() => save(edit)}>
            Save weeks
          </button>
        </div>
      ) : (
        <p className="small muted" style={{ marginBottom: 0 }}>
          Day-to-day is every spending category not ticked <em>Fixed</em> and not a debt repayment, plus anything not
          categorised yet. Each week gets its share by days unless you set it (✎); what a week doesn’t spend carries into
          the next, and an overspend comes off it.
        </p>
      )}
    </div>
  );
}
