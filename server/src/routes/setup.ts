import os from 'os';
import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { db, now } from '../db';
import { homeAssistantAvailable, publishSensors } from '../ha';
import { emailStatus } from '../email/importer';
import { inboxStatus } from '../inbox';
import { claudeAvailable } from '../receipts/engines';
import { autoCategorize, suggestMerchantPattern } from '../services/categorize';
import { currentPeriod, periodFor, recentPeriods, nextPeriod } from '../services/periods';
import { getAiModel, getApiToken, getSettings, regenerateApiToken, updateSettings } from '../settings';
import { h, notFound, num, str } from '../util';

// Settings, periods, accounts, categories, keywords and merchants — the
// small "configuration" resources, kept together.

export const settingsRouter = Router();

settingsRouter.get(
  '/',
  h((_req, res) => {
    res.json({
      ...getSettings(),
      api_token: getApiToken(),
      home_assistant: homeAssistantAvailable(),
      claude_available: claudeAvailable(),
      ai_model: getAiModel(),
      inbox: inboxStatus(),
      email: emailStatus(),
      // How Home Assistant itself reaches this add-on (for the notification
      // automation): add-on containers are addressable by their hostname on
      // the Supervisor network. Unknown when running outside HA.
      internal_url: homeAssistantAvailable() ? `http://${os.hostname()}:8097` : null,
    });
  })
);

settingsRouter.put(
  '/',
  h((req, res) => {
    const s = updateSettings(req.body ?? {});
    publishSensors().catch(() => undefined);
    res.json(s);
  })
);

settingsRouter.post(
  '/regenerate-token',
  h((_req, res) => res.json({ api_token: regenerateApiToken() }))
);

export const periodsRouter = Router();

periodsRouter.get(
  '/',
  h((req, res) => {
    const count = Math.min(36, Math.max(1, num(req.query.count, 12)));
    const cur = currentPeriod();
    // Include the next period too so its budget can be planned ahead.
    res.json({ current: cur, periods: [...recentPeriods(count, cur), nextPeriod(cur)].reverse() });
  })
);

periodsRouter.get(
  '/for/:date',
  h((req, res) => res.json(periodFor(String(req.params.date))))
);

// ---- Accounts ---------------------------------------------------------------

export const accountsRouter = Router();

accountsRouter.get(
  '/',
  h((_req, res) => {
    res.json(
      db
        .prepare(
          `SELECT a.*,
             (SELECT COUNT(*) FROM transactions t WHERE t.account_id = a.id) AS transaction_count,
             (SELECT MAX(date) FROM transactions t WHERE t.account_id = a.id) AS last_transaction_date,
             (SELECT balance FROM transactions t WHERE t.account_id = a.id AND balance IS NOT NULL ORDER BY date DESC, created_at DESC LIMIT 1) AS last_balance
           FROM accounts a ORDER BY a.name`
        )
        .all()
    );
  })
);

function accountInput(body: Record<string, unknown>) {
  const name = str(body.name);
  if (!name) throw new Error('Name is required');
  return {
    name,
    bank: str(body.bank) ?? 'other',
    type: str(body.type) ?? 'cheque',
    match_hint: str(body.match_hint),
    flip_sign: body.flip_sign ? 1 : 0,
  };
}

