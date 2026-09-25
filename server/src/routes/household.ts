import { Router } from 'express';
import { accountBreakdown, settleUp } from '../services/household';
import { resolvePeriod } from '../services/periods';
import { getSettings, updateSettings } from '../settings';
import { h } from '../util';

export const householdRouter = Router();

/** Each account's spending in a period, by category and payment method. */
householdRouter.get(
  '/accounts',
  h((req, res) => res.json(accountBreakdown(resolvePeriod(req.query.period))))
);

/** Who paid the shared costs, and who should transfer what to even out. */
householdRouter.get(
  '/settle',
  h((req, res) => res.json(settleUp(resolvePeriod(req.query.period))))
);

/** Body: any of split ('income' | 'equal'); shared {key, shared} to mark a
 *  category shared or not (whoever pays an unshared one carries it); and
 *  incoming [{pattern, member_id}] — money in worded like that is from
 *  that member. */
householdRouter.put(
  '/settle',
  h((req, res) => {
    const body = req.body ?? {};
    const s = getSettings();
    const exclude = new Set(s.settle_exclude);
    if (body.shared && typeof body.shared.key === 'string') {
      if (body.shared.shared) exclude.delete(body.shared.key);
      else exclude.add(body.shared.key);
    }
    updateSettings({
      settle_split: body.split ?? s.settle_split,
      settle_exclude: [...exclude],
      settle_incoming: Array.isArray(body.incoming) ? body.incoming : s.settle_incoming,
    });
    res.json(settleUp(resolvePeriod(req.query.period)));
  })
);
