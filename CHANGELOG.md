<!-- https://developers.home-assistant.io/docs/add-ons/presentation#keeping-a-changelog -->

## 1.23.1 — 2026-09-25

- Notifications from a banking app that aren't recognised are now logged
  as *unparsed* with their wording, not dropped as "not a bank
  notification". This shows why a purchase didn't come through.

## 1.23.0 — 2026-09-25

- **Accounts page**: each account's spending for the period by category
  and by how it was paid: card, debit order, EFT / app payment, cash, or
  bank charges and interest.
- **Settle up**: mark each account with whose it is (Setup → Accounts →
  *Whose account*). The page shows who paid the shared costs, each
  person's share (by income or equally), and who should transfer how much
  to whom. It works on what's been paid so far, and in an open period
  also gives an estimate for the full budget. Untick a category to mark
  it as one person's own cost. Money sent between you is taken into
  account: between two tracked accounts it's found automatically. From an
  untracked account, name the reference it arrives with ("THANKS LOVE" is
  from …). Someone else's spending money paid from your account counts as
  money sent to them.
- MCP: `account_breakdown` and `settle_up`.

## 1.22.0 — 2026-09-24

- **FNB transaction alerts** by email, auto-forwarded one at a time or
  attached as a batch of .eml files, and as FNB phone notifications:
  card purchases, withdrawals, payments in and out, and transfers between
  accounts become provisional transactions. The statement replaces them;
  alerts already on a statement (within 4 days) are skipped.
- An account's match hint can list several numbers (comma-separated),
  for when alerts and statements use different numbers.

## 1.21.0 — 2026-09-24

- **Spending cards**: tick *Cleared in full every month* on a card that's
  paid off each payday and used for day-to-day spending. It's no longer
  treated as debt: no Debt repayments line or paydown, its fees stay in
  Bank fees, and the Debt page shows whether it was cleared this period.

## 1.20.0 — 2026-09-24

- **Debts on the Plan page**: every tracked card and loan is its own line
  under Debt repayments. Planned = the repayment (the same number on the
  Debt page). Actual = the debt's interest, fees and cover plus how much
  the balance came down. The separate "debt paydown" outflow is gone,
  because it now sits inside Debt repayments.
- Payment plans due in the period are listed as lines under their
  category, instead of the "+R… payment plans" note.
- *Re-check repayments* moves earlier debt costs from Bank fees and
  Insurance to each debt's line.

## 1.19.0 — 2026-09-24

- **Debt page**: every credit card and loan with owed, limit and
  utilisation, a planned repayment and interest rate, this period's
  payments, cost of debt and purchases, how much the balance moved, a
  payoff estimate and a six-period history.
- Repayments into tracked cards and loans are paired with the paying
  account's line and counted as transfers. Only interest, fees and cover
  are spending, and the rest is **debt paydown**, planned alongside
  savings on the Plan page and included in Net.
- The **Plan page** has a *This period* column next to *Last period* and
  *Planned*.
- Fix: FNB card statements list lines out of date order, so the running
  balances (and the owed amount) were wrong. Rows are now dated in order,
  and existing card imports are rebuilt by *Re-check repayments*.
  Statement lines are also inserted in file order.

## 1.18.0 — 2026-09-24

- **Borrowed money**: a new category kind (a *Borrowed* category is
  created) for loan money coming in. It's not counted as income, is shown
  on its own dashboard tile and counts toward Net. **Set up repayment** on
  the transaction creates a payment plan that puts the repayment in the
  budget of the period it's due, and shows what the borrowing cost. The
  dashboard flags borrowing that has no repayment plan. FNB "Short Term Loan
  Credit" lines are recognised automatically.
- Fix: the built-in BP, Pick n Pay, Woolworths and MTN rules matched inside
  other words ("Abp …" was filed as fuel). They now match whole words only.

## 1.17.1 — 2026-09-24

- Fix: since 1.16.0, when a period had uncategorised spending, the
  dashboard's Uncategorised row added every category's figures to its own
  (it has no id, and was matched as the "parent" of all top-level
  categories). That inflated Spent, Planned and Left to spend.

## 1.17.0 — 2026-09-24

- **FNB PDF statements**, as emailed, for cheque accounts, credit cards
  and personal loans, from upload, the inbox folder or the receipts
  mailbox. They were imported as slips before. Each statement is checked
  against its opening and closing balance, and cheque lines take their
  in/out direction from the running balance.
- New account type **Loan**: its lines count as transfers, so a repayment
  isn't counted twice.
