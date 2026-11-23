import { Fragment } from 'react';
import { Link } from 'react-router-dom';
import { dayMonth, money, todayIso } from '../format';
import { PeriodKpis } from '../types';

/** "6–12 Nov", or "27 Nov – 3 Dec" across a month end: short enough for a phone. */
function range(start: string, end: string) {
  const [a, b] = [dayMonth(start), dayMonth(end)];
  return a.split(' ')[1] === b.split(' ')[1] ? `${a.split(' ')[0]}–${b}` : `${a} – ${b}`;
}

/** Day-to-day money per payday week: this week's allowance and what's left,
 *  then every week of the period with its plan and transfer amount. The
 *  weeks are planned per category on the Plan page (tablet or computer). */
export default function WeeklyPlan({ k }: { k: PeriodKpis }) {
  const { budget, planned, current, weeks } = k.weekly;
  if (!budget && !weeks.some((w) => w.spent) && !weeks.some((w) => w.custom)) return null;
  const now = current !== null ? weeks[current] : null;
  const daysLeft = now ? Math.round((Date.parse(now.end) - Date.parse(todayIso())) / 86400000) + 1 : 0;
  const carried = now && now.allowance !== null ? now.allowance - now.base : 0;
  const anyCustom = weeks.some((w) => w.custom);
  // What to move to the spending account when the week starts.
  const transfer = (w: (typeof weeks)[number]) => Math.max(0, w.allowance ?? w.base);

  return (
    <div className="card">
      <div className="row" style={{ marginBottom: '0.5rem' }}>
        <h2 style={{ margin: 0 }}>{now ? `This week (week ${now.n} of ${weeks.length})` : 'Weekly spending'}</h2>
        <span className="spacer" />
        <span className="small muted">day-to-day budget {money(budget, { whole: true })} this period</span>
        <Link to="/budget?weeks=1" className="small hide-phone" title="Plan each day-to-day category per week">
          Plan weeks
        </Link>
      </div>

      {now && now.allowance !== null && now.left !== null && (
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
              <th className="num" title="What the week plans to spend: its categories' amounts for the week">
                Plan
              </th>
              <th
                className="num col-transfer"
                title="What to move to your spending account at the start of the week: the plan plus what earlier weeks left over, less what they overspent"
              >
                Transfer
              </th>
              <th className="num">Spent</th>
              <th className="num">Left</th>
            </tr>
          </thead>
          <tbody>
            {weeks.map((w) => (
              <Fragment key={w.n}>
              <tr className={w.notes.length ? 'has-notes' : undefined} style={w.state === 'current' ? { fontWeight: 600 } : undefined}>
                <td>
                  {w.n}
                  <span className="small muted week-dates">
                    {range(w.start, w.end)}
                    {w.days !== 7 ? ` (${w.days} days)` : ''}
                  </span>
                  <span className="small muted week-transfer">transfer {money(transfer(w), { whole: true })}</span>
                </td>
                <td className="num">
                  <span title={w.custom ? 'Some categories set by hand for this week' : 'Each category’s share by days'}>
                    {money(w.base, { whole: true })}
                    {w.custom ? <span className="small muted"> ✎</span> : null}
                  </span>
                </td>
                <td className="num col-transfer" title={w.allowance !== null ? `Allowance ${money(w.allowance, { whole: true })}` : undefined}>
                  {w.allowance !== null ? (
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
              {w.notes.length > 0 && (
                <tr className="week-notes-row">
                  {/* Five columns, or four on a phone where Transfer folds into the week cell. */}
                  {[5, 4].map((span) => (
                    <td key={span} colSpan={span} className={'small muted ' + (span === 5 ? 'wk-wide' : 'wk-narrow')}>
                      📝{' '}
                      {w.notes.map((x, j) => (
                        <span key={x.category_id}>
                          {j > 0 && ' · '}
                          {x.icon} {x.name}: {x.note}
                        </span>
                      ))}
                    </td>
                  ))}
                </tr>
              )}
              </Fragment>
            ))}
            {anyCustom && Math.abs(planned - budget) >= 1 && (
              <tr className="group-row">
                <td>Total</td>
                <td className="num">{money(planned, { whole: true })}</td>
                <td className="col-transfer" />
                <td colSpan={2} className="small" style={{ color: 'var(--critical-text)' }}>
                  {planned > budget
                    ? `${money(planned - budget, { whole: true })} more than the day-to-day budget`
                    : `${money(budget - planned, { whole: true })} of the day-to-day budget not in a week`}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="small muted" style={{ marginBottom: 0 }}>
        Day-to-day is every spending category not ticked <em>Fixed</em> and not a debt repayment, plus anything not
        categorised yet. Each category’s plan is spread over the weeks by days unless you set its weeks on the Plan page
        (✎); what a week doesn’t spend carries into the next, and an overspend comes off it.
      </p>
    </div>
  );
}
