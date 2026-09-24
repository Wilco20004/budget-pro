import fs from 'fs';
import path from 'path';
import { Router } from 'express';
import multer from 'multer';
import { db, UPLOADS_DIR } from '../db';
import { publishSensors } from '../ha';
import { h } from '../util';

// One-file backup of everything — for moving BudgetPro between machines
// (e.g. a trial run on a PC to the Home Assistant add-on). It's JSON rather
// than a raw copy of the SQLite file so it restores into a newer version:
// columns are matched by name, and ones that don't exist are skipped.

const FORMAT = 'budgetpro-backup';

// Parents before children (the order rows are inserted in).
const TABLES = [
  'settings',
  'accounts',
  'category_groups',
  'categories',
  'budget_lines',
  'payment_plans',
  'savings_goals',
  'merchants',
  'imports',
  'transactions',
  'transaction_splits',
  'savings_movements',
  'receipts',
  'products',
  'receipt_items',
  'emails',
  'whatsapp_messages',
  'category_keywords',
  'notifications',
];

// Each install keeps its own API token: restoring must not break the Home
// Assistant automation or AI clients already set up against this one.
const KEEP_LOCAL_SETTINGS = ['api_token', 'whatsapp_key'];

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } });

function columns(table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
}

export const backupRouter = Router();

backupRouter.get(
  '/',
  h((_req, res) => {
    const tables: Record<string, unknown[]> = {};
    for (const t of TABLES) {
      tables[t] =
        t === 'settings'
          ? db.prepare(`SELECT * FROM settings WHERE key NOT IN (${KEEP_LOCAL_SETTINGS.map(() => '?').join(',')})`).all(...KEEP_LOCAL_SETTINGS)
          : db.prepare(`SELECT * FROM ${t}`).all();
    }
    // Slip images, so a restored slip still shows its photo.
    const files: Record<string, string> = {};
    for (const r of db.prepare("SELECT file_path FROM receipts WHERE file_path != ''").all() as { file_path: string }[]) {
      const abs = path.join(UPLOADS_DIR, r.file_path);
      if (fs.existsSync(abs)) files[r.file_path] = fs.readFileSync(abs).toString('base64');
    }
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Disposition', `attachment; filename="budgetpro-backup-${stamp}.json"`);
    res.json({ format: FORMAT, exported_at: new Date().toISOString(), tables, files });
  })
);

/** Replaces ALL data here with the backup's (except this install's API
 *  token). Runs in one transaction: a bad file changes nothing. */
backupRouter.post(
  '/restore',
  upload.single('file'),
  h((req, res) => {
    if (!req.file) throw new Error('No file uploaded');
    let backup: { format?: string; tables?: Record<string, Record<string, unknown>[]>; files?: Record<string, string> };
    try {
      backup = JSON.parse(req.file.buffer.toString('utf-8'));
    } catch {
      throw new Error('That file isn’t a BudgetPro backup (not valid JSON).');
    }
    if (backup.format !== FORMAT || !backup.tables) throw new Error('That file isn’t a BudgetPro backup.');
    const tables = backup.tables;

    const counts: Record<string, number> = {};
    // Foreign keys off for the swap (rows arrive parents-first anyway), then
    // verified afterwards; the pragma can't change inside a transaction.
    db.pragma('foreign_keys = OFF');
    try {
      db.transaction(() => {
        for (const t of [...TABLES].reverse()) {
          if (t === 'settings') {
            db.prepare(`DELETE FROM settings WHERE key NOT IN (${KEEP_LOCAL_SETTINGS.map(() => '?').join(',')})`).run(...KEEP_LOCAL_SETTINGS);
          } else {
            db.prepare(`DELETE FROM ${t}`).run();
          }
        }
        for (const t of TABLES) {
          const rows = Array.isArray(tables[t]) ? tables[t] : [];
          const have = new Set(columns(t));
          let n = 0;
          for (const row of rows) {
            if (t === 'settings' && KEEP_LOCAL_SETTINGS.includes(String(row.key))) continue;
            const cols = Object.keys(row).filter((c) => have.has(c));
            if (!cols.length) continue;
            db.prepare(`INSERT OR REPLACE INTO ${t} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(
              ...cols.map((c) => row[c] as unknown)
            );
            n++;
          }
          counts[t] = n;
        }
        const broken = db.prepare('PRAGMA foreign_key_check').all();
        if (broken.length) throw new Error(`The backup has ${broken.length} broken reference(s) — nothing was changed.`);
      })();
    } finally {
      db.pragma('foreign_keys = ON');
    }

    // Slip images. Paths come from the file, so only accept our own layout.
    let fileCount = 0;
    for (const [rel, b64] of Object.entries(backup.files ?? {})) {
      if (!/^receipts\/[\w-]+\.[a-z0-9]{2,5}$/i.test(rel)) continue;
      fs.mkdirSync(path.join(UPLOADS_DIR, 'receipts'), { recursive: true });
      fs.writeFileSync(path.join(UPLOADS_DIR, rel), Buffer.from(b64, 'base64'));
      fileCount++;
    }
    publishSensors().catch(() => undefined);
    res.json({ ok: true, counts, files: fileCount });
  })
);
