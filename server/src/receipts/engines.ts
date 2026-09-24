import fs from 'fs';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { createWorker, OEM, Worker } from 'tesseract.js';
import { extractTextItems } from 'unpdf';
import { DATA_DIR } from '../db';
import { getAiModel, getAnthropicKey } from '../settings';
import { ExtractedReceipt, parseReceiptText } from './parseText';

// ---- Plain text from a PDF slip (Checkers/Woolies/Dis-Chem e-slips) --------

/** Rebuilds visual lines from PDF text items by grouping on y position —
 *  a plain text dump would lose the "name ... price" pairing. */
export async function pdfText(buf: Buffer): Promise<string> {
  const { items } = await extractTextItems(new Uint8Array(buf));
  const out: string[] = [];
  for (const page of items) {
    const rows: { y: number; parts: { x: number; s: string }[] }[] = [];
    for (const it of page) {
      if (!it.str.trim()) continue;
      let row = rows.find((r) => Math.abs(r.y - it.y) < Math.max(2, it.height * 0.5));
      if (!row) {
        row = { y: it.y, parts: [] };
        rows.push(row);
      }
      row.parts.push({ x: it.x, s: it.str });
    }
    rows.sort((a, b) => b.y - a.y);
    for (const r of rows) out.push(r.parts.sort((a, b) => a.x - b.x).map((p) => p.s).join(' '));
  }
  return out.join('\n');
}

// ---- Tesseract (offline, bundled English model) -----------------------------

// The traineddata ships inside the npm package @tesseract.js-data/eng, so the
// add-on never downloads anything at runtime (the HA host may be offline, and
// it keeps the Docker build free of extra apt/curl steps).
const LANG_PATH = path.dirname(require.resolve('@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz'));

let workerPromise: Promise<Worker> | null = null;
function getWorker(): Promise<Worker> {
  if (!workerPromise) {
    const cachePath = path.join(DATA_DIR, 'tesseract-cache');
    fs.mkdirSync(cachePath, { recursive: true });
    workerPromise = createWorker('eng', OEM.LSTM_ONLY, { langPath: LANG_PATH, cachePath, gzip: true }).catch((e) => {
      workerPromise = null;
      throw e;
    });
  }
  return workerPromise;
}

// Tesseract reads slip-sized fonts reliably at roughly 30px+ per line of
// text; e-slip screenshots are often only ~420px wide, where it confuses
// 9/5/6. Upscaling small images first (bicubic, greyscale) helps; on four
// real 420px Checkers e-slips, 2x read 19 of 50 prices right against 8 at
// 3x and 4 unscaled, so small images are brought to ~840px. Jimp is pure
// JS, so no native build or apt packages are needed on the HA host.
const MIN_OCR_WIDTH = 840;

async function prepareForOcr(filePath: string): Promise<Buffer | string> {
  try {
    const { Jimp, ResizeStrategy } = await import('jimp');
    const img = await Jimp.read(filePath);
    if (img.width >= MIN_OCR_WIDTH) return filePath;
    const factor = Math.min(4, MIN_OCR_WIDTH / img.width);
    img.resize({ w: Math.round(img.width * factor), mode: ResizeStrategy.BICUBIC }).greyscale();
    return await img.getBuffer('image/png');
  } catch {
    return filePath; // formats Jimp can't decode go to tesseract as-is
  }
}

// One OCR at a time: tesseract is CPU-heavy and the host is a shared SBC.
let queue: Promise<unknown> = Promise.resolve();
export function tesseractText(filePath: string): Promise<string> {
  const job = queue.then(async () => {
    const worker = await getWorker();
    const { data } = await worker.recognize(await prepareForOcr(filePath));
    return data.text;
  });
  queue = job.catch(() => undefined);
  return job;
}

// ---- Claude (optional, much better at crumpled / faded slips) --------------

const RECEIPT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['merchant', 'date', 'total', 'items'],
  properties: {
    merchant: { type: ['string', 'null'], description: 'Store name as printed, e.g. "Checkers Hyper Fourways"' },
    date: { type: ['string', 'null'], description: 'Purchase date as YYYY-MM-DD' },
    total: { type: ['number', 'null'], description: 'Amount paid (the TOTAL / amount due), positive' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'barcode', 'quantity', 'amount', 'suggested_category'],
        properties: {
          name: { type: 'string', description: 'Product line exactly as printed' },
          barcode: { type: ['string', 'null'], description: 'The EAN/GTIN barcode digits printed with this line (e.g. "Item/GTIN 6001049058094"), or null' },
          quantity: { type: 'number' },
          amount: { type: 'number', description: 'Line total after any promotion on that line; negative for a discount line' },
          suggested_category: { type: ['string', 'null'], description: 'One of the provided category names, or null' },
        },
      },
    },
  },
} as const;

export function claudeAvailable(): boolean {
  return Boolean(getAnthropicKey());
}

export async function claudeExtract(buf: Buffer, mimeType: string, categoryNames: string[]): Promise<ExtractedReceipt> {
  const apiKey = getAnthropicKey();
  if (!apiKey) throw new Error('No Anthropic API key configured in the add-on options.');
  const client = new Anthropic({ apiKey });

  const data = buf.toString('base64');
  const media: Anthropic.Beta.BetaContentBlockParam =
    mimeType === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
      : {
          type: 'image',
          source: {
            type: 'base64',
            media_type: (['image/png', 'image/gif', 'image/webp'].includes(mimeType) ? mimeType : 'image/jpeg') as
              | 'image/jpeg'
              | 'image/png'
              | 'image/gif'
              | 'image/webp',
            data,
          },
        };

  const response = await client.beta.messages.create({
    model: getAiModel(),
    max_tokens: 16000,
    // Server-side fallback: if the primary model declines, the API re-runs
    // the request on a suitable fallback model inside the same call.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { format: { type: 'json_schema', schema: RECEIPT_SCHEMA as unknown as Record<string, unknown> } },
    messages: [
      {
        role: 'user',
        content: [
          media,
          {
            type: 'text',
            text:
              'This is a South African till slip. Extract the store, date, total paid, and every product line. ' +
              'Fold promotion/discount lines into the product they apply to where the slip makes that clear. ' +
              'Skip tender, change, VAT summary and loyalty-points lines. ' +
              `For each product, suggest one of these budget categories (or null if none fits): ${categoryNames.join(', ')}.`,
          },
        ],
      },
    ],
  });

  if (response.stop_reason === 'refusal') throw new Error('The model declined to read this slip.');
  const text = response.content.find((b) => b.type === 'text');
  if (!text || text.type !== 'text') throw new Error('No response from the model.');
  const parsed = JSON.parse(text.text) as ExtractedReceipt;
  return {
    merchant: parsed.merchant ?? null,
    date: parsed.date && /^\d{4}-\d{2}-\d{2}$/.test(parsed.date) ? parsed.date : null,
    total: typeof parsed.total === 'number' ? parsed.total : null,
    items: Array.isArray(parsed.items) ? parsed.items : [],
  };
}

export { parseReceiptText };
