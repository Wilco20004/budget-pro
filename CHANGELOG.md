<!-- https://developers.home-assistant.io/docs/add-ons/presentation#keeping-a-changelog -->

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
