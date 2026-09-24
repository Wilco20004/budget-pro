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

**Upload** — Import → Choose file.
- Discovery Bank: the monthly **PDF statements**, as downloaded (transaction
  account and credit card). Every PDF is checked: opening balance plus all
  transactions must equal the closing balance, otherwise the import shows a
  warning. The account is recognised from the account number on the
  statement. Password-protected PDFs need an unlocked copy first
  ("Print → Save as PDF").
- Discovery Bank: the **transaction history** PDF (any date range, all
  accounts in one file). Each section goes to the matching BudgetPro
  account; sections for accounts you haven't set up are skipped with a
  note. Every row is checked against the running balance.
- FNB: Online Banking → the account → Transaction History → Download → CSV.
- Any bank: CSV or OFX.

Mixing export types is safe. The same transaction appears with different
wording and often a different date in a monthly statement (transaction
date) and a transaction history (posting date). When a file overlaps
transactions already imported from a *different* kind of export,
BudgetPro pairs them by account, amount and date (within 4 days, in date
order) and keeps your existing, categorised copy — only genuinely new
transactions are added.

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
/share/budgetpro/inbox/            statements (PDF/CSV/OFX), matched by the account number inside the file
/share/budgetpro/inbox/FNB Cheque/ statements for that account (folder = account name or match hint)
/share/budgetpro/inbox/receipts/   slip photos and PDF e-slips
```

Processed files move to `processed/`; files that failed go to `failed/`
with a `.error.txt` explaining why. Reach the folder with the Samba share
add-on, a phone folder-sync app, or an automation that saves statement
e-mail attachments there.

**Email inbox** — forward online-order confirmations (e.g. Checkers
Sixty60), slip photos, PDF e-slips and statements to a mailbox used only for
this, and BudgetPro imports them every 5 minutes. In the add-on's
**Configuration** tab set `imap_host`, `imap_user` and `imap_password`
(`imap_port` 993 and `imap_folder` INBOX by default). If the connection
fails with a certificate error, use your mail host's server name (the one
its certificate is issued to) as `imap_host`. A filter in your normal
mailbox can auto-forward the shop's emails. What happens per email:

- statement attachments (Discovery PDF, CSV, OFX) are imported;
- slip photos and PDF e-slips are read like uploaded slips;
- otherwise the email itself is read as a receipt when it looks like one
  (an order/receipt email with product lines and a total), and matched to
  the bank transaction;
- anything else (newsletters) is skipped.

Once an email has been imported it leaves the inbox: by default it is moved
to a **BudgetPro** folder (`imap_move_to`), so the inbox only shows what
still needs a look. Set `imap_after_import` to `delete` to delete imported
emails instead, or `keep` to leave them. Skipped and failed emails always
stay in the inbox. Before moving or deleting, each email is checked by its
Message-ID, so only the one that was imported is touched. BudgetPro never
sends email, and handles each one once; the first check looks back 60 days.
Import → Email inbox shows what arrived and what became of it.

**WhatsApp (NeuraCore WhatsApp platform)** — send a slip photo or PDF to
your WhatsApp business number and it becomes a slip (a statement PDF is
imported as a statement). Set up under Import → WhatsApp:

1. **Allowed numbers**: your own WhatsApp numbers (e.g. ).
   A business number hears from anyone, so photos from any other number are
   ignored and never downloaded — only their last four digits are logged.
2. On the platform, set the channel's **CallbackUrl** to
    (no trailing slash;
   the platform adds ), with auth mode **Custom header**,
   Name  and the key shown on the card.
3. The platform is on the internet, so that address must reach port 8097
   over HTTPS — a reverse proxy or a Cloudflare tunnel that forwards **only**
   . Keep the rest of port 8097 on your network.

Only *Message received* callbacks with a photo or document are used; every
other event is acknowledged and dropped. Deliveries are acknowledged at once
and processed afterwards, and retries are recognised by the message ID.
Media is only downloaded from the platform address set on the card. If the
platform needs a credential to download media, put it in the add-on option
 as . A photo's caption becomes
the slip's name.

**Phone notifications (Android, Discovery Bank)** — for day-to-day figures
between statements. The Home Assistant Companion app's *Last notification*
sensor passes each banking notification to BudgetPro (Import → Phone
notifications → Set up has the YAML to paste). Card payments and transfers
appear immediately as **📱 provisional** transactions; when the statement
is imported, each statement line takes over its provisional twin (same
account and amount, within a few days), keeping any category, slip or note
you added. Rules:

- Only accounts set up in BudgetPro are used — a notification for any other
  account (e.g. a business account) is ignored and its text is not kept.
- Declined payments ("Insufficient funds") are ignored.
- Anything else that isn't a recognised bank notification is logged as
  "not a bank" with its content discarded.

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

No slip? Use **Skip slip…** on the row (or the buttons in the
transaction's details): *Slip lost*, or *All <category>* when the whole
purchase really was that category. The transaction is reconciled as it is,
shows "no slip" in its status, and is left out of slip coverage. *Undo* puts
it back in *Needs slip*; attaching a slip later works as normal.

Correct a line's category and press **Save** — the product remembers, and
the transaction's split updates. **Product database** shows everything
you've bought with times bought, last and average price.

### Logging slips with your Claude subscription

With Claude Desktop (or Claude Code) connected to BudgetPro's MCP endpoint
(see *API and MCP*), attach slip photos and ask Claude to "log these slips
in BudgetPro". Claude reads them and calls the `log_receipt` tool; BudgetPro
categorises the lines, matches the bank transaction and splits it exactly as
for scanned slips. This uses your Claude plan, not an API key. No image is
stored for slips logged this way.

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

**Groups** (Setup → Groups) bundle spending categories, e.g. *Fixed* (bond,
rates, insurance), *Living* (groceries, fuel, kids) and *Lifestyle* (eating
out). The dashboard then shows each group's subtotal with its categories
under it, and the Plan page subtotals by group. Groups are display-only:
budgets and reconciling stay per category.

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
| `sensor.budgetpro_group_<group>_remaining` | per category group, e.g. Living (same attributes) |

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
`categorize_transaction`, `log_receipt`, and for the receipts mailbox
`list_emails`, `read_email` (text, and HTML for writing a shop's parser)
and `reprocess_email`.

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

**Settings → Backup & move** downloads all of it as one `.json` file and
restores such a file into another BudgetPro (replacing everything there,
except that install's API token). The file contains your full financial
history — store it like a bank statement.
