<!-- https://developers.home-assistant.io/docs/add-ons/presentation#keeping-a-changelog -->

## 1.9.0 — 2026-09-24

- **Email inbox**: BudgetPro checks a receipts mailbox over IMAP every 5
  minutes (set `imap_host`, `imap_user`, `imap_password` in the add-on's
  Configuration). Statement attachments are imported, slip photos and PDF
  e-slips are read, and order/receipt emails without an attachment (e.g.
  Checkers Sixty60) are read from the email itself and matched to the bank
  transaction. Read-only: nothing in the mailbox is changed. Import → Email
  inbox shows each email and what became of it, with *Check email now*.
- MCP tools `list_emails`, `read_email` and `reprocess_email`, so an AI
  client can look at the emails that arrive and help add a parser for a
  shop's order-email layout.
- Backups include the email log, so a restored install doesn't import the
  same emails twice.

## 1.8.0 — 2026-09-24

- **Better reading of e-slip screenshots** (e.g. Checkers/Shoprite app
  slips, ~420px wide), where the built-in OCR misreads digits — 9 as 5, 8
  or "%", 6 as "€":
  - Small images are upscaled 2× instead of 3×, which read about twice as
    many prices right in testing.
  - The date is agreed over every "Date Time Store" row printed, and
    impossible dates (in the future, years ago) are rejected.
  - Prices with lookalike characters ("R27.8%") are kept rather than
    dropped. Barcodes are repaired with their check digit, and a product
    bought before gets its known price when the reading is close to it —
    so repeat purchases come out right.
  - The total is taken from what TOTAL, APPROVED AMOUNT and Electronic
    Payment agree on. When it's still misread, a slip is linked to the one
    bank transaction nearby that matches a plausible reading of the total,
    and takes the bank's exact amount.
- Fix: long slip screenshots uploaded from a phone were squashed to an
  unreadable ~250px width. Uploads are now limited by width, and images
  that are already small enough are sent unchanged.

## 1.7.0 — 2026-09-24

- **Skip the slip**: a transaction in a slip-required category can be
  reconciled without one — *Slip lost*, or *All <category>* when everything
  bought was that one category so there's nothing to split. Use *Skip slip…*
  on the row in the *Needs slip* tab, or the buttons in the transaction's
  details (with *Undo*). Attaching a slip later still works as normal.
  Skipped transactions don't count against slip coverage.
- The `categorize_transaction` MCP tool takes an optional `no_slip_reason`.

## 1.6.0 — 2026-09-24

- **Discovery transaction-history PDFs**: one file covering any date range
  and all accounts. Each account's section is imported into the matching
  BudgetPro account; accounts that aren't set up are skipped with a note.
  Debit and credit are read by column position and every row is checked
  against the running balance.
- **Overlapping exports are recognised**: when a file repeats transactions
  already imported from a different kind of export (e.g. a history over
  monthly statements — different wording, posting instead of transaction
  date), they're paired by account, amount and date, and the existing
  categorised copy is kept. Only genuinely new transactions are added.

## 1.5.0 — 2026-09-24

- **Category groups** (Setup → Groups): bundle spending categories into
  groups such as *Fixed*, *Living* and *Lifestyle*. The dashboard shows a
  subtotal bar per group with its categories underneath, the Plan page
  subtotals by group, and each group gets a Home Assistant sensor
  (`sensor.budgetpro_group_<name>_remaining`). Groups are for display only —
  budgets and reconciling stay per category. Fixed / Living / Lifestyle are
  created with the built-in categories placed in them; categories you added
  yourself start ungrouped (shown under *Other*) until you pick a group on
  the Categories tab.

## 1.4.0 — 2026-09-24

- **Backup & move** (Settings): download everything (accounts,
  transactions, categories, rules, budgets, slips with their images,
  products) as one file, and restore it into another BudgetPro — e.g. from
  a trial on a PC to the Home Assistant add-on. A restore replaces all data
  in one step (a bad file changes nothing) and keeps the install's own API
  token, so Home Assistant automations and AI clients keep working.
- Phone notifications: the dash between shop and amount is matched more
  loosely, in case it arrives mis-encoded.

## 1.3.0 — 2026-09-24

- **Phone notifications**: Discovery Bank card payments and transfers
  arrive from the Android Companion app's notification sensor as
  provisional transactions, and are replaced by the statement line on import
  (keeping categories, slips and notes). Only accounts set up in BudgetPro
  are used; other accounts' notifications are ignored and their text not
  kept. Declines are ignored. Import → Phone notifications has the Home
  Assistant YAML and a log of what arrived.
- **`log_receipt` MCP tool**: Claude Desktop / Claude Code can read slip
  photos and log them — lines, barcodes and categories — using your Claude
  plan instead of an API key. The slip is matched to its transaction and
  split as usual.

## 1.2.0 — 2026-09-24

- Products are now recognised by **barcode** when the slip prints one
  (Checkers/Shoprite `Item/GTIN` lines), so the same product on the next
  slip is found even when OCR garbles its name.
- Small slip images (e.g. e-slip screenshots) are upscaled before OCR, which
  makes totals readable where they weren't.
- The slip reader skips "Electronic Payment" and VAT-summary rows, reads
  "4 @ R3.89" as a quantity, uses "APPROVED AMOUNT" when there's no TOTAL
  line, and prefers the date in the slip's "Date Time Store" row.
- The Claude slip reader now also returns each line's barcode.

## 1.1.0 — 2026-09-24

- **Discovery Bank PDF statements** can now be imported directly, both
  transaction account and credit card, by upload or via the inbox folder.
  Each statement is checked against its own opening and closing balance,
  and a warning is shown if anything doesn't add up. Handles both
  `R1,234.56` and older `R1 234.56` amounts, and details that wrap onto
  a second line.
- The running balance is filled in from the statement, so account balances
  show on Setup → Accounts.
- New built-in rules: transfers between your own accounts (→ Transfers,
  excluded from spending), Discovery fees, interest earned, Vitality Miles
  cash, home loans, medical aid and life cover. Added once to existing
  databases, too.
- Fix: an account number seen inside a statement (e.g. a transfer to
  "account...5555") could match the wrong account's hint.
- Running outside Home Assistant, the inbox folder now defaults to
  `data/inbox` instead of `/share`.

## 1.0.0 — 2026-09-24

- First release.
- Budget periods run from a configurable payday (default the 25th), moved
  to the Friday before (or Monday after) when payday falls on a weekend.
- Statement import from FNB / Discovery Bank CSV and OFX: upload, or drop
  files in `/share/budgetpro/inbox` for automatic import. Overlapping
  statements are de-duplicated, and any import can be undone.
- Reconciliation: merchant rules (about 30 SA shops pre-loaded) that learn
  when you categorise with "Remember merchant", split transactions, cash
  entries, ignore, and "slip required" categories.
- Slips: photo or PDF, read by built-in Tesseract OCR (offline) or Claude
  (optional API key). Lines are categorised from the product database,
  keywords, then the shop default. Slips auto-match to the bank transaction
  and split it by category.
- Dashboard: spent / left / daily allowance / income / saved / net /
  reconciled tiles, planned vs actual bars with pace marker, and a
  6-period trend.
- Home Assistant sensors for the current period and each category.
- Token-protected REST API and MCP endpoint on port 8097 for AI access.
