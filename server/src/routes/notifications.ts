import { Router } from 'express';
import { db } from '../db';
import { publishSensors } from '../ha';
import { ingestNotification } from '../notifications/service';
import { h, num } from '../util';

export const notificationsRouter = Router();

/** Home Assistant's automation posts each phone notification here:
 *  { package, title, text, big_text, posted_at }. Always answers 200 with
 *  what happened, so HA doesn't log errors for the (many) non-bank ones. */
notificationsRouter.post(
  '/',
  h((req, res) => {
    const b = req.body ?? {};
    const s = (v: unknown) => (typeof v === 'string' ? v : v === null || v === undefined ? null : String(v));
    const result = ingestNotification({
      package: s(b.package),
      title: s(b.title),
      text: s(b.text),
      big_text: s(b.big_text),
      posted_at: typeof b.posted_at === 'number' ? b.posted_at : s(b.posted_at),
    });
    if (result.status === 'imported') publishSensors().catch(() => undefined);
    res.json(result);
  })
);

notificationsRouter.get(
  '/',
  h((req, res) => {
    const limit = Math.min(500, Math.max(1, num(req.query.limit, 100)));
    res.json(
      db
        .prepare(
          `SELECT n.*, t.description AS transaction_description, t.amount AS transaction_amount, t.provisional
           FROM notifications n LEFT JOIN transactions t ON t.id = n.transaction_id
           ORDER BY n.received_at DESC LIMIT ?`
        )
        .all(limit)
    );
  })
);
