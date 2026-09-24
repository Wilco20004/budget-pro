import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { usePeriod } from '../components/PeriodContext';
import PhoneNotifications from '../components/PhoneNotifications';
import { shortDate } from '../format';
import { Account, ImportRecord, ImportResult, Settings } from '../types';

export default function Import() {
  const { reload } = usePeriod();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountId, setAccountId] = useState('');
  const [history, setHistory] = useState<ImportRecord[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [result, setResult] = useState<(ImportResult & { filename: string })[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = () => {
    api.accounts().then(setAccounts).catch(() => undefined);
    api.imports().then(setHistory).catch(() => undefined);
    api.settings().then(setSettings).catch(() => undefined);
  };
  useEffect(load, []);

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    setError(null);
    const out: (ImportResult & { filename: string })[] = [];
    try {
      for (const f of Array.from(files)) {
        try {
          out.push({ ...(await api.importFile(f, accountId || null)), filename: f.name });
        } catch (e) {
          setError(`${f.name}: ${(e as Error).message}`);
        }
      }
      setResult(out);
      load();
      reload();
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  return (
    <>
      <h1>Import statements</h1>
      {accounts.length === 0 && (
        <div className="notice">
          First <Link to="/setup?tab=accounts">add your bank accounts</Link> (e.g. “FNB Cheque”, “Discovery Credit Card”).
        </div>
      )}
      {error && <div className="error">{error}</div>}

      <div className="card">
        <h2>Upload a statement</h2>
        <p className="small muted" style={{ marginTop: 0 }}>
          <strong>Discovery Bank:</strong> the monthly PDF statements as they are (transaction account and credit card) — each
          is checked against its opening and closing balance. <strong>FNB:</strong> Online Banking → account → Transaction
          History → Download → CSV. OFX works too. Re-importing an overlapping statement is safe — transactions already
          imported are skipped.
        </p>
        <div className="row">
          <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">Detect account from the file</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <input ref={fileRef} type="file" accept=".pdf,.csv,.ofx,.qfx,.txt" multiple hidden onChange={(e) => upload(e.target.files)} />
          <button className="primary" onClick={() => fileRef.current?.click()} disabled={busy || accounts.length === 0}>
            {busy ? 'Importing…' : 'Choose file(s)'}
          </button>
        </div>
        {result.map((r) => (
          <div className="notice" key={r.filename} style={{ marginTop: '0.75rem', marginBottom: 0 }}>
            <strong>{r.filename}</strong>: {r.new_count} new transaction{r.new_count === 1 ? '' : 's'}
            {r.duplicate_count ? `, ${r.duplicate_count} already imported` : ''}, {r.auto_categorized} categorised automatically
            {r.receipts_linked ? `, ${r.receipts_linked} slip(s) matched` : ''}
            {r.provisional_replaced ? `, ${r.provisional_replaced} phone-notification transaction(s) confirmed` : ''}.{' '}
            <Link to="/transactions?status=uncategorized">Reconcile →</Link>
            {r.warnings.map((w) => (
              <div key={w} className="small" style={{ color: 'var(--warning-text)' }}>
                ⚠ {w}
              </div>
            ))}
          </div>
        ))}
      </div>

      <div className="card">
        <h2>Automatic import (inbox folder)</h2>
        <p className="small" style={{ marginTop: 0 }}>
          Anything saved into <code className="token">{settings?.inbox.dir ?? '/share/budgetpro/inbox'}</code> is imported within a
          minute — statements in the folder itself (matched to an account by the account number inside the file, or put them in a
          sub-folder named after the account), slip photos/PDFs in <code className="token">receipts/</code>. Use the Samba share
          add-on, a phone folder-sync app, or an email automation that saves bank-statement attachments there.
        </p>
        {settings && !settings.inbox.exists && (
          <p className="small" style={{ color: 'var(--warning-text)' }}>
            ⚠ That folder doesn’t exist yet in this install.
          </p>
        )}
        <div className="row">
          <button onClick={() => api.scanInbox().then(load).catch((e) => setError(e.message))}>Check inbox now</button>
        </div>
        {settings && settings.inbox.recent.length > 0 && (
          <table style={{ marginTop: '0.75rem' }}>
            <tbody>
              {settings.inbox.recent.map((r) => (
                <tr key={r.at + r.file}>
                  <td className="small">{new Date(r.at).toLocaleString()}</td>
                  <td className="small">{r.file}</td>
                  <td className="small" style={{ color: r.ok ? 'var(--good-text)' : 'var(--critical-text)' }}>
                    {r.ok ? '✓' : '✕'} {r.message}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <PhoneNotifications settings={settings} />

      <div className="card">
        <h2>Import history</h2>
        {history.length === 0 ? (
          <div className="empty">No imports yet.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>File</th>
                  <th>Account</th>
                  <th>Covers</th>
                  <th className="num">New</th>
                  <th className="num">Skipped</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.id}>
                    <td className="small">{new Date(h.created_at).toLocaleString()}</td>
                    <td className="small">
                      {h.filename} {h.source === 'inbox' && <span className="chip">inbox</span>}
                    </td>
                    <td className="small">{h.account_name}</td>
                    <td className="small">{h.first_date ? `${shortDate(h.first_date)} – ${shortDate(h.last_date)}` : '—'}</td>
                    <td className="num">{h.new_count}</td>
                    <td className="num">{h.duplicate_count}</td>
                    <td>
                      {h.new_count > 0 && (
                        <button
                          className="link danger small"
                          onClick={() => {
                            if (confirm(`Undo this import? Its ${h.new_count} transactions (and their categories) are removed.`)) {
                              api.deleteImport(h.id).then(load).catch((e) => setError(e.message));
                            }
                          }}
                        >
                          Undo
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
