# BudgetPro

A Home Assistant add-on for a payday-to-payday household budget.

- **Configurable periods**: 25th to 25th (or any day), moved to the Friday
  before when payday falls on a weekend
- **Statement import**: FNB / Discovery Bank CSV and OFX, by upload or an
  automatic inbox folder under `/share`, with de-duplication
- **Reconciliation**: merchant rules that learn as you categorise, split
  transactions, and "slip required" categories
- **Slip OCR**: built-in Tesseract (offline) or Claude. Slip lines build a
  product database, so one Checkers transaction splits into Groceries, Kids
  and Medical automatically
- **KPIs**: planned vs actual, pace, daily allowance, savings rate, 6-period
  trend, plus Home Assistant sensors
- **API + MCP**: token-protected REST API and an MCP endpoint, so an AI can
  do trend analysis on the data

See [DOCS.md](DOCS.md) for setup and usage.

## Install

Home Assistant → Settings → Add-ons → Add-on Store → ⋮ → Repositories →
add `https://github.com/Wilco20004/budget-pro`, then install **BudgetPro**.

## Development

```bash
npm install
npm run dev:server   # API on :8097 (data in ./data)
npm run dev:web      # Vite on :5173, proxies /api
```

Stack: Express + better-sqlite3 (`server/`), React + Vite (`web/`).
Ingress-safe: HashRouter, `base: './'`, relative `fetch` paths.
