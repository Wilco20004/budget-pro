import { useEffect, useState } from 'react';
import { api, ConnectedApp } from '../api/client';
import { shortDate } from '../format';
import ConfirmButton from './ConfirmButton';

/** Claude custom connector (claude.ai, Desktop, mobile): how to add it, and
 *  the apps signed in over OAuth, each of which can be signed out. */
export default function ConnectorCard() {
  const [apps, setApps] = useState<ConnectedApp[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    api
      .connectedApps()
      .then(setApps)
      .catch((e: Error) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  return (
    <div className="card">
      <h2>Claude app &amp; mobile (connector)</h2>
      <p className="small" style={{ marginTop: 0 }}>
        Claude reaches a connector from Anthropic’s servers, also when you use it on your phone, so BudgetPro has to be reachable over{' '}
        <b>HTTPS from the internet</b> through your reverse proxy. Forward only <code>/mcp</code>, <code>/oauth/</code> and{' '}
        <code>/.well-known/</code> to port 8097 (see the add-on’s Documentation tab).
      </p>
      <ol className="small">
        <li>
          On claude.ai: <b>Customize → Connectors → Add custom connector</b>, URL <code>https://&lt;your-domain&gt;/mcp</code>, no
          client ID or secret.
        </li>
        <li>Claude opens BudgetPro’s approval page: paste the API token above and approve.</li>
        <li>It then shows up in the Claude mobile app on the same account.</li>
      </ol>
      <p className="small muted">Regenerating the API token signs every connected app out.</p>
      <h3 className="small">Connected apps</h3>
      {error && <p className="small error">{error}</p>}
      {apps && apps.length === 0 && <p className="small muted">None yet.</p>}
      {apps && apps.length > 0 && (
        <table className="small">
          <thead>
            <tr>
              <th>App</th>
              <th>Signed in</th>
              <th>Last used</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {apps.map((a) => (
              <tr key={a.id}>
                <td>{a.name ?? 'MCP client'}</td>
                <td>{shortDate(a.last_signed_in)}</td>
                <td>{a.last_used_at ? shortDate(a.last_used_at) : '—'}</td>
                <td>
                  <ConfirmButton
                    className="small danger"
                    question="Sign this app out? It has to be approved again."
                    yes="Sign out"
                    onConfirm={() => api.disconnectApp(a.id).then(load)}
                  >
                    Sign out
                  </ConfirmButton>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
