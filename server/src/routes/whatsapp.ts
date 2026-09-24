import { Router } from 'express';
import { h } from '../util';
import { regenerateWhatsappKey, whatsappStatus } from '../whatsapp';

export const whatsappRouter = Router();

/** The callback key, allowed numbers, platform address and recent messages.
 *  Allowed numbers and the platform address are saved via PUT /api/settings. */
whatsappRouter.get(
  '/',
  h((_req, res) => res.json(whatsappStatus()))
);

whatsappRouter.post(
  '/regenerate-key',
  h((_req, res) => {
    regenerateWhatsappKey();
    res.json(whatsappStatus());
  })
);
