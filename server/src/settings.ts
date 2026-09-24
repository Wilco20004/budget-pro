import fs from 'fs';
import crypto from 'crypto';
import path from 'path';
import { DATA_DIR, db } from './db';

// Home Assistant Supervisor writes the add-on's current config options to
// /data/options.json before starting the container. Those are the things
// that belong to the add-on install (API keys); everything the user tunes
// day to day (budget period, currency) lives in the settings table and is
// edited from the app's own Settings page.
const OPTIONS_PATH = process.env.BUDGETPRO_OPTIONS_PATH || '/data/options.json';

interface AddonOptions {
  anthropic_api_key?: string;
  ai_model?: string;
  inbox_dir?: string;
  imap_host?: string;
  imap_port?: number;
  imap_user?: string;
  imap_password?: string;
  imap_folder?: string;
  imap_after_import?: string;
  imap_move_to?: string;
}

export interface EmailConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  folder: string;
  /** What happens to an email once it has been imported: kept, moved to
   *  move_to, or deleted. Skipped and failed emails always stay. */
  after_import: 'keep' | 'move' | 'delete';
  move_to: string;
}

/** The receipts mailbox (a dedicated account, e.g. a Gmail with an app
 *  password). Set in the add-on's Configuration tab, or IMAP_* env vars when
 *  running outside Home Assistant. The password never leaves the server. */
export function getEmailConfig(): EmailConfig | null {
  const o = readOptions();
  const host = o.imap_host || process.env.IMAP_HOST;
  const user = o.imap_user || process.env.IMAP_USER;
  const password = o.imap_password || process.env.IMAP_PASSWORD;
  if (!host || !user || !password) return null;
  return {
    host,
    port: Number(o.imap_port || process.env.IMAP_PORT) || 993,
    user,
    password,
    folder: o.imap_folder || process.env.IMAP_FOLDER || 'INBOX',
    after_import: (['keep', 'move', 'delete'] as const).find((a) => a === (o.imap_after_import || process.env.IMAP_AFTER_IMPORT)) ?? 'move',
    move_to: o.imap_move_to || process.env.IMAP_MOVE_TO || 'BudgetPro',
  };
}

export function readOptions(): AddonOptions {
  try {
    return JSON.parse(fs.readFileSync(OPTIONS_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

export function getAnthropicKey(): string | null {
  return readOptions().anthropic_api_key || process.env.ANTHROPIC_API_KEY || null;
}

export function getAiModel(): string {
  return readOptions().ai_model || process.env.BUDGETPRO_AI_MODEL || 'claude-opus-5';
}

export function getInboxDir(): string {
  const configured = readOptions().inbox_dir || process.env.BUDGETPRO_INBOX_DIR;
  if (configured) return configured;
  // /share only exists under Home Assistant; running locally, keep the
  // inbox next to the database instead of creating C:\share.
  return process.env.SUPERVISOR_TOKEN ? '/share/budgetpro/inbox' : path.join(DATA_DIR, 'inbox');
}

export type WeekendRule = 'none' | 'previous_business_day' | 'next_business_day';

export interface AppSettings {
  period_start_day: number;
  weekend_rule: WeekendRule;
  currency_symbol: string;
  ocr_engine: 'auto' | 'tesseract' | 'claude';
  publish_ha_sensors: boolean;
}

const DEFAULTS: AppSettings = {
  period_start_day: 25,
  weekend_rule: 'previous_business_day',
  currency_symbol: 'R',
  ocr_engine: 'auto',
  publish_ha_sensors: true,
};

function getRaw(key: string): string | undefined {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

function setRaw(key: string, value: string) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    value
  );
}

export function getSettings(): AppSettings {
  const stored = getRaw('app');
  if (!stored) return { ...DEFAULTS };
  try {
    return { ...DEFAULTS, ...JSON.parse(stored) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  const next = { ...getSettings(), ...patch };
  const day = Math.round(Number(next.period_start_day));
  next.period_start_day = Number.isFinite(day) ? Math.min(31, Math.max(1, day)) : DEFAULTS.period_start_day;
  if (!['none', 'previous_business_day', 'next_business_day'].includes(next.weekend_rule)) {
    next.weekend_rule = DEFAULTS.weekend_rule;
  }
  if (!['auto', 'tesseract', 'claude'].includes(next.ocr_engine)) next.ocr_engine = DEFAULTS.ocr_engine;
  next.publish_ha_sensors = Boolean(next.publish_ha_sensors);
  next.currency_symbol = String(next.currency_symbol || DEFAULTS.currency_symbol).slice(0, 5);
  setRaw('app', JSON.stringify(next));
  return next;
}

// The API/MCP token is generated server-side (Node's crypto — this is the
// backend, not a browser, so there is no secure-context concern) the first
// time it's needed and shown on the Settings page, which is only reachable
// through HA's authenticated Ingress.
export function getApiToken(): string {
  let token = getRaw('api_token');
  if (!token) {
    token = crypto.randomBytes(24).toString('base64url');
    setRaw('api_token', token);
  }
  return token;
}

export function regenerateApiToken(): string {
  const token = crypto.randomBytes(24).toString('base64url');
  setRaw('api_token', token);
  return token;
}
