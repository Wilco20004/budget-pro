import { useEffect, useState } from 'react';
import { api } from '../api/client';
import Copyable from '../components/Copyable';
import { usePeriod } from '../components/PeriodContext';
import { setCurrency } from '../format';
import { Settings } from '../types';

export default function SettingsPage() {
  const { periods, current, reload } = usePeriod();
  const [s, setS] = useState<Settings | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.settings().then(setS).catch((e) => setError(e.message));
  }, []);

  if (!s) return error ? <div className="error">{error}</div> : null;

  const save = (patch: Partial<Settings>) =>
    api
      .updateSettings(patch)
      .then((n) => {
        setS({ ...s, ...n });
        setCurrency(n.currency_symbol);
        reload();
        setMsg('Saved.');
      })
      .catch((e) => setError(e.message));

  const host = window.location.hostname || 'homeassistant.local';
  const mcpUrl = `http://${host}:8097/mcp`;
  const claudeCode = `claude mcp add --transport http budgetpro ${mcpUrl} --header "Authorization: Bearer ${s.api_token}"`;
  const desktopJson = JSON.stringify(
    {
      mcpServers: {
        budgetpro: {
          command: 'npx',
          args: ['-y', 'mcp-remote', mcpUrl, '--allow-http', '--header', `Authorization: Bearer ${s.api_token}`],
        },
      },
    },
    null,
    2
  );
  const upcoming = [...periods].reverse().filter((p) => current && p.start >= current.start).slice(0, 3);

  return (
    <>
      <h1>Settings</h1>
      {error && <div className="error">{error}</div>}
      {msg && (
        <div className="notice" onClick={() => setMsg(null)}>
          {msg}
        </div>
      )}

      <div className="card">
        <h2>Budget period</h2>
        <div className="form-grid">
          <label className="field">
            Period starts on day (payday)
            <input
              type="number"
              min={1}
              max={31}
              defaultValue={s.period_start_day}
              onBlur={(e) => Number(e.target.value) !== s.period_start_day && save({ period_start_day: Number(e.target.value) })}
            />
          </label>
          <label className="field">
            When payday falls on a weekend
            <select value={s.weekend_rule} onChange={(e) => save({ weekend_rule: e.target.value as Settings['weekend_rule'] })}>
              <option value="previous_business_day">Paid the Friday before</option>
              <option value="next_business_day">Paid the Monday after</option>
              <option value="none">Always the same date</option>
            </select>
          </label>
          <label className="field">
            Currency symbol
            <input defaultValue={s.currency_symbol} onBlur={(e) => e.target.value !== s.currency_symbol && save({ currency_symbol: e.target.value })} />
          </label>
        </div>
        <p className="small muted" style={{ marginBottom: 0 }}>
          1 = calendar months. 31 = last day of the month. Upcoming:{' '}
          {upcoming.map((p) => p.label).join(' · ')}
        </p>
      </div>

      <div className="card">
        <h2>Slip reading</h2>
        <div className="form-grid">
          <label className="field">
            Engine
            <select value={s.ocr_engine} onChange={(e) => save({ ocr_engine: e.target.value as Settings['ocr_engine'] })}>
              <option value="auto">Automatic (Claude if a key is set, else built-in OCR)</option>
              <option value="tesseract">Built-in OCR only (offline)</option>
              <option value="claude">Claude only</option>
            </select>
          </label>
        </div>
        <p className="small muted" style={{ marginBottom: 0 }}>
          Built-in OCR (Tesseract) runs on the Home Assistant box and never sends anything out, but struggles with faded or
          crumpled thermal slips. Claude reads them far better and suggests categories per line; it needs an Anthropic API key in the
          add-on’s Configuration tab and sends the slip image to Anthropic.{' '}
          {s.claude_available ? `✓ Key configured (model ${s.ai_model}).` : 'No key configured.'}
        </p>
      </div>

      <div className="card">
        <h2>Home Assistant</h2>
        <label className="row" style={{ gap: 6 }}>
          <input type="checkbox" checked={s.publish_ha_sensors} onChange={(e) => save({ publish_ha_sensors: e.target.checked })} />
          Publish budget sensors (sensor.budgetpro_spent, _remaining, _days_left, _daily_allowance, _to_reconcile, and one
          sensor.budgetpro_&lt;category&gt;_remaining per category)
        </label>
        <p className="small muted" style={{ marginBottom: 0 }}>
          {s.home_assistant ? '✓ Connected to Home Assistant.' : 'Not running under Home Assistant — sensors are skipped.'}
        </p>
      </div>

      <div className="card">
        <h2>API &amp; AI access (MCP)</h2>
        <p className="small" style={{ marginTop: 0 }}>
          The REST API (<code>/api/…</code>) and the MCP endpoint (<code>/mcp</code>) are on the add-on’s own port 8097. From
          outside Home Assistant they need this token as <code>Authorization: Bearer …</code>.
        </p>
        <div className="row" style={{ marginBottom: '0.75rem' }}>
          <code className="token">{s.api_token}</code>
          <Copyable text={s.api_token} />
          <button
            className="small danger"
            onClick={() =>
              confirm('Make a new token? Anything using the old one stops working.') &&
              api.regenerateToken().then((r) => setS({ ...s, api_token: r.api_token }))
            }
          >
            Regenerate
          </button>
        </div>
        <h3 className="small">Claude Code</h3>
        <pre>{claudeCode}</pre>
        <Copyable text={claudeCode} />
        <h3 className="small">Claude Desktop (claude_desktop_config.json)</h3>
        <pre>{desktopJson}</pre>
        <Copyable text={desktopJson} />
        <p className="small muted">
          Tools: get_period_summary, get_trend, search_transactions, spending_by_merchant, search_products, product_price_history,
          list_categories, list_periods, categorize_transaction, log_receipt. To log slips with your Claude subscription:
          attach the slip photos in Claude Desktop (connected as above) and ask it to “log these slips in BudgetPro”. If <code>{host}</code> isn’t how other machines reach Home
          Assistant, swap in its LAN IP.
        </p>
      </div>
    </>
  );
}
