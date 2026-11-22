import { dayMonth, money, todayIso } from '../format';
import { PeriodKpis } from '../types';

/** Day-to-day money per payday week: this week's allowance and what's left,
 *  then every week of the period with its transfer amount. */
export default function WeeklyPlan({ k }: { k: PeriodKpis }) {
  const { budget, current, weeks } = k.weekly;
  if (!budget && !weeks.some((w) => w.spent)) return null;
  const now = current !== null ? weeks[current] : null;
  const daysLeft = now ? Math.round((Date.parse(now.end) - Date.parse(todayIso())) / 86400000) + 1 : 0;
  const carried = now && now.allowance !== null ? now.allowance - now.base : 0;

  return (
    <div className="card">
      <div className="row" style={{ marginBottom: '0.5rem' }}>
        <h2 style={{ margin: 0 }}>{now ? `This week (week ${now.n} of ${weeks.length})` : 'Weekly spending'}</h2>
        <span className="spacer" />
        <span className="small muted">day-to-day budget {money(budget, { whole: true })} this period</span>
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
              {dayMonth(now.start)} – {dayMonth(now.end)} · {daysLeft} day{daysLeft === 1 ? '' : 's'} left
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
        <table>
          <thead>
            <tr>
              <th>Week</th>
              <th title="What to move to your spending account at the start of the week (nothing when earlier weeks overspent)">Transfer</th>
              <th className="num">Allowance</th>
              <th className="num">Spent</th>
              <th className="num">Left</th>
            </tr>
          </thead>
          <tbody>
            {weeks.map((w) => (
              <tr key={w.n} style={w.state === 'current' ? { fontWeight: 600 } : undefined}>
                <td>
                  {w.n}
                  <span className="small muted">
                    {' '}
                    · {dayMonth(w.start)} – {dayMonth(w.end)}
                    {w.days !== 7 ? ` (${w.days} days)` : ''}
                  </span>
                </td>
                <td className="small">
                  {dayMonth(w.start)} · {money(Math.max(0, w.allowance ?? w.base), { whole: true })}
                </td>
                <td className="num">
                  {w.allowance !== null ? money(w.allowance, { whole: true }) : <span className="muted">{money(w.base, { whole: true })}</span>}
                </td>
                <td className="num">{w.state === 'future' ? <span className="muted">—</span> : money(w.spent, { whole: true })}</td>
                <td className="num" style={{ color: w.left !== null && w.left < 0 ? 'var(--critical-text)' : undefined }}>
                  {w.left !== null ? money(w.left, { whole: true }) : <span className="muted">—</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small muted" style={{ marginBottom: 0 }}>
        Day-to-day is every spending category not ticked <em>Fixed</em> and not a debt repayment, plus anything not
        categorised yet. Each week gets its share by days; what a week doesn’t spend carries into the next, and an overspend
        comes off it. A week that hasn’t started shows its planned share.
      </p>
    </div>
  );
}
