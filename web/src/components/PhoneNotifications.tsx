import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { NotificationLog, Settings } from '../types';
import Copyable from './Copyable';

const STATUS_STYLE: Record<NotificationLog['status'], { icon: string; color: string; label: string }> = {
  imported: { icon: '✓', color: 'var(--good-text)', label: 'Added' },
  duplicate: { icon: '=', color: 'var(--muted)', label: 'Already had it' },
  ignored: { icon: '–', color: 'var(--muted)', label: 'Ignored' },
  unparsed: { icon: '?', color: 'var(--warning-text)', label: 'Not understood' },
  not_bank: { icon: '–', color: 'var(--muted)', label: 'Not a bank' },
};

/** Home Assistant config the user pastes in: a rest_command that posts to
 *  BudgetPro, and an automation that fires it for every new notification
 *  from a banking app (matched by package name, so chat apps never leave
 *  the phone's HA sensor). */
function haYaml(url: string) {
  return `# configuration.yaml
rest_command:
  budgetpro_notification:
    url: "${url}/api/notifications"
    method: POST
    headers:
      Authorization: !secret budgetpro_auth
    content_type: "application/json"
    payload: >-
      {{ {"package": package, "title": title, "text": text,
          "big_text": big_text, "posted_at": posted_at} | tojson }}

# automations.yaml  (replace sensor.YOUR_PHONE_last_notification)
- alias: BudgetPro – bank notifications
  mode: queued
  triggers:
    - trigger: state
      entity_id: sensor.YOUR_PHONE_last_notification
  conditions:
    - condition: template
      value_template: >-
        {% set p = (trigger.to_state.attributes.package or '') | lower %}
        {{ 'discovery' in p or 'fnb' in p }}
  actions:
    - action: rest_command.budgetpro_notification
      data:
        package: "{{ trigger.to_state.attributes.package }}"
        title: "{{ trigger.to_state.attributes.get('android.title', '') }}"
        text: "{{ trigger.to_state.attributes.get('android.text', '') }}"
        big_text: "{{ trigger.to_state.attributes.get('android.bigText', '') }}"
        posted_at: "{{ trigger.to_state.attributes.get('post_time', '') }}"`;
}

export default function PhoneNotifications({ settings }: { settings: Settings | null }) {
  const [log, setLog] = useState<NotificationLog[]>([]);
  const [showSetup, setShowSetup] = useState(false);

  useEffect(() => {
    api.notifications().then(setLog).catch(() => undefined);
  }, []);

  const url = settings?.internal_url ?? `http://${window.location.hostname || 'BUDGETPRO_HOST'}:8097`;
  const secret = settings ? `budgetpro_auth: "Bearer ${settings.api_token}"` : '';

  return (
    <div className="card">
      <div className="row" style={{ marginBottom: '0.5rem' }}>
        <h2 style={{ margin: 0 }}>Phone notifications (Android)</h2>
        <span className="spacer" />
        <button className="small" onClick={() => setShowSetup(!showSetup)}>
          {showSetup ? 'Hide setup' : 'Set up'}
        </button>
      </div>
      <p className="small" style={{ marginTop: 0 }}>
        Card payments and transfers from the Discovery app show up the moment they happen, marked <em>📱 provisional</em>. When
        the monthly statement is imported, the statement line takes over — keeping any category or slip you’ve added. Only
        accounts set up here are used: a notification for any other account (e.g. a business account) is ignored and its text
        isn’t kept. Declined payments are ignored.
      </p>

      {showSetup && (
        <div className="small">
          <ol style={{ paddingLeft: '1.2rem' }}>
            <li>
              Phone: Home Assistant app → Settings → Companion app → Manage sensors → <strong>Last notification</strong> → enable,
              and allow notification access.
            </li>
            <li>
              Add this line to Home Assistant’s <code>secrets.yaml</code> (it holds the API token, so keep it out of shared
              config): <Copyable text={secret} label="Copy secret line" />
            </li>
            <li>
              Add the rest_command and automation below, replacing <code>YOUR_PHONE</code> with your phone’s sensor name (Developer
              Tools → States → search “last_notification”), then restart Home Assistant.{' '}
              <Copyable text={haYaml(url)} label="Copy YAML" />
            </li>
          </ol>
          <pre>{haYaml(url)}</pre>
          {!settings?.internal_url && (
            <p style={{ color: 'var(--warning-text)' }}>
              ⚠ BudgetPro isn’t running as a Home Assistant add-on right now, so <code>{url}</code> is a guess — use an address Home
              Assistant can reach (this computer’s LAN IP, with port 8097 allowed through its firewall).
            </p>
          )}
        </div>
      )}

      {log.length === 0 ? (
        <p className="small muted" style={{ marginBottom: 0 }}>
          No notifications received yet.
        </p>
      ) : (
        <div className="table-wrap">
          <table>
            <tbody>
              {log.slice(0, 25).map((n) => {
                const s = STATUS_STYLE[n.status];
                return (
                  <tr key={n.id}>
                    <td className="small" style={{ whiteSpace: 'nowrap' }}>
                      {new Date(n.received_at).toLocaleString()}
                    </td>
                    <td className="small" style={{ color: s.color, whiteSpace: 'nowrap' }}>
                      {s.icon} {s.label}
                    </td>
                    <td className="small">
                      {n.reason}
                      {n.status === 'unparsed' && n.text && (
                        <details>
                          <summary className="muted">What arrived</summary>
                          <pre>{[n.title, n.text].filter(Boolean).join('\n')}</pre>
                        </details>
                      )}
                      {n.status === 'not_bank' && n.package && <span className="muted"> ({n.package})</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
