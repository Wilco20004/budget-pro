import { periodKpis } from './services/kpis';
import { currentPeriod } from './services/periods';
import { getSettings } from './settings';

// Home Assistant add-ons get SUPERVISOR_TOKEN injected automatically (when
// config.yaml declares homeassistant_api: true) and can reach Core's REST
// API through the Supervisor proxy at http://supervisor/core. Only present
// when actually running as an installed add-on; absent in `npm run dev`.
const SUPERVISOR_TOKEN = process.env.SUPERVISOR_TOKEN;
const HA_CORE_BASE = 'http://supervisor/core';

export function homeAssistantAvailable(): boolean {
  return Boolean(SUPERVISOR_TOKEN);
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

async function setState(entityId: string, state: string | number, attributes: Record<string, unknown>) {
  const res = await fetch(`${HA_CORE_BASE}/api/states/${entityId}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SUPERVISOR_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: String(state), attributes }),
  });
  if (!res.ok) throw new Error(`Home Assistant returned ${res.status} for ${entityId}`);
}

let publishing: Promise<void> | null = null;
let again = false;

/** Pushes the current period's KPIs to HA as sensor.budgetpro_* states, so
 *  they can go on dashboards and drive automations ("notify me when
 *  Groceries passes 90%"). States set this way don't survive an HA restart,
 *  which is why this also runs on a timer. Coalesces overlapping calls. */
export async function publishSensors(): Promise<void> {
  if (!SUPERVISOR_TOKEN || !getSettings().publish_ha_sensors) return;
  if (publishing) {
    again = true;
    return publishing;
  }
  publishing = (async () => {
    try {
      const k = periodKpis(currentPeriod());
      const currency = getSettings().currency_symbol;
      const money = { unit_of_measurement: currency, device_class: 'monetary', state_class: 'total', icon: 'mdi:cash' };
      const base = { period_start: k.period.start, period_end: k.period.end, period: k.period.label };
      await setState('sensor.budgetpro_spent', k.totals.expense_actual, {
        ...money,
        ...base,
        friendly_name: 'Budget spent',
        planned: k.totals.expense_planned,
      });
      await setState('sensor.budgetpro_remaining', k.totals.expense_remaining, {
        ...money,
        ...base,
        friendly_name: 'Budget remaining',
        icon: 'mdi:wallet',
      });
      await setState('sensor.budgetpro_income', k.totals.income_actual, {
        ...money,
        ...base,
        friendly_name: 'Income this period',
        planned: k.totals.income_planned,
      });
      await setState('sensor.budgetpro_daily_allowance', k.totals.daily_allowance ?? 0, {
        ...money,
        ...base,
        state_class: 'measurement',
        friendly_name: 'Daily spending allowance',
        icon: 'mdi:calendar-today',
      });
      await setState('sensor.budgetpro_days_left', k.days_left, {
        ...base,
        unit_of_measurement: 'd',
        friendly_name: 'Days until payday',
        icon: 'mdi:calendar-clock',
      });
      await setState('sensor.budgetpro_to_reconcile', k.recon.uncategorized + k.recon.needs_slip, {
        ...base,
        friendly_name: 'Transactions to reconcile',
        icon: 'mdi:clipboard-check-outline',
        uncategorized: k.recon.uncategorized,
        needs_slip: k.recon.needs_slip,
      });
      for (const g of k.groups) {
        if (!g.group_id) continue;
        await setState(`sensor.budgetpro_group_${slug(g.name)}_remaining`, g.remaining, {
          ...money,
          ...base,
          state_class: 'measurement',
          friendly_name: `${g.name} remaining`,
          icon: 'mdi:folder-outline',
          planned: g.planned,
          actual: g.actual,
          pct_used: g.pct_used,
          status: g.status,
        });
      }
      for (const c of k.categories) {
        if (c.kind === 'income' || !c.category_id) continue;
        await setState(`sensor.budgetpro_${slug(c.name)}_remaining`, c.remaining, {
          ...money,
          ...base,
          state_class: 'measurement',
          friendly_name: `${c.name} remaining`,
          planned: c.planned,
          actual: c.actual,
          pct_used: c.pct_used,
          status: c.status,
        });
      }
    } catch (e) {
      console.warn('[budgetpro] publishing HA sensors failed:', (e as Error).message);
    } finally {
      publishing = null;
      if (again) {
        again = false;
        publishSensors().catch(() => undefined);
      }
    }
  })();
  return publishing;
}
