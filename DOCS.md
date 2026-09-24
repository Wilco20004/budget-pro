# BudgetPro

A household budget that runs **payday to payday** instead of calendar
months. Import your FNB / Discovery Bank statements, reconcile every
transaction into a category, attach till slips as proof, and let the slips
build a product database — so a Checkers run automatically splits into
Groceries, Kids (nappies) and Medical (Panado). Planned vs actual KPIs are on
the dashboard, in Home Assistant sensors, and available to AI through MCP.

## Setup

1. Install and start the add-on, then open **BudgetPro** from the sidebar.
2. **Settings → Budget period**: set your payday (default 25) and what
   happens when it falls on a weekend (default: paid the Friday before). A
   period is named by its dates, e.g. *25 Aug – 24 Sep 2026*.
3. **Setup → Accounts**: add each account/card (e.g. "FNB Cheque",
   "Discovery Credit Card"). Put the account number (or its last 4+ digits)
   in **Account number (match hint)** so files can be matched automatically.
4. **Plan**: enter expected income and a planned amount per category. Tick
   *Also use as the default* and every future period starts from it.
5. **Import** your first statement (below).

## Getting statements in

**Upload** — Import → Choose file. CSV or OFX.
- FNB: Online Banking → the account → Transaction History → Download → CSV.
- Discovery Bank: the account → Statements / Transactions → export CSV.

Columns are detected from the header row (date, description, amount — or
separate debit/credit columns — and balance), with SA formats handled
(`2026/09/25`, `25/09/2026`, `25 Sep 2026`, `1 234,56`, `123.45 Dr`). Files
without a header row are guessed and flagged. Re-importing an overlapping
statement is safe: transactions already in are skipped. **Undo** on an import
removes exactly the transactions it added.

If a card export shows purchases as *positive* numbers, tick *flip signs* on
that account.

**Automatic (inbox folder)** — anything saved to
`/share/budgetpro/inbox` is imported within a minute:

```
/share/budgetpro/inbox/            statements, matched by the account number inside the file
/share/budgetpro/inbox/FNB Cheque/ statements for that account (folder = account name or match hint)
/share/budgetpro/inbox/receipts/   slip photos and PDF e-slips
```

Processed files move to `processed/`; files that failed go to `failed/`
with a `.error.txt` explaining why. Reach the folder with the Samba share
add-on, a phone folder-sync app, or an automation that saves statement
e-mail attachments there.

### Why no bank login scraping?

Neither FNB nor Discovery Bank offers a personal API, and scraping their
online banking means storing your banking password in the add-on and
approving an app sign-in every time — a big risk to take on for a budget,
and it breaks whenever the bank changes its site. The inbox folder gets you
the same "hands-off" result from the statements the banks already e-mail
or let you download.

## Reconciling

**Transactions** lists the selected period, with tabs for *Uncategorised*,
*Needs slip*, *Reconciled* and *Ignored*. The count on the nav bar is how
many are still to do.

- Pick a category in the row. With **Remember merchant** ticked, BudgetPro
  learns the merchant and categorises every matching transaction — now and
  in future imports.
- Click a row to **split** it over several categories, add notes, attach a
  slip, or **ignore** it (e.g. a refund you've netted off elsewhere).
- **Merchant rules** (Setup) are the patterns behind this: `CHECKERS` →
  Checkers → Groceries. Around 30 South African shops and billers are
  pre-loaded.
- **Transfers** between your own accounts belong in a *transfer* category —
  they're excluded from spending.
- Cash spend: **+ Add cash / manual**.

### Smart categories and slips

Categories marked **Slip required** (Groceries, Kids, Medical, Fuel,
Household by default) aren't reconciled until a slip is attached. Photograph
the slip (Slips → Take photo, or from the transaction itself), or drop PDF
e-slips in the inbox. BudgetPro then:

1. reads the slip (see *Slip reading*),
2. categorises every line — first from the **product database** (what you
   told it last time), then **slip keywords** (NAPPIES → Kids, PANADO →
   Medical), then the shop's default category,
3. matches the slip to the bank transaction with the same total within a
   few days (or when the statement arrives later), and
4. splits the transaction by category. Anything the lines don't cover (bag
   levy, OCR misses, rounding) goes to the shop's default category, so the
   split always adds up.

