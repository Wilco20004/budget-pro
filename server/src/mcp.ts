import { Router } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { db } from './db';
import { createDataReceipt, storeExtraction } from './receipts/service';
import { productHistory, queryProducts } from './routes/receipts';
import { queryTransactions, setSingleCategory } from './routes/transactions';
import { periodKpis, trend } from './services/kpis';
import { currentPeriod, recentPeriods, resolvePeriod } from './services/periods';
import { getSettings } from './settings';

// MCP (Model Context Protocol) endpoint so an AI client — Claude Desktop,
// Claude Code, or anything else that speaks MCP over Streamable HTTP — can
// read the budget and do trend analysis. Stateless: a fresh server per
// request, which is all a request/response tool API needs.

function json(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

const periodArg = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional()
  .describe('Any date (YYYY-MM-DD) inside the budget period; defaults to the current period');

function buildServer(): McpServer {
  const server = new McpServer(
    { name: 'budgetpro', version: '1.0.0' },
    {
      instructions:
        'BudgetPro is a household budget. Budget periods run payday to payday (see get_settings for the start day), ' +
        'not calendar months, so always reason in periods. Amounts are in the currency from get_settings; ' +
        'transaction amounts are negative for money out. Category kinds: expense, income, savings, transfer (transfers are ' +
        'excluded from spending). Slip-level item data (what was actually bought) is in the product tools.',
    }
  );

  server.registerTool(
    'get_settings',
    { title: 'Budget settings', description: 'Period start day, weekend rule and currency.', annotations: { readOnlyHint: true } },
    async () => json({ ...getSettings(), current_period: currentPeriod() })
  );

  server.registerTool(
    'list_periods',
    {
      title: 'List budget periods',
      description: 'The most recent budget periods (payday to payday), newest last.',
      inputSchema: { count: z.number().int().min(1).max(36).optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ count }) => json(recentPeriods(count ?? 12))
  );

  server.registerTool(
    'get_period_summary',
    {
      title: 'Planned vs actual for a period',
      description:
        'KPIs for one budget period: income/expense/savings planned vs actual, savings rate, daily allowance, reconciliation status, and per-category planned, actual, remaining, pace and status.',
      inputSchema: { period: periodArg },
      annotations: { readOnlyHint: true },
    },
    async ({ period }) => json(periodKpis(resolvePeriod(period)))
  );

  server.registerTool(
    'get_trend',
    {
      title: 'Trend over periods',
      description: 'Income, expenses (planned and actual), savings and net for the last N periods, with per-category planned/actual.',
      inputSchema: { count: z.number().int().min(1).max(36).optional(), period: periodArg },
      annotations: { readOnlyHint: true },
    },
    async ({ count, period }) => json(trend(count ?? 6, resolvePeriod(period)))
  );

  server.registerTool(
    'list_categories',
    { title: 'List categories', description: 'All budget categories with kind, default budget and whether a slip is required.', annotations: { readOnlyHint: true } },
    async () => json(db.prepare('SELECT id, name, kind, requires_slip, default_budget, archived FROM categories ORDER BY sort_order').all())
  );

  server.registerTool(
    'search_transactions',
    {
      title: 'Search transactions',
      description:
        'Bank transactions with their category splits. Filter by period (default current), or an explicit from/to date range, category, status (uncategorized | needs_slip | reconciled | ignored) or text.',
      inputSchema: {
        period: periodArg,
        from: z.string().optional().describe('YYYY-MM-DD, overrides period'),
        to: z.string().optional().describe('YYYY-MM-DD, overrides period'),
        category_id: z.string().optional(),
        status: z.enum(['uncategorized', 'needs_slip', 'reconciled', 'ignored']).optional(),
        text: z.string().optional().describe('Substring of the description'),
        limit: z.number().int().min(1).max(1000).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (a) =>
      json(
        queryTransactions({
          period: a.period,
          from: a.from,
          to: a.to,
          category_id: a.category_id,
          status: a.status,
          q: a.text,
          limit: a.limit ?? 200,
        })
      )
  );

  server.registerTool(
    'spending_by_merchant',
    {
      title: 'Spending by merchant',
      description: 'Total money out per merchant over a date range (defaults to the current period).',
      inputSchema: { from: z.string().optional(), to: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ from, to }) => {
      const p = currentPeriod();
      return json(
        db
          .prepare(
            `SELECT COALESCE(m.name, t.description) AS merchant, COUNT(*) AS transactions, ROUND(-SUM(t.amount), 2) AS spent
             FROM transactions t LEFT JOIN merchants m ON m.id = t.merchant_id
             WHERE t.amount < 0 AND t.ignored = 0 AND t.date BETWEEN ? AND ?
             GROUP BY COALESCE(m.id, t.description) ORDER BY spent DESC LIMIT 100`
          )
          .all(from ?? p.start, to ?? p.end)
      );
    }
  );

  server.registerTool(
    'search_products',
    {
      title: 'Search purchased products',
      description:
        'The product database built from till slips: each product with category, times bought, total spent, average and latest unit price.',
      inputSchema: { text: z.string().optional(), category_id: z.string().optional(), limit: z.number().int().min(1).max(1000).optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ text, category_id, limit }) => json(queryProducts({ q: text, category_id, limit: limit ?? 200 }))
  );

  server.registerTool(
    'product_price_history',
    {
      title: 'Product price history',
      description: 'Every purchase of one product (from slips) with date, shop, quantity and unit price — for inflation / price tracking.',
      inputSchema: { product_id: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ product_id }) => json(productHistory(product_id))
  );

  server.registerTool(
    'log_receipt',
    {
      title: 'Log a till slip',
      description:
        'Record a till slip you have read (e.g. from a photo the user attached): shop, date, total paid and every product line. ' +
        'BudgetPro categorises each line (using its product database first, then your suggested category), matches the slip to the ' +
        'bank transaction with the same total within a few days, and splits that transaction by category. Fold promotion/discount ' +
        'lines (e.g. XTRASAVE) into the product they apply to; skip payment, change, VAT-summary and loyalty lines. Call list_categories ' +
        'first to get valid category names. Pass transaction_id only when the user said which transaction the slip belongs to.',
      inputSchema: {
        merchant: z.string().describe('Shop as printed, e.g. "Checkers Hyper Sandton"'),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Purchase date YYYY-MM-DD'),
        total: z.number().positive().describe('Amount paid (TOTAL / APPROVED AMOUNT)'),
        items: z
          .array(
            z.object({
              name: z.string().describe('Product line as printed'),
              amount: z.number().describe('Line total after its promotion'),
              quantity: z.number().positive().optional(),
              barcode: z.string().optional().describe('GTIN/EAN digits if printed (Checkers: "Item/GTIN ...")'),
              category: z.string().optional().describe('Suggested category name from list_categories'),
            })
          )
          .min(1),
        transaction_id: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ merchant, date, total, items, transaction_id }) => {
      if (transaction_id && !db.prepare('SELECT 1 FROM transactions WHERE id = ?').get(transaction_id)) {
        return { isError: true, content: [{ type: 'text' as const, text: `No transaction with id ${transaction_id}` }] };
      }
      // Same slip logged twice (a retried call, or the photo sent again)?
      const dup = db
        .prepare(
          `SELECT id FROM receipts WHERE receipt_date = ? AND ABS(total - ?) < 0.005 AND engine = 'claude-mcp'`
        )
        .get(date, total) as { id: string } | undefined;
      if (dup) return json({ ok: false, duplicate_of: dup.id, message: 'A slip with this date and total was already logged.' });

      const id = createDataReceipt(transaction_id ?? null);
      storeExtraction(
        id,
        {
          merchant,
          date,
          total,
          items: items.map((i) => ({
            name: i.name,
            amount: i.amount,
            quantity: i.quantity ?? 1,
            barcode: i.barcode ?? null,
            suggested_category: i.category ?? null,
          })),
        },
        'claude-mcp',
        null
      );
      const r = db
        .prepare(
          `SELECT r.id, r.merchant_name, r.transaction_id, t.date AS transaction_date, t.description AS transaction_description, t.amount AS transaction_amount
           FROM receipts r LEFT JOIN transactions t ON t.id = r.transaction_id WHERE r.id = ?`
        )
        .get(id) as { transaction_id: string | null } & Record<string, unknown>;
      const lines = db
        .prepare(
          `SELECT i.raw_name, i.amount, c.name AS category FROM receipt_items i LEFT JOIN categories c ON c.id = i.category_id
           WHERE i.receipt_id = ? ORDER BY i.sort_order`
        )
        .all(id) as { raw_name: string; amount: number; category: string | null }[];
      const byCategory: Record<string, number> = {};
      for (const l of lines) byCategory[l.category ?? 'Uncategorised'] = Math.round(((byCategory[l.category ?? 'Uncategorised'] ?? 0) + l.amount) * 100) / 100;
      const linesTotal = Math.round(lines.reduce((a, l) => a + l.amount, 0) * 100) / 100;
      return json({
        ok: true,
        receipt: r,
        matched_transaction: Boolean(r.transaction_id),
        lines_total: linesTotal,
        lines_match_total: Math.abs(linesTotal - total) < 0.01,
        by_category: byCategory,
        note: r.transaction_id
          ? 'Linked and split.'
          : 'No bank transaction with this total yet — it will be matched automatically when the statement (or phone notification) arrives.',
      });
    }
  );

  server.registerTool(
    'categorize_transaction',
    {
      title: 'Categorise a transaction',
      description:
        'Assign one category to a transaction (replacing its splits). remember=true also teaches the merchant rule so future transactions like it are categorised automatically. no_slip_reason reconciles a slip-required category without a slip: "lost" (the slip is gone) or "single_category" (everything bought was this category) — only when the user says so.',
      inputSchema: {
        transaction_id: z.string(),
        category_id: z.string(),
        remember: z.boolean().optional(),
        no_slip_reason: z.enum(['lost', 'single_category']).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ transaction_id, category_id, remember, no_slip_reason }) => {
      const also = setSingleCategory(transaction_id, category_id, remember ?? false);
      if (no_slip_reason) db.prepare('UPDATE transactions SET no_slip_reason = ? WHERE id = ?').run(no_slip_reason, transaction_id);
      return json({ ok: true, also_categorized: also });
    }
  );

  return server;
}

export const mcpRouter = Router();

mcpRouter.post('/', async (req, res) => {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: (e as Error).message }, id: null });
    }
  }
});

// Stateless server: no SSE stream to resume, no session to delete.
mcpRouter.all('/', (_req, res) => {
  res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
});
