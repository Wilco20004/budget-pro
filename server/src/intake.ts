import path from 'path';
import { importStatement } from './importers';
import { parseStatement } from './importers/parse';
import { processReceipt, saveReceiptFile } from './receipts/service';

// One file arriving from outside (an email attachment, a WhatsApp message):
// a statement if a statement reader recognises it, else a slip if it's a
// photo or PDF. Shared so every channel files things the same way.

export type IntakeResult =
  | { kind: 'statement'; detail: string }
  | { kind: 'receipt'; detail: string; receipt_id: string }
  | { kind: 'skipped'; detail: string };

const STATEMENT_EXT = ['.csv', '.ofx', '.qfx'];
export const SLIP_IMAGE = /^image\/(jpeg|png|webp|gif|heic|heif)$/i;

export async function importIncomingFile(
  buf: Buffer,
  filename: string,
  mimeType: string,
  source: 'email' | 'whatsapp'
): Promise<IntakeResult> {
  const ext = path.extname(filename).toLowerCase();
  const mime = mimeType.toLowerCase().replace('image/jpg', 'image/jpeg');
  if (STATEMENT_EXT.includes(ext)) {
    const r = await importStatement(null, filename, buf, source);
    return { kind: 'statement', detail: `${filename}: ${r.new_count} new transactions` };
  }
  if (mime === 'application/pdf' || ext === '.pdf') {
    let isStatement = false;
    try {
      isStatement = (await parseStatement(filename, buf)).rows.length > 0;
    } catch {
      isStatement = false;
    }
    if (isStatement) {
      const r = await importStatement(null, filename, buf, source);
      return { kind: 'statement', detail: `${filename}: ${r.new_count} new transactions` };
    }
    const id = saveReceiptFile(buf, filename, 'application/pdf');
    await processReceipt(id);
    return { kind: 'receipt', detail: `${filename}: slip added`, receipt_id: id };
  }
  if (SLIP_IMAGE.test(mime)) {
    const id = saveReceiptFile(buf, filename, mime);
    await processReceipt(id);
    return { kind: 'receipt', detail: `${filename}: slip added`, receipt_id: id };
  }
  return { kind: 'skipped', detail: `${filename}: not a slip or statement (${mime})` };
}
