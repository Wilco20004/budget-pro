import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { WhatsappStatus } from '../types';
import ConfirmButton from './ConfirmButton';
import Copyable from './Copyable';

const STATUS_TEXT: Record<string, string> = {
  receipt: '🧾 slip',
  statement: '🏦 statement',
  ignored: '– skipped',
  not_allowed: '⛔ not an allowed number',
  failed: '✕ failed',
};

/** WhatsApp slips through the NeuraCore platform's callbacks. */
export default function WhatsAppCard() {
  const [s, setS] = useState<WhatsappStatus | null>(null);
  const [numbers, setNumbers] = useState('');
  const [base, setBase] = useState('');
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    api
      .whatsapp()
      .then((r) => {
        setS(r);
        setNumbers(r.numbers);
        setBase(r.media_base);
      })
      .catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  async function save() {
    setError(null);
    try {
      await api.updateSettings({ whatsapp_numbers: numbers, whatsapp_media_base: base });
      await load();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (!s) return null;
  return (
    <div className="card">
      <h2>WhatsApp</h2>
      <p className="small" style={{ marginTop: 0 }}>
        Send a slip photo or PDF to your WhatsApp business number and it arrives here as a slip (a statement PDF is imported as a
        statement). Only photos and files from the numbers below are used — anyone else’s messages are ignored and not downloaded.
      </p>
      {error && <div className="error">{error}</div>}

      <div className="form-grid">
        <label className="field">
          Allowed numbers
          <input value={numbers} onChange={(e) => setNumbers(e.target.value)} placeholder="082 123 4567, 083 765 4321" />
        </label>
        <label className="field">
          WhatsApp platform address
          <input value={base} onChange={(e) => setBase(e.target.value)} placeholder="https://qa.crm.neuracore.co.za" />
        </label>
      </div>
      <div className="row" style={{ marginTop: '0.5rem' }}>
        <button className="primary" onClick={save}>
          Save
        </button>
        {saved && <span className="small" style={{ color: 'var(--good-text)' }}>✓ Saved</span>}
      </div>

      <h3 className="small" style={{ marginTop: '1rem' }}>Platform callback settings</h3>
      <table className="small">
        <tbody>
          <tr>
            <td className="muted">CallbackUrl</td>
            <td>
              <code>https://&lt;your public address&gt;/webhooks/whatsapp</code> (no trailing slash — the platform adds{' '}
              <code>/WhatsappReceived</code>)
            </td>
          </tr>
          <tr>
            <td className="muted">Auth</td>
            <td>
              Custom header — Name <code>X-Api-Key</code>
            </td>
          </tr>
          <tr>
            <td className="muted">Key</td>
            <td>
              <span className="row" style={{ gap: 6 }}>
                <code className="token">{s.key}</code>
                <Copyable text={s.key} />
                <ConfirmButton
                  className="small danger"
                  question="New key? The platform must be given it again."
                  yes="Regenerate"
                  onConfirm={() => api.regenerateWhatsappKey().then(setS).catch((e) => setError(e.message))}
                >
                  Regenerate
                </ConfirmButton>
              </span>
            </td>
          </tr>
        </tbody>
      </table>
      <p className="small muted">
        The platform is on the internet and this add-on is on your home network, so the callback needs a public HTTPS address that
        forwards <code>/webhooks/whatsapp</code> to port 8097 (e.g. a reverse proxy or Cloudflare tunnel). Forward only that path —
        the rest of the port should stay on your network.
      </p>

      {s.recent.length > 0 && (
        <div className="table-wrap">
          <table>
            <tbody>
              {s.recent.map((m) => (
                <tr key={m.id}>
                  <td className="small" style={{ whiteSpace: 'nowrap' }}>
                    {m.received_at ? new Date(m.received_at).toLocaleString() : ''}
                  </td>
                  <td className="small">
                    {m.author ?? ''} {m.phone_tail}
                    <div className="muted">{m.message_type}</div>
                  </td>
                  <td
                    className="small"
                    style={{
                      color: m.status === 'failed' || m.status === 'not_allowed' ? 'var(--critical-text)' : m.status === 'ignored' ? 'var(--muted)' : 'var(--good-text)',
                    }}
                  >
                    {STATUS_TEXT[m.status]}
                    {m.receipt_id && (
                      <>
                        {' '}
                        <Link to={`/receipts/${m.receipt_id}`}>view</Link>
                      </>
                    )}
                    {m.detail && <div className="muted">{m.detail}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
