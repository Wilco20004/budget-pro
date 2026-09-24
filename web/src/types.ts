export interface Period {
  start: string;
  end: string;
  label: string;
  days: number;
}

export type CategoryKind = 'expense' | 'income' | 'savings' | 'transfer';

export interface Category {
  id: string;
  name: string;
  kind: CategoryKind;
  color: string | null;
  icon: string | null;
  requires_slip: number;
  default_budget: number;
  sort_order: number;
  archived: number;
}

export interface Account {
  id: string;
  name: string;
  bank: string;
  type: string;
  match_hint: string | null;
  flip_sign: number;
  transaction_count?: number;
  last_transaction_date?: string | null;
  last_balance?: number | null;
}

export interface Merchant {
  id: string;
  name: string;
  patterns: string;
  default_category_id: string | null;
  category_name?: string | null;
  transaction_count?: number;
}

export interface Keyword {
  id: string;
  keyword: string;
  category_id: string;
  category_name: string;
}

export interface Split {
  id: string;
  category_id: string;
  amount: number;
  note: string | null;
  source: string;
  category_name: string;
  category_color: string | null;
  category_icon: string | null;
  requires_slip: number;
}

export type TxStatus = 'uncategorized' | 'needs_slip' | 'reconciled' | 'ignored';

export interface Transaction {
  id: string;
  account_id: string;
  account_name: string;
  date: string;
  description: string;
  amount: number;
  balance: number | null;
  merchant_id: string | null;
  merchant_name: string | null;
  notes: string | null;
  ignored: number;
  status: TxStatus;
  receipt_id?: string | null;
  splits: Split[];
}

export interface CategoryKpi {
  category_id: string | null;
  name: string;
  kind: CategoryKind;
  color: string | null;
  icon: string | null;
  requires_slip: boolean;
  planned: number;
  actual: number;
  remaining: number;
  pct_used: number | null;
  pace_expected: number;
  projected: number;
  status: 'over' | 'ahead_of_pace' | 'on_track' | 'unplanned' | 'no_activity';
  transaction_count: number;
}

export interface PeriodKpis {
  period: Period;
  elapsed_days: number;
  days_left: number;
  elapsed_fraction: number;
  totals: {
    income_planned: number;
    income_actual: number;
    expense_planned: number;
    expense_actual: number;
    savings_planned: number;
    savings_actual: number;
    net: number;
    savings_rate: number | null;
    expense_remaining: number;
    daily_allowance: number | null;
    unallocated: number;
  };
  recon: {
    total: number;
    reconciled: number;
    uncategorized: number;
    needs_slip: number;
    ignored: number;
    uncategorized_amount: number;
    slip_coverage: number | null;
  };
  categories: CategoryKpi[];
}

export interface TrendPoint {
  period: Period;
  income: number;
  expenses: number;
  expenses_planned: number;
  savings: number;
  net: number;
}

export interface BudgetLine {
  category_id: string;
  name: string;
  kind: CategoryKind;
  icon: string | null;
  color: string | null;
  requires_slip: number;
  default_budget: number;
  override: number | null;
  planned: number;
  previous_actual: number;
}

export interface ImportRecord {
  id: string;
  account_name: string;
  filename: string;
  format: string;
  source: string;
  row_count: number;
  new_count: number;
  duplicate_count: number;
  created_at: string;
  first_date: string | null;
  last_date: string | null;
}

export interface ImportResult {
  format: string;
  row_count: number;
  new_count: number;
  duplicate_count: number;
  auto_categorized: number;
  receipts_linked: number;
  warnings: string[];
}

export interface ReceiptSummary {
  id: string;
  status: 'pending' | 'processing' | 'parsed' | 'failed';
  error: string | null;
  engine: string | null;
  merchant_name: string | null;
  receipt_date: string | null;
  total: number | null;
  transaction_id: string | null;
  transaction_date: string | null;
  transaction_description: string | null;
  transaction_amount: number | null;
  item_count: number;
  created_at: string;
  mime_type: string;
}

export interface ReceiptItem {
  id: string;
  raw_name: string;
  quantity: number;
  amount: number;
  category_id: string | null;
  category_name: string | null;
  product_id: string | null;
}

export interface TxCandidate {
  id: string;
  date: string;
  description: string;
  amount: number;
  account_name: string;
}

export interface ReceiptDetail {
  id: string;
  status: ReceiptSummary['status'];
  error: string | null;
  engine: string | null;
  ocr_text: string | null;
  mime_type: string;
  merchant_id: string | null;
  merchant_name: string | null;
  receipt_date: string | null;
  total: number | null;
  transaction_id: string | null;
  items: ReceiptItem[];
  transaction: TxCandidate | null;
  candidates: TxCandidate[];
}

export interface Product {
  id: string;
  name: string;
  category_id: string | null;
  category_name: string | null;
  times_bought: number;
  total_spent: number | null;
  avg_unit_price: number | null;
  last_unit_price: number | null;
  last_bought: string | null;
}

export interface Settings {
  period_start_day: number;
  weekend_rule: 'none' | 'previous_business_day' | 'next_business_day';
  currency_symbol: string;
  ocr_engine: 'auto' | 'tesseract' | 'claude';
  publish_ha_sensors: boolean;
  api_token: string;
  home_assistant: boolean;
  claude_available: boolean;
  ai_model: string;
  inbox: { dir: string; exists: boolean; recent: { at: string; file: string; ok: boolean; message: string }[] };
}
