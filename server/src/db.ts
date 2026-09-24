import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { v4 as uuid } from 'uuid';

export const DATA_DIR = process.env.BUDGETPRO_DATA_DIR || path.join(__dirname, '..', '..', 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

export const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

const dbPath = path.join(DATA_DIR, 'budgetpro.db');
export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export function now(): string {
  return new Date().toISOString();
}

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- An account is one bank account or card that statements get imported
  -- into. match_hint is matched against account numbers found inside an
  -- imported file (FNB CSVs carry the account number in their preamble) so
  -- files dropped in the inbox folder land on the right account.
  CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    bank TEXT NOT NULL DEFAULT 'other',
    type TEXT NOT NULL DEFAULT 'cheque',
    match_hint TEXT,
    -- Some card exports show purchases as positive numbers; flipping keeps
    -- "negative = money out" true for every account.
    flip_sign INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- kind decides how a category counts in the KPIs:
  --   expense  — money out, compared against its budget
  --   income   — money in (salary), compared against expected income
  --   savings  — money set aside; counts as "planned outflow" but reported
  --              separately so a big savings transfer doesn't look like overspend
  --   transfer — moving money between your own accounts; excluded entirely
  --   loan     — borrowed money in (1.18.0): not income, has to be repaid
  -- requires_slip = a transaction in this category isn't reconciled until a
  -- receipt is attached (the "smart" categories — groceries, medical, ...).
  CREATE TABLE IF NOT EXISTS categories (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL DEFAULT 'expense',
    color TEXT,
    icon TEXT,
    requires_slip INTEGER NOT NULL DEFAULT 0,
    default_budget REAL NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- Planned amount for one category in one budget period. A period is
  -- identified by its start date (YYYY-MM-DD); a missing row means "use the
  -- category's default_budget".
  CREATE TABLE IF NOT EXISTS budget_lines (
    period_start TEXT NOT NULL,
    category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    amount REAL NOT NULL,
    PRIMARY KEY (period_start, category_id)
  );

  -- A merchant is both an auto-categorisation rule (any transaction whose
  -- description contains one of its patterns gets its default category) and
  -- the "shop" a receipt came from (Checkers → Groceries by default, even
  -- though individual slip lines may be Kids or Medical).
  CREATE TABLE IF NOT EXISTS merchants (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    patterns TEXT NOT NULL,
    default_category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS imports (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    format TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'upload',
    row_count INTEGER NOT NULL DEFAULT 0,
    new_count INTEGER NOT NULL DEFAULT 0,
    duplicate_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  -- amount is signed from the account's point of view: negative = money out.
  -- fingerprint (account + date + amount + normalised description + an
  -- occurrence counter) is what stops re-importing an overlapping statement
  -- from creating duplicates.
  CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    import_id TEXT REFERENCES imports(id) ON DELETE SET NULL,
    date TEXT NOT NULL,
    description TEXT NOT NULL,
    amount REAL NOT NULL,
    balance REAL,
    fingerprint TEXT NOT NULL UNIQUE,
    merchant_id TEXT REFERENCES merchants(id) ON DELETE SET NULL,
    notes TEXT,
    ignored INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(date);

  -- How a transaction's amount is divided over categories. Same sign as the
  -- transaction. One split = simple categorisation; several = a Checkers slip
  -- that was part groceries, part nappies, part medicine. source records who
  -- made it: 'manual', 'rule' (merchant default) or 'receipt' (from slip lines).
  CREATE TABLE IF NOT EXISTS transaction_splits (
    id TEXT PRIMARY KEY,
    transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    amount REAL NOT NULL,
    note TEXT,
    source TEXT NOT NULL DEFAULT 'manual'
  );
  CREATE INDEX IF NOT EXISTS idx_splits_tx ON transaction_splits(transaction_id);

  -- status: pending → processing → parsed | failed.
  CREATE TABLE IF NOT EXISTS receipts (
    id TEXT PRIMARY KEY,
    file_path TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    original_name TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    error TEXT,
    engine TEXT,
    ocr_text TEXT,
    merchant_id TEXT REFERENCES merchants(id) ON DELETE SET NULL,
    merchant_name TEXT,
    receipt_date TEXT,
    total REAL,
    transaction_id TEXT REFERENCES transactions(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- The product database built up from slips: one row per distinct thing
  -- you buy ("HUGGIES DRY COMFORT 4 58S"), remembering which category it
  -- belongs to so the next slip with it is categorised automatically.
  CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY,
    name_key TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS receipt_items (
    id TEXT PRIMARY KEY,
    receipt_id TEXT NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
    product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
    raw_name TEXT NOT NULL,
    quantity REAL NOT NULL DEFAULT 1,
    amount REAL NOT NULL,
    category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
    sort_order INTEGER NOT NULL DEFAULT 0
  );

  -- Fallback for products never seen before: a slip line containing the
  -- keyword gets this category (NAPPIES → Kids, PANADO → Medical).
  CREATE TABLE IF NOT EXISTS category_keywords (
    id TEXT PRIMARY KEY,
    keyword TEXT NOT NULL UNIQUE,
    category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE
  );
`);

// ---- Migrations for databases created by an older version --------------------

function hasColumn(table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column);
}

// 1.2.0: products are identified by barcode (GTIN) when the slip prints one —
// OCR garbles names far more than the digit-only barcode line.
if (!hasColumn('products', 'barcode')) db.exec('ALTER TABLE products ADD COLUMN barcode TEXT');
if (!hasColumn('receipt_items', 'barcode')) db.exec('ALTER TABLE receipt_items ADD COLUMN barcode TEXT');
db.exec('CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode)');

// 1.3.0: transactions created from a bank's phone notification are
// provisional — the real statement line replaces them when it's imported.
if (!hasColumn('transactions', 'provisional')) {
  db.exec('ALTER TABLE transactions ADD COLUMN provisional INTEGER NOT NULL DEFAULT 0');
}

// 1.7.0: a slip-required transaction can be reconciled without a slip —
// 'lost' (the slip is gone) or 'single_category' (everything on it was the
// one category, so there's nothing to split). NULL = a slip is expected.
if (!hasColumn('transactions', 'no_slip_reason')) db.exec('ALTER TABLE transactions ADD COLUMN no_slip_reason TEXT');

// 1.9.0: every email seen in the receipts mailbox and what became of it,
// so each is processed once (message_id also catches a double forward).
db.exec(`
  CREATE TABLE IF NOT EXISTS emails (
    id TEXT PRIMARY KEY,
    uid INTEGER NOT NULL,
    uid_validity TEXT,
    message_id TEXT UNIQUE,
    received_at TEXT,
    from_addr TEXT,
    subject TEXT,
    status TEXT NOT NULL,
    detail TEXT,
    receipt_id TEXT REFERENCES receipts(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_emails_uid ON emails(uid_validity, uid);
`);
// 1.11.0: 'moved' / 'deleted' once an imported email was tidied out of the inbox.
if (!hasColumn('emails', 'mailbox_action')) db.exec('ALTER TABLE emails ADD COLUMN mailbox_action TEXT');

// 1.13.0: WhatsApp messages received through the NeuraCore callbacks, by
// the platform's message ID (retries repeat it). Strangers are kept only as
// the last digits of their number.
db.exec(`
  CREATE TABLE IF NOT EXISTS whatsapp_messages (
    id TEXT PRIMARY KEY,
    received_at TEXT,
    phone_tail TEXT,
    author TEXT,
    message_type TEXT,
    status TEXT NOT NULL,
    detail TEXT,
    receipt_id TEXT REFERENCES receipts(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL
  );
`);

// 1.5.0: display groups ("Fixed", "Living", "Lifestyle") — a layer over
// expense categories for dashboard/plan subtotals only. Budgets, splits and
// reconciling stay per category.
db.exec(`
  CREATE TABLE IF NOT EXISTS category_groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);
if (!hasColumn('categories', 'group_id')) {
  db.exec('ALTER TABLE categories ADD COLUMN group_id TEXT REFERENCES category_groups(id) ON DELETE SET NULL');
}

// Every notification Home Assistant forwards, and what became of it. Text
// is only kept for notifications that looked like they came from a bank —
// a stray WhatsApp message is logged as "not a bank notification" and its
// content discarded.
db.exec(`
  CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    received_at TEXT NOT NULL,
    package TEXT,
    title TEXT,
    text TEXT,
    status TEXT NOT NULL,
    reason TEXT,
    transaction_id TEXT REFERENCES transactions(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_notifications_received ON notifications(received_at);
`);

// 1.14.0: payment plans — a temporary commitment (PayJustNow, PayFlex, a
// medical account paid off monthly) that adds its instalments to a
// category's budget only in the periods they fall due, then drops off.
// ended_on = paid off early / cancelled: instalments due after it are dropped.
db.exec(`
  CREATE TABLE IF NOT EXISTS payment_plans (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    instalment REAL NOT NULL,
    instalments INTEGER NOT NULL,
    frequency TEXT NOT NULL DEFAULT 'monthly',
    first_due TEXT NOT NULL,
    match_pattern TEXT,
    notes TEXT,
    ended_on TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);
if (!hasColumn('transactions', 'payment_plan_id')) {
  db.exec('ALTER TABLE transactions ADD COLUMN payment_plan_id TEXT REFERENCES payment_plans(id) ON DELETE SET NULL');
}
// 1.15.0: savings goals. A goal is either
//   physical — it has its own account (tracks_account = 1) and its balance
//              is that account's balance once statements are imported, or
//   virtual  — a pot inside a shared account (or nowhere in particular):
//              its balance is opening_balance + its movements.
// Movements are top-ups (+) and withdrawals (−), entered by hand, allocated
// from a transaction, or linked automatically via match_pattern. topup is the
// planned contribution per period; it's added to category_id's budget.
db.exec(`
  CREATE TABLE IF NOT EXISTS savings_goals (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    icon TEXT,
    target REAL,
    target_date TEXT,
    account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
    tracks_account INTEGER NOT NULL DEFAULT 0,
    category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
    topup REAL NOT NULL DEFAULT 0,
    match_pattern TEXT,
    opening_balance REAL NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS savings_movements (
    id TEXT PRIMARY KEY,
    goal_id TEXT NOT NULL REFERENCES savings_goals(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    amount REAL NOT NULL,
    transaction_id TEXT REFERENCES transactions(id) ON DELETE CASCADE,
    note TEXT,
    source TEXT NOT NULL DEFAULT 'manual',
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_savings_movements_goal ON savings_movements(goal_id);
  CREATE INDEX IF NOT EXISTS idx_savings_movements_tx ON savings_movements(transaction_id);
`);

// 1.16.0: subcategories, one level deep (Groceries → Meat, Starch, …). A
// subcategory has its own splits, slip lines and (optional) budget; its
// parent's figures include it. It shares its parent's kind and group.
if (!hasColumn('categories', 'parent_id')) {
  db.exec('ALTER TABLE categories ADD COLUMN parent_id TEXT REFERENCES categories(id) ON DELETE SET NULL');
}

// 1.14.0: a personal category is one household member's spending money —
// its budget is their allowance, and anything allocated to it is theirs.
if (!hasColumn('categories', 'personal')) {
  db.exec('ALTER TABLE categories ADD COLUMN personal INTEGER NOT NULL DEFAULT 0');
}

// ---- Seed a sensible starting point on a brand-new database ----------------

const categoryCount = (db.prepare('SELECT COUNT(*) AS n FROM categories').get() as { n: number }).n;
if (categoryCount === 0) {
  const t = now();
  const insertCat = db.prepare(
    `INSERT INTO categories (id, name, kind, color, icon, requires_slip, default_budget, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
  );
  const seed: [string, string, string, string, number][] = [
    ['Salary', 'income', '#0ca30c', '💰', 0],
    ['Other income', 'income', '#1baf7a', '➕', 0],
    ['Groceries', 'expense', '#2a78d6', '🛒', 1],
    ['Kids', 'expense', '#e87ba4', '🧸', 1],
    ['Medical', 'expense', '#e34948', '💊', 1],
    ['Fuel', 'expense', '#eda100', '⛽', 1],
    ['Eating out', 'expense', '#eb6834', '🍔', 0],
    ['Household', 'expense', '#4a3aa7', '🏠', 1],
    ['Bond / Rent', 'expense', '#52514e', '🏦', 0],
    ['Utilities', 'expense', '#256abf', '💡', 0],
    ['Insurance', 'expense', '#184f95', '🛡️', 0],
    ['Phone & Internet', 'expense', '#1c5cab', '📶', 0],
    ['Subscriptions', 'expense', '#9085e9', '📺', 0],
    ['Bank fees', 'expense', '#898781', '🏧', 0],
    ['Personal care', 'expense', '#d55181', '🧴', 0],
    ['Entertainment', 'expense', '#199e70', '🎉', 0],
    ['Savings', 'savings', '#008300', '🐷', 0],
    ['Transfers', 'transfer', '#c3c2b7', '🔁', 0],
  ];
  const ids: Record<string, string> = {};
  seed.forEach(([name, kind, color, icon, slip], i) => {
    const id = uuid();
    ids[name] = id;
    insertCat.run(id, name, kind, color, icon, slip, i, t, t);
  });

  // South African retailers and billers as they show up on FNB / Discovery
  // statement lines. Patterns are case-insensitive substrings.
  const insertMerchant = db.prepare(
    `INSERT INTO merchants (id, name, patterns, default_category_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
  );
  const merchants: [string, string, string][] = [
    ['Salary', 'SALARY|SALARIS', 'Salary'],
    ['Checkers', 'CHECKERS', 'Groceries'],
    ['Shoprite', 'SHOPRITE', 'Groceries'],
    ['Pick n Pay', 'PICK N PAY|PNP ', 'Groceries'],
    ['Woolworths', 'WOOLWORTHS|WW ', 'Groceries'],
    ['Spar', 'SPAR', 'Groceries'],
    ['Food Lover\'s Market', 'FOOD LOVER', 'Groceries'],
    ['Dis-Chem', 'DIS-CHEM|DISCHEM', 'Medical'],
    ['Clicks', 'CLICKS', 'Medical'],
    ['Baby City', 'BABY CITY|BABYCITY', 'Kids'],
    ['Engen', 'ENGEN', 'Fuel'],
    ['Shell', 'SHELL', 'Fuel'],
    ['BP', 'BP ', 'Fuel'],
    ['Sasol', 'SASOL', 'Fuel'],
    ['Caltex / Astron', 'CALTEX|ASTRON', 'Fuel'],
    ['Builders', 'BUILDERS', 'Household'],
    ['Makro', 'MAKRO', 'Household'],
    ['Uber Eats', 'UBER EATS|UBEREATS', 'Eating out'],
    ['Mr D', 'MR D|MRD FOOD', 'Eating out'],
    ['Netflix', 'NETFLIX', 'Subscriptions'],
    ['Showmax', 'SHOWMAX', 'Subscriptions'],
    ['Spotify', 'SPOTIFY', 'Subscriptions'],
    ['DStv', 'DSTV|MULTICHOICE', 'Subscriptions'],
    ['Vodacom', 'VODACOM', 'Phone & Internet'],
    ['MTN', 'MTN ', 'Phone & Internet'],
    ['Telkom', 'TELKOM', 'Phone & Internet'],
    ['Prepaid electricity', 'PREPAID ELEC|ELECTRICITY|ESKOM', 'Utilities'],
    ['Bank fees', 'MONTHLY ACCOUNT FEE|SERVICE FEE|#MONTHLY|BANK CHARGE|ADMIN FEE', 'Bank fees'],
  ];
  for (const [name, patterns, cat] of merchants) {
    insertMerchant.run(uuid(), name, patterns, ids[cat] ?? null, t, t);
  }

  const insertKeyword = db.prepare('INSERT INTO category_keywords (id, keyword, category_id) VALUES (?, ?, ?)');
  const keywords: [string, string][] = [
    ['NAPPIES', 'Kids'], ['NAPPY', 'Kids'], ['DIAPER', 'Kids'], ['HUGGIES', 'Kids'], ['PAMPERS', 'Kids'],
    ['WIPES', 'Kids'], ['FORMULA', 'Kids'], ['PURITY', 'Kids'], ['NAN ', 'Kids'],
    ['PANADO', 'Medical'], ['MEDICINE', 'Medical'], ['SYRUP', 'Medical'], ['TABLETS', 'Medical'],
    ['VITAMIN', 'Medical'], ['PLASTERS', 'Medical'], ['CALPOL', 'Medical'], ['NUROFEN', 'Medical'],
    ['GRAND-PA', 'Medical'], ['STREPSILS', 'Medical'],
    ['DISHWASH', 'Household'], ['DETERGENT', 'Household'], ['BLEACH', 'Household'], ['TOILET PAPER', 'Household'],
    ['SERVIETTES', 'Household'], ['SUNLIGHT', 'Household'], ['HANDY ANDY', 'Household'], ['DOMESTOS', 'Household'],
    ['SHAMPOO', 'Personal care'], ['DEODORANT', 'Personal care'], ['TOOTHPASTE', 'Personal care'], ['LOTION', 'Personal care'],
  ];
  for (const [kw, cat] of keywords) {
    insertKeyword.run(uuid(), kw, ids[cat]);
  }
}

// ---- Versioned seed additions ------------------------------------------------
// Rules added after 1.0.0, applied once per database (new or existing) and
// recorded in settings, so a rule the user deletes doesn't come back.

function applySeed(version: string, merchants: [string, string, string][]) {
  const key = `seed_${version}`;
  if (db.prepare('SELECT 1 FROM settings WHERE key = ?').get(key)) return;
  const t = now();
  const catId = (name: string) =>
    (db.prepare('SELECT id FROM categories WHERE name = ?').get(name) as { id: string } | undefined)?.id ?? null;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO merchants (id, name, patterns, default_category_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
  );
  db.transaction(() => {
    for (const [name, patterns, cat] of merchants) insert.run(uuid(), name, patterns, catId(cat), t, t);
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, t);
  })();
}

// 1.12.0 slip keywords: "BABY" alone put Baby Marrows / Baby Corn under Kids,
// so it's replaced by specific baby products; plus lines seen on Sixty60
// orders. Once per database; a keyword that already exists is left alone.
(function seedKeywords2() {
  const key = 'seed_keywords_2';
  if (db.prepare('SELECT 1 FROM settings WHERE key = ?').get(key)) return;
  const catId = (name: string) =>
    (db.prepare('SELECT id FROM categories WHERE name = ?').get(name) as { id: string } | undefined)?.id ?? null;
  const add: [string, string][] = [
    ['BABY WIPES', 'Kids'], ['BABY FOOD', 'Kids'], ['BABY POWDER', 'Kids'], ['BABY OIL', 'Kids'], ['BABY LOTION', 'Kids'],
    ['BABY SHAMPOO', 'Kids'], ['BABY FORMULA', 'Kids'], ['GROWTH MILK', 'Kids'], ['GRWTH', 'Kids'],
    ['TOILET ROLL', 'Household'], ['FABRIC CONDITIONER', 'Household'], ['FABRIC SOFTENER', 'Household'], ['WASHING POWDER', 'Household'],
    ['HAIR SPRAY', 'Personal care'],
  ];
  db.transaction(() => {
    const kids = catId('Kids');
    if (kids) db.prepare("DELETE FROM category_keywords WHERE keyword = 'BABY' AND category_id = ?").run(kids);
    const exists = db.prepare('SELECT 1 FROM category_keywords WHERE upper(keyword) = ?');
    const ins = db.prepare('INSERT INTO category_keywords (id, keyword, category_id) VALUES (?, ?, ?)');
    for (const [kw, cat] of add) {
      const id = catId(cat);
      if (id && !exists.get(kw)) ins.run(uuid(), kw, id);
    }
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, now());
  })();
})();

// Starter groups, with the default categories (by name, if they still exist
// and aren't grouped yet) placed in them. Categories the user added stay
// ungrouped until they choose.
(function seedGroups() {
  const key = 'seed_groups_1';
  if (db.prepare('SELECT 1 FROM settings WHERE key = ?').get(key)) return;
  const groups: [string, string[]][] = [
    ['Fixed', ['Bond', 'Bond / Rent', 'Utilities', 'Insurance', 'Medical aid', 'Life cover', 'Phone & Internet', 'Subscriptions', 'Bank fees']],
    ['Living', ['Groceries', 'Kids', 'Medical', 'Fuel', 'Fuel / Toll', 'Household', 'Personal care']],
    ['Lifestyle', ['Eating out', 'Entertainment']],
  ];
  const t = now();
  db.transaction(() => {
    groups.forEach(([name, cats], i) => {
      const existing = db.prepare('SELECT id FROM category_groups WHERE name = ?').get(name) as { id: string } | undefined;
      const id = existing?.id ?? uuid();
      if (!existing) {
        db.prepare('INSERT INTO category_groups (id, name, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, name, i, t, t);
      }
      const set = db.prepare("UPDATE categories SET group_id = ? WHERE name = ? AND group_id IS NULL AND kind = 'expense'");
      for (const c of cats) set.run(id, c);
    });
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, t);
  })();
})();

applySeed('discovery_1', [
  // Moving money between your own accounts — excluded from spending.
  ['Own account transfer', 'INTER ACCOUNT TRANSFER', 'Transfers'],
  ['Discovery fees', 'MONTHLY FACILITY FEE|INTL PAYMENT FEE|DECLINED FEE|DECLINED DOM CARD|VITALITY MONEY', 'Bank fees'],
  ['Interest earned', 'INTEREST EARNED|DYNAMIC INTEREST BOOST', 'Other income'],
  ['Vitality Miles cash', 'MILES TRANSFER TO CASH', 'Other income'],
  ['Home loan', 'HOMEL|HOME LOAN|HOMELOAN', 'Bond / Rent'],
  ['Medical aid', 'KEYHEALTH|DISCOVERY HEALTH|MOMENTUM HEALTH|BONITAS|MEDSHIELD|FEDHEALTH', 'Insurance'],
  ['Life cover', 'DISCLIFE|OLD MUTUAL|SANLAM|LIBERTY LIFE', 'Insurance'],
]);

// 1.17.0: FNB statement lines that mean the same thing for every FNB
// customer. (Transfers named by the customer — "Transfer To CC" — can't be
// seeded; they're taught from the transaction.)
applySeed('fnb_1', [
  ['FNB credit card repayment', 'DEBICHECK INTERNAL D/O FNBCC|PAYMENT THANK YOU', 'Transfers'],
  ['FNB personal loan', 'FNB PLOAN', 'Debt repayments'],
  ['FNB interest charged', 'INT ON DEBIT BALANCE|ADJUST OF DR INTEREST', 'Bank fees'],
]);

// 1.18.0: a few seeded merchant patterns ended in a space but didn't start
// with one, so "BP " matched inside "Abp …" (an FNB loan repayment was
// filed as fuel). Patterns are matched against " DESCRIPTION ", so a leading
// space makes them whole words. Only the untouched seeded values change.
(function fixSeedPatterns() {
  const fix = db.prepare('UPDATE merchants SET patterns = ? WHERE patterns = ?');
  for (const [from, to] of [
    ['BP ', ' BP '],
    ['PICK N PAY|PNP ', 'PICK N PAY| PNP '],
    ['WOOLWORTHS|WW ', 'WOOLWORTHS| WW '],
    ['MTN ', ' MTN '],
  ]) fix.run(to, from);
})();

// 1.18.0: borrowed money. A category of kind 'loan' holds money in that has
// to be paid back (a short-term loan, an overdraft top-up): not income, but
// cash that funds the period. Its repayment is a payment plan, linked to the
// transaction that brought the money in.
if (!hasColumn('payment_plans', 'loan_transaction_id')) {
  db.exec('ALTER TABLE payment_plans ADD COLUMN loan_transaction_id TEXT REFERENCES transactions(id) ON DELETE SET NULL');
}
(function seedBorrowed() {
  const key = 'seed_borrowed_1';
  if (db.prepare('SELECT 1 FROM settings WHERE key = ?').get(key)) return;
  const t = now();
  db.transaction(() => {
    let cat = db.prepare("SELECT id FROM categories WHERE kind = 'loan' LIMIT 1").get() as { id: string } | undefined;
    if (!cat && !db.prepare("SELECT 1 FROM categories WHERE name = 'Borrowed'").get()) {
      cat = { id: uuid() };
      const order = ((db.prepare('SELECT MAX(sort_order) AS m FROM categories').get() as { m: number | null }).m ?? 0) + 1;
      db.prepare(
        `INSERT INTO categories (id, name, kind, color, icon, requires_slip, default_budget, sort_order, created_at, updated_at)
         VALUES (?, 'Borrowed', 'loan', '#c98500', '🤝', 0, 0, ?, ?, ?)`
      ).run(cat.id, order, t, t);
    }
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, t);
  })();
})();
applySeed('fnb_2', [['FNB short-term loan', 'SHORT TERM LOAN CREDIT', 'Borrowed']]);

// 1.19.0: debt accounts (type credit or loan). What you owe comes from the
// statements; these are the plan: the repayment you intend each period, and
// optionally the rate and limit for the payoff estimate and utilisation.
for (const [col, def] of [
  ['planned_payment', 'REAL'],
  ['interest_rate', 'REAL'],
  ['credit_limit', 'REAL'],
] as const) {
  if (!hasColumn('accounts', col)) db.exec(`ALTER TABLE accounts ADD COLUMN ${col} ${def}`);
}

// 1.20.0: each tracked card/loan has its own subcategory under Debt
// repayments. Its budget is the planned repayment; its actual is the debt's
// interest, fees and cover plus how much the balance came down.
if (!hasColumn('accounts', 'debt_category_id')) {
  db.exec('ALTER TABLE accounts ADD COLUMN debt_category_id TEXT REFERENCES categories(id) ON DELETE SET NULL');
}
