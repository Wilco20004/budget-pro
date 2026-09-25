import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { PeriodPicker, usePeriod } from '../components/PeriodContext';
import { money, shortDate } from '../format';
import { Settlement, SettleMember, SettleUp } from '../types';

function Settlements({ list, square }: { list: Settlement[]; square: string }) {
  if (!list.length) return <div className="settle-amount">{square}</div>;
  return (
    <>
      {list.map((s) => (
        <div key={`${s.from_id}-${s.to_id}`} className="settle-amount">
          {s.from} → {s.to} <strong>{money(s.amount, { whole: true })}</strong>
        </div>
      ))}
    </>
  );
}

function MemberCard({ m, onShared }: { m: SettleMember; onShared: (key: string, shared: boolean) => void }) {
  const own = m.paid_by_category.filter((c) => !c.shared);
  return (
    <div className="card">
      <div className="row" style={{ alignItems: 'baseline' }}>
        <h2 style={{ margin: 0 }}>{m.name} paid</h2>
        <span className="small muted">{m.accounts.map((a) => a.name).join(', ') || 'no accounts yet'}</span>
        <span className="spacer" />
        <strong>{money(m.paid, { whole: true })}</strong>
        <span className="small muted">shared</span>
      </div>
      {m.uncategorised > 0.5 && (
        <p className="small" style={{ color: 'var(--warning-text)' }}>
          ⚠ {money(m.uncategorised, { whole: true })} of it isn’t categorised yet — counted as shared until it is.
        </p>
      )}
      {m.paid_by_category.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Category</th>
                <th className="num">Paid</th>
                <th title="Untick for a cost that's only theirs: whoever pays it carries it">Shared</th>
              </tr>
            </thead>
            <tbody>
              {m.paid_by_category.map((c) => (
                <tr key={c.key} style={{ opacity: c.shared ? 1 : 0.55 }}>
                  <td>
                    {c.icon ? `${c.icon} ` : ''}
                    {c.name}
                  </td>
                  <td className="num">{money(c.amount)}</td>
                  <td>
                    <input type="checkbox" checked={c.shared} onChange={(e) => onShared(c.key, e.target.checked)} aria-label={`${c.name} is shared`} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {own.length > 0 && (
        <p className="small muted" style={{ marginBottom: 0 }}>
          Not shared ({own.map((c) => c.name).join(', ')}): whoever pays them carries them. Applies to everyone.
        </p>
      )}
    </div>
  );
}

/** Money one of you sends the other from an account BudgetPro doesn't
 *  track: recognised by the wording it arrives with. */
function IncomingRules({ s, onSave }: { s: SettleUp; onSave: (list: { pattern: string; member_id: string }[]) => void }) {
  const [pattern, setPattern] = useState('');
  const [member, setMember] = useState(s.members[0]?.member_id ?? '');
  const list = s.incoming_rules.map(({ pattern, member_id }) => ({ pattern, member_id }));
  return (
    <div className="card">
      <h2>Money from each other</h2>
      <p className="small muted" style={{ marginTop: 0 }}>
        Transfers between two accounts BudgetPro knows are found on their own. For money sent from an account it doesn’t track, say
        how it arrives (the reference on the statement).
      </p>
      {s.incoming_rules.length > 0 && (
        <ul className="small">
          {s.incoming_rules.map((r, i) => (
            <li key={i}>
              Money in worded “{r.pattern}” is from <strong>{r.name}</strong>{' '}
              <button className="link danger" onClick={() => onSave(list.filter((_, j) => j !== i))}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <input placeholder="Reference, e.g. THANKS LOVE" value={pattern} onChange={(e) => setPattern(e.target.value)} />
        <span className="small">is from</span>
        <select value={member} onChange={(e) => setMember(e.target.value)}>
          {s.members.map((m) => (
            <option key={m.member_id} value={m.member_id}>
              {m.name}
            </option>
          ))}
        </select>
        <button
          onClick={() => {
            if (!pattern.trim() || !member) return;
            onSave([...list, { pattern: pattern.trim(), member_id: member }]);
            setPattern('');
          }}
        >
          Add
        </button>
      </div>
    </div>
  );
}

export default function Settle() {
  const { selected } = usePeriod();
  const [s, setS] = useState<SettleUp | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (selected) api.settleUp(selected.start).then(setS).catch((e) => setError(e.message));
  }, [selected?.start]);

  const update = (p: Parameters<typeof api.updateSettle>[0]) =>
    api
      .updateSettle(p, selected?.start)
      .then(setS)
      .catch((e) => setError(e.message));

  const needsSetup = s && (s.members.length < 2 || s.members.some((m) => !m.accounts.length));
  return (
    <>
      <div className="page-head">
        <h1>Settle up</h1>
        <PeriodPicker />
      </div>
      {error && (
        <div className="error" onClick={() => setError(null)}>
          {error}
        </div>
      )}
      {needsSetup && (
        <div className="card">
          Settling up needs at least two people (<Link to="/setup?tab=members">Setup → Members</Link>) and each account marked with whose it is (
          <Link to="/setup">Setup → Accounts</Link>, “Whose account”).
        </div>
      )}
      {s && !needsSetup && (
        <>
          <div className="tiles settle-tiles">
            {s.period_open && (
              <div className="tile">
                <div className="label">For the full budget (estimate)</div>
                <Settlements list={s.settle_planned} square="Nothing to transfer" />
                <div className="sub">
                  shares of the {money(s.planned_shared, { whole: true })} shared plan, less what each pays themselves (so far, or last
                  period’s if that was more)
                </div>
              </div>
            )}
            <div className="tile">
              <div className="label">{s.period_open ? 'On what’s been paid so far' : 'For this period'}</div>
              <Settlements list={s.settle} square="✓ Square" />
              <div className="sub">
                shares of the {money(s.shared_paid, { whole: true })} shared costs paid{s.period_open ? ' so far' : ''}, after transfers
                between you
              </div>
            </div>
          </div>

          <div className="card">
            <div className="row" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
              <span>Split shared costs</span>
              <label className="row small" style={{ gap: 4 }}>
                <input type="radio" checked={s.rule === 'income'} onChange={() => update({ split: 'income' })} /> by income
              </label>
              <label className="row small" style={{ gap: 4 }}>
                <input type="radio" checked={s.rule === 'equal'} onChange={() => update({ split: 'equal' })} /> equally
              </label>
              <span className="small muted">({s.basis})</span>
            </div>
            <div className="table-wrap" style={{ marginTop: '0.5rem' }}>
              <table>
                <thead>
                  <tr>
                    <th />
                    {s.members.map((m) => (
                      <th key={m.member_id} className="num">
                        {m.name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Income</td>
                    {s.members.map((m) => (
                      <td key={m.member_id} className="num">
                        {money(m.income, { whole: true })}
                      </td>
                    ))}
                  </tr>
                  <tr>
                    <td>Share of shared costs</td>
                    {s.members.map((m) => (
                      <td key={m.member_id} className="num">
                        {m.share}%
                      </td>
                    ))}
                  </tr>
                  <tr>
                    <td>Paid shared costs</td>
                    {s.members.map((m) => (
                      <td key={m.member_id} className="num">
                        {money(m.paid, { whole: true })}
                      </td>
                    ))}
                  </tr>
                  <tr>
                    <td>Their share of what was paid</td>
                    {s.members.map((m) => (
                      <td key={m.member_id} className="num">
                        {money(m.fair_share, { whole: true })}
                      </td>
                    ))}
                  </tr>
                  {s.members.some((m) => m.sent || m.received) && (
                    <tr>
                      <td>Sent to / received from each other</td>
                      {s.members.map((m) => (
                        <td key={m.member_id} className="num">
                          {money(m.sent - m.received, { whole: true, signed: true })}
                        </td>
                      ))}
                    </tr>
                  )}
                  {s.members.some((m) => m.paid_for_others.length || m.paid_for_you) && (
                    <tr>
                      <td>Paid someone else’s spending money</td>
                      {s.members.map((m) => (
                        <td key={m.member_id} className="num">
                          {money(m.paid_for_others.reduce((a, o) => a + o.amount, 0) - m.paid_for_you, { whole: true, signed: true })}
                        </td>
                      ))}
                    </tr>
                  )}
                  <tr className="total-row">
                    <td>
                      <strong>Ahead (+) / behind (−)</strong>
                    </td>
                    {s.members.map((m) => (
                      <td key={m.member_id} className="num" style={{ color: m.position < -0.5 ? 'var(--critical-text)' : undefined }}>
                        <strong>{money(m.position, { whole: true, signed: true })}</strong>
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="small muted" style={{ marginBottom: 0 }}>
              Shared costs are everything in expense categories except each person’s spending money; a card or loan counts its
              interest, fees and cover plus how much it came down. Untick a category below if it’s only one person’s.
            </p>
          </div>

          {s.transfers.length > 0 && (
            <div className="card">
              <h2>Money sent between you</h2>
              <ul className="small" style={{ margin: 0 }}>
                {s.transfers.map((t, i) => (
                  <li key={i}>
                    {shortDate(t.date)}: {t.from_name} → {t.to_name} {money(t.amount)}{' '}
                    <span className="muted">
                      ({t.from_account} → {t.to_account})
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <IncomingRules s={s} onSave={(incoming) => update({ incoming })} />

          {s.members.map((m) => (
            <MemberCard key={m.member_id} m={m} onShared={(key, shared) => update({ shared: { key, shared } })} />
          ))}

          {s.unowned_accounts.length > 0 && (
            <p className="small muted">
              Not counted (no owner set): {s.unowned_accounts.map((a) => a.name).join(', ')} — set one in <Link to="/setup">Setup → Accounts</Link>.
            </p>
          )}
        </>
      )}
    </>
  );
}
