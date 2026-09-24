<!-- https://developers.home-assistant.io/docs/add-ons/presentation#keeping-a-changelog -->

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