- Merchant rules for FNB card repayments (transfers), personal loan debit
  orders (debt repayments) and debit-balance interest (bank fees).

## 1.16.0 — 2026-09-24

- **Subcategories**, one level deep (Groceries → Meat, Starch, Fruit &
  Veg, Kitchen, Snacks & Sweets). A parent's planned and actual include
  its subcategories; the dashboard nests their bars under the parent, and
  the Plan page lists them indented, budgetable at either level. Category
  pickers show them under their parent, and filtering by a parent
  includes them.
- Those five subcategory names come with starter slip keywords, and
  **Re-sort slip lines** moves already-logged slip lines into them and
  re-splits the transactions. Every keyword competes, so toilet rolls
  stay in Household.

## 1.15.0 — 2026-09-24

- **Savings goals** (new Savings page): target, target date and a planned
  top-up per period, with progress, amount still needed per period and
  On track / Behind.
  - Virtual pots share one account (medical R1,000 + holiday R500 in one
    savings account). Top up or withdraw by hand, share a transfer over
    pots from its transaction, or link lines automatically with statement
    text. The page shows how much of the account isn't in a pot yet.
  - Physical goals own an account and follow its imported balance.
  - Planned top-ups are added to the chosen savings category's budget
    until the target is reached.
  - The dashboard shows each goal's progress. MCP tools
    list_savings_goals, add_savings_goal, add_savings_movement and
    allocate_to_savings_goals.

## 1.14.0 — 2026-09-24

- **Payment plans** (Plan page): PayJustNow, PayFlex, a medical account —
  a number of instalments, monthly / every 2 weeks / weekly. Each
  instalment is added to its category's budget in the period it's due and
  drops off once the plan is done. With statement text, matching bank
  lines (instalment amount ±2%) are linked and categorised automatically;
  link or unlink by hand in a transaction's details. Shows paid so far,
  remaining and next due; End a plan settled early. MCP tools
  list_payment_plans, add_payment_plan and link_payment_plan.
- **Spending money** (Setup → Spending money): each household member gets
  a personal category with their allowance as its budget; allocate a
  transaction or a single slip line to them. The dashboard shows what each
  person has left.

## 1.13.0 — 2026-09-24

- **WhatsApp slips** through the NeuraCore WhatsApp platform's callbacks:
  a photo or PDF sent to your business number from one of your allowed
  numbers becomes a slip (a statement PDF is imported). Import → WhatsApp
  has the callback URL, the X-Api-Key and the allowed-numbers list, plus a
  log. Other senders are ignored without downloading anything; other event
  types are acknowledged and dropped; retries are de-duplicated by message
  ID; media is fetched only from the configured platform address.
- Email and WhatsApp now share one path for incoming files, so both treat
  statements and slips the same way.

## 1.12.1 — 2026-09-24

- Fix: Delete, Undo import, Regenerate token and Restore did nothing in
  the Home Assistant companion app, whose view silently refuses the
  browser's "Are you sure?" pop-up. They now ask on the page itself.
- The app page is no longer cached by the browser, so an add-on update
  shows the new version straight away instead of an old copy.

## 1.12.0 — 2026-09-24

- Slip keywords: the built-in **BABY → Kids** keyword also caught Baby
  Marrows, Baby Corn and Baby Gem Squash, so it is replaced by specific
  baby products (baby wipes, food, powder, oil, lotion, shampoo, formula).
  New: growth milk → Kids; toilet rolls, fabric conditioner/softener,
  washing powder → Household; hair spray → Personal care. Applied once to
  existing databases; keywords you already have are left alone.

## 1.11.0 — 2026-09-24

- **Imported emails leave the inbox**: moved to a `BudgetPro` folder by
  default (`imap_move_to`), or deleted with `imap_after_import: delete`
  (`keep` leaves them). Only successfully imported emails are touched —
  skipped and failed ones stay — and each is re-checked by Message-ID
  before it is moved or deleted. Emails imported before this version are
  tidied on the next check.
- The MCP email tools take a `folder`, to read emails that were moved.

## 1.10.0 — 2026-09-24

- **Checkers Sixty60 invoice emails** are read exactly: every product with
  quantity (weighed items too), deals such as "Buy 2 For R75" shared across
  the products they cover, delivery fees, and the Sixty60 wallet — the
  card charge on the invoice is what's matched to the bank, and a wallet
  payment or credit is its own line, so the split always equals what the
  bank took.
- Fix: images embedded in a forwarded email (letterheads, logos) were
  imported as slips. Only attached photos are now.

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
