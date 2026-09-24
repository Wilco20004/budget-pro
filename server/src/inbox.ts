import fs from 'fs';
import path from 'path';
import { db } from './db';
import { publishSensors } from './ha';
import { importStatement } from './importers';
import { processReceipt, saveReceiptFile } from './receipts/service';
import { getInboxDir } from './settings';

// The "automatic" import path. Drop files into the inbox folder (it's under
// HA's /share, so reachable over the Samba add-on, a phone file-sync app, or
// an email-to-folder automation):
//   inbox/            bank statements (CSV / OFX) — matched to an account
//                     by the account number inside the file
//   inbox/<account>/  statements for a specific account (folder name =
//                     account name or match hint), for files with no number
//   inbox/receipts/   slip photos and PDFs
// Processed files move to inbox/processed/, failures to inbox/failed/ with a
// .error.txt beside them.

const STATEMENT_EXT = ['.csv', '.ofx', '.qfx', '.txt'];
const RECEIPT_EXT = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.pdf'];

interface InboxLogEntry {
  at: string;
  file: string;
  ok: boolean;
  message: string;
}
const log: InboxLogEntry[] = [];

export function inboxStatus() {
  const dir = getInboxDir();
  return { dir, exists: fs.existsSync(dir), recent: log.slice(-20).reverse() };
}

function move(file: string, destDir: string) {
  fs.mkdirSync(destDir, { recursive: true });
  const base = path.basename(file);
  let dest = path.join(destDir, base);
  if (fs.existsSync(dest)) dest = path.join(destDir, `${Date.now()}-${base}`);
  fs.renameSync(file, dest);
  return dest;
}

function mimeFor(file: string) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.pdf') return 'application/pdf';
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/jpeg';
}

// Skip files still being written (a Samba copy in progress).
function settled(file: string) {
  try {
    return Date.now() - fs.statSync(file).mtimeMs > 5000;
  } catch {
    return false;
  }
}

function accountIdForFolder(folder: string): string | null {
  const row = db
    .prepare('SELECT id FROM accounts WHERE lower(name) = lower(?) OR match_hint = ?')
    .get(folder, folder) as { id: string } | undefined;
  return row?.id ?? null;
}

let scanning = false;

export async function scanInbox(): Promise<{ processed: number; failed: number }> {
  const dir = getInboxDir();
  if (scanning || !fs.existsSync(dir)) return { processed: 0, failed: 0 };
  scanning = true;
  let processed = 0;
  let failed = 0;
  const record = (file: string, ok: boolean, message: string) => {
    log.push({ at: new Date().toISOString(), file: path.relative(dir, file), ok, message });
    if (log.length > 200) log.shift();
  };
  try {
    const jobs: { file: string; kind: 'statement' | 'receipt'; accountId: string | null }[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && STATEMENT_EXT.includes(path.extname(entry.name).toLowerCase())) {
        jobs.push({ file: full, kind: 'statement', accountId: null });
      } else if (entry.isDirectory() && !['processed', 'failed'].includes(entry.name)) {
        const isReceipts = entry.name.toLowerCase() === 'receipts';
        const accountId = isReceipts ? null : accountIdForFolder(entry.name);
        for (const f of fs.readdirSync(full, { withFileTypes: true })) {
          if (!f.isFile()) continue;
          const ext = path.extname(f.name).toLowerCase();
          if (isReceipts && RECEIPT_EXT.includes(ext)) jobs.push({ file: path.join(full, f.name), kind: 'receipt', accountId: null });
          else if (!isReceipts && STATEMENT_EXT.includes(ext)) jobs.push({ file: path.join(full, f.name), kind: 'statement', accountId });
        }
      }
    }
    for (const job of jobs) {
      if (!settled(job.file)) continue;
      try {
        const buf = fs.readFileSync(job.file);
        if (job.kind === 'statement') {
          const r = importStatement(job.accountId, path.basename(job.file), buf, 'inbox');
          record(job.file, true, `${r.new_count} new, ${r.duplicate_count} already imported`);
        } else {
          const id = saveReceiptFile(buf, path.basename(job.file), mimeFor(job.file));
          await processReceipt(id);
          record(job.file, true, 'Slip added');
        }
        move(job.file, path.join(dir, 'processed'));
        processed++;
      } catch (e) {
        const msg = (e as Error).message;
        record(job.file, false, msg);
        const dest = move(job.file, path.join(dir, 'failed'));
        fs.writeFileSync(dest + '.error.txt', msg + '\n');
        failed++;
      }
    }
  } finally {
    scanning = false;
  }
  if (processed) publishSensors().catch(() => undefined);
  return { processed, failed };
}

export function startInboxWatcher() {
  const dir = getInboxDir();
  try {
    fs.mkdirSync(path.join(dir, 'receipts'), { recursive: true });
  } catch {
    // /share not mapped (dev mode) — the watcher just finds nothing.
  }
  setInterval(() => scanInbox().catch((e) => console.warn('[budgetpro] inbox scan failed:', e.message)), 60_000);
  setTimeout(() => scanInbox().catch(() => undefined), 5_000);
}
