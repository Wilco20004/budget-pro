import { Router } from 'express';
import multer from 'multer';
import { db } from '../db';
import { publishSensors } from '../ha';
import { importStatement } from '../importers';
import { inboxStatus, scanInbox } from '../inbox';
import { h, str } from '../util';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

export const importsRouter = Router();

importsRouter.get(
  '/',
  h((_req, res) => {
    res.json(
      db
        .prepare(
          `SELECT i.*, a.name AS account_name,
             (SELECT MIN(date) FROM transactions t WHERE t.import_id = i.id) AS first_date,
             (SELECT MAX(date) FROM transactions t WHERE t.import_id = i.id) AS last_date
           FROM imports i JOIN accounts a ON a.id = i.account_id ORDER BY i.created_at DESC LIMIT 100`
        )
        .all()
    );
  })
);

importsRouter.post(
  '/',
  upload.single('file'),
  h((req, res) => {
    if (!req.file) throw new Error('No file uploaded');
    const result = importStatement(str(req.body?.account_id), req.file.originalname, req.file.buffer, 'upload');
    publishSensors().catch(() => undefined);
    res.status(201).json(result);
  })
);

/** Undo an import: removes the transactions it created (not ones that were
 *  already there from an earlier, overlapping import). */
importsRouter.delete(
  '/:id',
  h((req, res) => {
    db.transaction(() => {
      db.prepare('DELETE FROM transactions WHERE import_id = ?').run(req.params.id);
      db.prepare('DELETE FROM imports WHERE id = ?').run(req.params.id);
    })();
    publishSensors().catch(() => undefined);
    res.status(204).end();
  })
);

importsRouter.get(
  '/inbox',
  h((_req, res) => res.json(inboxStatus()))
);

importsRouter.post(
  '/inbox/scan',
  h(async (_req, res) => res.json(await scanInbox()))
);