Correct a line's category and press **Save** — the product remembers, and
the transaction's split updates. **Product database** shows everything
you've bought with times bought, last and average price.

### Slip reading

- **Built-in OCR** (Tesseract, English model bundled) runs on the Home
  Assistant machine; nothing leaves your network. Good on clean slips and
  PDFs, weaker on faded or crumpled thermal paper. A slip takes 10–60 s on
  an SBC.
- **Claude** (optional) reads messy slips far better and suggests a
  category per line. Put an Anthropic API key in the add-on's
  **Configuration** tab (`anthropic_api_key`); the slip image is sent to
  Anthropic's API. `ai_model` defaults to `claude-opus-5`. Choose the
  engine in Settings → Slip reading (*Automatic* uses Claude when a key is
  set).

## Dashboard & KPIs

For the selected period:

- **Spent / Left to spend / daily allowance** (left ÷ days to payday)
- **Income** vs expected, **Saved**, **Net** (income − spending − savings),
  savings rate
- **Reconciled** count and **slip coverage** (% of slip-required
  transactions with a slip)
- **Planned vs actual** per category: bar = spent, solid tick = planned,
  dotted tick = where you'd be if spending evenly through the period.
  ▲ *Ahead of pace* and ⚠ *Over* are flagged.
- **Last 6 periods**: income vs spending, with the planned spend marked.

## Home Assistant sensors

Updated on every change and every 5 minutes (turn off in Settings):

| Entity | State |
|---|---|
| `sensor.budgetpro_spent` | spent this period (attr: planned) |
| `sensor.budgetpro_remaining` | planned − spent |
| `sensor.budgetpro_income` | income this period |
| `sensor.budgetpro_daily_allowance` | remaining ÷ days left |
| `sensor.budgetpro_days_left` | days until payday |
| `sensor.budgetpro_to_reconcile` | uncategorised + needs slip |
| `sensor.budgetpro_<category>_remaining` | per category (attr: planned, actual, pct_used, status) |

E.g. notify when `sensor.budgetpro_groceries_remaining` drops below R500.

## API and MCP (AI access)

The add-on's port **8097** serves the REST API (`/api/...`) and an MCP
endpoint (`/mcp`, Streamable HTTP). From outside the HA sidebar, requests
need the token from **Settings → API & AI access** as
`Authorization: Bearer <token>`. Settings shows ready-to-paste commands:

```bash
claude mcp add --transport http budgetpro http://<ha-ip>:8097/mcp --header "Authorization: Bearer <token>"
```

MCP tools: `get_settings`, `list_periods`, `get_period_summary`,
`get_trend`, `list_categories`, `search_transactions`,
`spending_by_merchant`, `search_products`, `product_price_history`,
`categorize_transaction`.

Main REST endpoints: `GET /api/kpis?period=YYYY-MM-DD`,
`GET /api/kpis/trend?count=6`, `GET /api/transactions?period=&status=&category_id=&q=`,
`PUT /api/transactions/:id/category`, `PUT /api/transactions/:id/splits`,
`POST /api/imports` (multipart `file`, optional `account_id`),
`POST /api/receipts` (multipart `files`), `GET /api/products`,
`GET /api/budgets/:period`, `PUT /api/budgets/:period`.

The token is plain HTTP on your LAN — don't forward port 8097 to the
internet. If you don't need API/MCP access you can remove the port mapping
in the add-on's Network settings; the sidebar UI doesn't use it.

## Data

Everything lives in the add-on's `/data` (SQLite `budgetpro.db` plus
`uploads/receipts/`), which is included in Home Assistant backups.
