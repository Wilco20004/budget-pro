import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { EmailStatus } from '../types';

const STATUS_TEXT: Record<string, string> = {
  receipt: '🧾 slip',
  statement: '🏦 statement',
  transactions: '📩 bank alerts',
  ignored: '– ignored',
  failed: '✕ failed',
};

/** The receipts mailbox: forward order confirmations (Sixty60 etc.), slip
 *  photos and statements to it and they're imported every few minutes. */
export default function EmailInbox({ initial }: { initial: EmailStatus | null }) {
  const [status, setStatus] = useState<EmailStatus | null>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const s = status ?? initial;

  async function check() {
    setBusy(true);
    setError(null);
    try {
      setStatus(await api.checkEmail());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h2>Email inbox</h2>
      {!s?.configured ? (
        <p className="small" style={{ marginTop: 0 }}>
          Forward online-order emails (e.g. Checkers Sixty60), slip photos, PDF e-slips and statements to a mailbox of their own and
          BudgetPro imports them every 5 minutes. Set it up in the add-on’s <strong>Configuration</strong> tab: <code>imap_host</code>,{' '}
          <code>imap_user</code> and <code>imap_password</code> (port 993). Use an address used only for this — a filter in your normal
          mailbox can auto-forward the shop emails to it. Imported emails are moved to a <code>BudgetPro</code> folder (or deleted, or kept — <code>imap_after_import</code>); nothing is ever sent.
        </p>
      ) : (
        <>
          <p className="small" style={{ marginTop: 0 }}>
            Checking <code className="token">{s.user}</code> ({s.folder}) every 5 minutes
            {s.last_check ? ` · last checked ${new Date(s.last_check).toLocaleString()}` : ''}. Forward order emails, slip photos,
            e-slips and statements there.{' '}
            {s.after_import === 'move' && <>Imported emails are moved to the <code>{s.move_to}</code> folder.</>}
            {s.after_import === 'delete' && <>Imported emails are deleted from the mailbox.</>}
            {s.after_import === 'keep' && <>Imported emails stay in the inbox.</>} Skipped and failed ones always stay.
          </p>
          {s.last_error && (
            <p className="small" style={{ color: 'var(--critical-text)' }}>
              ✕ {s.last_error}
            </p>
          )}
          {error && <div className="error">{error}</div>}
          <div className="row">
            <button onClick={check} disabled={busy}>
              {busy ? 'Checking…' : 'Check email now'}
            </button>
          </div>
          {s.recent.length > 0 && (
            <div className="table-wrap" style={{ marginTop: '0.75rem' }}>
              <table>
                <tbody>
                  {s.recent.map((e) => (
                    <tr key={`${e.uid}-${e.received_at}`}>
                      <td className="small" style={{ whiteSpace: 'nowrap' }}>
                        {e.received_at ? new Date(e.received_at).toLocaleString() : ''}
                      </td>
                      <td className="small">
                        {e.subject ?? '(no subject)'}
                        <div className="muted">{e.from_addr}</div>
                      </td>
                      <td
                        className="small"
                        style={{ color: e.status === 'failed' ? 'var(--critical-text)' : e.status === 'ignored' ? 'var(--muted)' : 'var(--good-text)' }}
                      >
                        {STATUS_TEXT[e.status]}
                        {e.receipt_id && (
                          <>
                            {' '}
                            <Link to={`/receipts/${e.receipt_id}`}>view</Link>
                          </>
                        )}
                        {e.detail && <div className="muted">{e.detail}</div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
