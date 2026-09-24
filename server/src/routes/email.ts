import { Router } from 'express';
import { checkEmail, emailStatus, reprocessEmail } from '../email/importer';
import { h } from '../util';

export const emailRouter = Router();

/** Mailbox connection state and the last emails handled. */
emailRouter.get(
  '/',
  h((_req, res) => res.json(emailStatus()))
);

/** Check the mailbox now instead of waiting for the next 5-minute round. */
emailRouter.post(
  '/check',
  h(async (_req, res) => {
    const r = await checkEmail();
    res.json({ ...r, ...emailStatus() });
  })
);

emailRouter.post(
  '/:uid/reprocess',
  h(async (req, res) => {
    const uid = Number(req.params.uid);
    if (!Number.isInteger(uid)) throw new Error('uid must be a number');
    res.json(await reprocessEmail(uid));
  })
);