accountsRouter.post(
  '/',
  h((req, res) => {
    const a = accountInput(req.body ?? {});
    const id = uuid();
    const t = now();
    db.prepare(
      'INSERT INTO accounts (id, name, bank, type, match_hint, flip_sign, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, a.name, a.bank, a.type, a.match_hint, a.flip_sign, t, t);
    res.status(201).json(db.prepare('SELECT * FROM accounts WHERE id = ?').get(id));
  })
);

accountsRouter.put(
  '/:id',
  h((req, res) => {
    const a = accountInput(req.body ?? {});
    const r = db
      .prepare('UPDATE accounts SET name = ?, bank = ?, type = ?, match_hint = ?, flip_sign = ?, updated_at = ? WHERE id = ?')
      .run(a.name, a.bank, a.type, a.match_hint, a.flip_sign, now(), req.params.id);
    if (!r.changes) notFound('Account not found');
    res.json(db.prepare('SELECT * FROM accounts WHERE id = ?').get(req.params.id));
  })
);

accountsRouter.delete(
  '/:id',
  h((req, res) => {
    db.prepare('DELETE FROM accounts WHERE id = ?').run(req.params.id);
    res.status(204).end();
  })
);

// ---- Categories -------------------------------------------------------------

export const categoriesRouter = Router();

categoriesRouter.get(
  '/',
  h((_req, res) => {
    res.json(db.prepare('SELECT * FROM categories ORDER BY sort_order, name').all());
  })
);

function categoryInput(body: Record<string, unknown>) {
  const name = str(body.name);
  if (!name) throw new Error('Name is required');
  const kind = str(body.kind) ?? 'expense';
  if (!['expense', 'income', 'savings', 'transfer'].includes(kind)) throw new Error('Invalid kind');
  return {
    name,
    kind,
    color: str(body.color),
    icon: str(body.icon),
    requires_slip: body.requires_slip ? 1 : 0,
    default_budget: num(body.default_budget),
    sort_order: Math.round(num(body.sort_order)),
    archived: body.archived ? 1 : 0,
    // Groups only apply to spending; other kinds are shown in their own sections.
    group_id: kind === 'expense' ? str(body.group_id) : null,
  };
}

categoriesRouter.post(
  '/',
  h((req, res) => {
    const c = categoryInput(req.body ?? {});
    const id = uuid();
    const t = now();
    if (!req.body?.sort_order) {
      c.sort_order = ((db.prepare('SELECT MAX(sort_order) AS m FROM categories').get() as { m: number | null }).m ?? 0) + 1;
    }
    db.prepare(
      `INSERT INTO categories (id, name, kind, color, icon, requires_slip, default_budget, sort_order, archived, group_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, c.name, c.kind, c.color, c.icon, c.requires_slip, c.default_budget, c.sort_order, c.archived, c.group_id, t, t);
    res.status(201).json(db.prepare('SELECT * FROM categories WHERE id = ?').get(id));
  })
);

categoriesRouter.put(
  '/:id',
  h((req, res) => {
    const c = categoryInput(req.body ?? {});
    const r = db
      .prepare(
        `UPDATE categories SET name = ?, kind = ?, color = ?, icon = ?, requires_slip = ?, default_budget = ?, sort_order = ?, archived = ?, group_id = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(c.name, c.kind, c.color, c.icon, c.requires_slip, c.default_budget, c.sort_order, c.archived, c.group_id, now(), req.params.id);
    if (!r.changes) notFound('Category not found');
    publishSensors().catch(() => undefined);
    res.json(db.prepare('SELECT * FROM categories WHERE id = ?').get(req.params.id));
  })
);

categoriesRouter.delete(
  '/:id',
  h((req, res) => {
    const used = db.prepare('SELECT COUNT(*) AS n FROM transaction_splits WHERE category_id = ?').get(req.params.id) as {
      n: number;
    };
    if (used.n > 0) {
      throw new Error(`${used.n} transaction(s) use this category — archive it instead, or move them first.`);
    }
    db.prepare('DELETE FROM categories WHERE id = ?').run(req.params.id);
    res.status(204).end();
  })
);

// ---- Category groups (display only) -----------------------------------------

export const groupsRouter = Router();

groupsRouter.get(
  '/',
  h((_req, res) => {
    res.json(
      db
        .prepare(
          `SELECT g.*, (SELECT COUNT(*) FROM categories c WHERE c.group_id = g.id AND c.archived = 0) AS category_count
           FROM category_groups g ORDER BY g.sort_order, g.name`
        )
        .all()
    );
  })
);

groupsRouter.post(
  '/',
  h((req, res) => {
    const name = str(req.body?.name);
    if (!name) throw new Error('Name is required');
    const id = uuid();
    const t = now();
    const order = ((db.prepare('SELECT MAX(sort_order) AS m FROM category_groups').get() as { m: number | null }).m ?? -1) + 1;
    db.prepare('INSERT INTO category_groups (id, name, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, name, order, t, t);
    res.status(201).json(db.prepare('SELECT * FROM category_groups WHERE id = ?').get(id));
  })
);

groupsRouter.put(
  '/:id',
  h((req, res) => {
    const name = str(req.body?.name);
    if (!name) throw new Error('Name is required');
    const r = db
      .prepare('UPDATE category_groups SET name = ?, sort_order = ?, updated_at = ? WHERE id = ?')
      .run(name, Math.round(num(req.body?.sort_order)), now(), req.params.id);
    if (!r.changes) notFound('Group not found');
    publishSensors().catch(() => undefined);
    res.json(db.prepare('SELECT * FROM category_groups WHERE id = ?').get(req.params.id));
  })
);

/** Deleting a group just ungroups its categories. */
groupsRouter.delete(
  '/:id',
  h((req, res) => {
    db.transaction(() => {
      db.prepare('UPDATE categories SET group_id = NULL WHERE group_id = ?').run(req.params.id);
      db.prepare('DELETE FROM category_groups WHERE id = ?').run(req.params.id);
    })();
    publishSensors().catch(() => undefined);
    res.status(204).end();
  })
);

export const keywordsRouter = Router();

keywordsRouter.get(
  '/',
  h((_req, res) => {
    res.json(
      db
        .prepare(
          'SELECT k.*, c.name AS category_name FROM category_keywords k JOIN categories c ON c.id = k.category_id ORDER BY k.keyword'
        )
        .all()
    );
  })
);

keywordsRouter.post(
  '/',
  h((req, res) => {
    const keyword = str(req.body?.keyword)?.toUpperCase();
    const category_id = str(req.body?.category_id);
    if (!keyword || !category_id) throw new Error('Keyword and category are required');
    db.prepare(
      'INSERT INTO category_keywords (id, keyword, category_id) VALUES (?, ?, ?) ON CONFLICT(keyword) DO UPDATE SET category_id = excluded.category_id'
    ).run(uuid(), keyword, category_id);
    res.status(201).json({ ok: true });
  })
);

keywordsRouter.delete(
  '/:id',
  h((req, res) => {
    db.prepare('DELETE FROM category_keywords WHERE id = ?').run(req.params.id);
    res.status(204).end();
  })
);

// ---- Merchants (auto-categorisation rules) ------------------------------------

export const merchantsRouter = Router();

merchantsRouter.get(
  '/',
  h((_req, res) => {
    res.json(
      db
        .prepare(
          `SELECT m.*, c.name AS category_name,
             (SELECT COUNT(*) FROM transactions t WHERE t.merchant_id = m.id) AS transaction_count
           FROM merchants m LEFT JOIN categories c ON c.id = m.default_category_id ORDER BY m.name`
        )
        .all()
    );
  })
);

merchantsRouter.get(
  '/suggest',
  h((req, res) => res.json({ pattern: suggestMerchantPattern(String(req.query.description ?? '')) }))
);

function merchantInput(body: Record<string, unknown>) {
  const name = str(body.name);
  const patterns = str(body.patterns)?.toUpperCase();
  if (!name || !patterns) throw new Error('Name and at least one pattern are required');
  return { name, patterns, default_category_id: str(body.default_category_id) };
}

merchantsRouter.post(
  '/',
  h((req, res) => {
    const m = merchantInput(req.body ?? {});
    const id = uuid();
    const t = now();
    db.prepare(
      'INSERT INTO merchants (id, name, patterns, default_category_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(id, m.name, m.patterns, m.default_category_id, t, t);
    const applied = autoCategorize();
    res.status(201).json({ ...(db.prepare('SELECT * FROM merchants WHERE id = ?').get(id) as object), applied });
  })
);

merchantsRouter.put(
  '/:id',
  h((req, res) => {
    const m = merchantInput(req.body ?? {});
    const r = db
      .prepare('UPDATE merchants SET name = ?, patterns = ?, default_category_id = ?, updated_at = ? WHERE id = ?')
      .run(m.name, m.patterns, m.default_category_id, now(), req.params.id);
    if (!r.changes) notFound('Merchant not found');
    const applied = autoCategorize();
    res.json({ ...(db.prepare('SELECT * FROM merchants WHERE id = ?').get(req.params.id) as object), applied });
  })
);

merchantsRouter.delete(
  '/:id',
  h((req, res) => {
    db.prepare('DELETE FROM merchants WHERE id = ?').run(req.params.id);
    res.status(204).end();
  })
);

/** Re-runs the rules over every still-uncategorised transaction. */
merchantsRouter.post(
  '/apply',
  h((_req, res) => res.json({ applied: autoCategorize() }))
);
