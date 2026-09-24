export interface Period {
  start: string;
  end: string;
  label: string;
  days: number;
}

export type CategoryKind = 'expense' | 'income' | 'savings' | 'transfer' | 'loan';

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
  group_id: string | null;
  /** 1 = a household member's spending money. */
  personal: number;
  /** Set on a subcategory (Groceries → Meat). */
  parent_id: string | null;
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

export interface CategoryGroup {
  id: string;
  name: string;
  sort_order: number;
  category_count?: number;
}

export interface GroupKpi {
  group_id: string | null;
  name: string;
  planned: number;
  actual: number;
  remaining: number;
  pct_used: number | null;
  pace_expected: number;
  status: CategoryKpi['status'];
  category_ids: (string | null)[];
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

export type NoSlipReason = 'lost' | 'single_category';

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
  /** 1 = made from a phone notification; replaced when the statement arrives. */
  provisional?: number;
  /** Set when a slip-required transaction is reconciled without a slip. */
  no_slip_reason?: NoSlipReason | null;
  payment_plan_id?: string | null;
  payment_plan_name?: string | null;
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
  group_id: string | null;
  group_name: string | null;
  personal: boolean;
  /** Set on a subcategory; the parent's figures include it. */
  parent_id: string | null;
  /** On a parent with subcategories: its own (unsplit) figures. */
  own_actual?: number;
  own_planned?: number;
  /** Part of planned from payment plan instalments due this period. */
  plans_planned: number;
  /** Part of planned from savings goals' planned top-ups. */
  goals_planned: number;
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
    /** Borrowed this period: cash in that isn't income. */
    borrowed_actual: number;
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
  borrowed_unplanned: { transaction_id: string; date: string; description: string; amount: number }[];
  categories: CategoryKpi[];
  groups: GroupKpi[];
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
  /** Added on top of planned by payment plan instalments due this period. */
  plans: number;
  /** Added on top of planned by savings goals' planned top-ups. */
  goals: number;
  personal: number;
  parent_id: string | null;
  previous_actual: number;
  group_id: string | null;
  group_name: string | null;
}

export interface SavingsGoal {
  id: string;
  name: string;
  icon: string | null;
  target: number | null;
  target_date: string | null;
  account_id: string | null;
  account_name: string | null;
  tracks_account: number;
  kind: 'physical' | 'virtual';
  category_id: string | null;
  topup: number;
  match_pattern: string | null;
  opening_balance: number;
  archived: number;
  sort_order: number;
  balance_source: 'account' | 'movements';
  balance: number;
  remaining: number | null;
  pct: number | null;
  periods_left: number | null;
  needed_per_period: number | null;
  status: 'no_target' | 'reached' | 'saving' | 'on_track' | 'behind';
  planned_this_period: number;
  this_period: { added: number; withdrawn: number };
}

export interface SavingsOverview {
  period: Period;
  total: number;
  goals: SavingsGoal[];
  accounts: { account_id: string; name: string; balance: number | null; assigned: number; unassigned: number | null }[];
}

export interface SavingsMovement {
  id: string;
  goal_id: string;
  date: string;
  amount: number;
  transaction_id: string | null;
  transaction_description?: string | null;
  note: string | null;
  source: string;
}

export interface SavingsAllocation {
  id: string;
  goal_id: string;
  goal_name: string;
  amount: number;
  source: string;
}

export type PlanFrequency = 'monthly' | 'fortnightly' | 'weekly';

export interface PaymentPlan {
  id: string;
  name: string;
  category_id: string;
  category_name: string | null;
  category_icon: string | null;
  instalment: number;
  instalments: number;
  frequency: PlanFrequency;
  first_due: string;
  match_pattern: string | null;
  notes: string | null;
  ended_on: string | null;
  loan_transaction_id: string | null;
  borrowed: { date: string; description: string; amount: number; cost: number } | null;
  total: number;
  schedule: string[];
  last_due: string | null;
  next_due: string | null;
  paid_count: number;
  paid_total: number;
  remaining: number;
  status: 'upcoming' | 'active' | 'paid_off' | 'ended';
  this_period?: number;
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
  provisional_replaced: number;
  matched_existing: number;
  accounts: { name: string; new_count: number; duplicate_count: number }[];
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
  barcode: string | null;
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
  whatsapp_numbers: string;
  whatsapp_media_base: string;
  api_token: string;
  home_assistant: boolean;
  claude_available: boolean;
  ai_model: string;
  inbox: { dir: string; exists: boolean; recent: { at: string; file: string; ok: boolean; message: string }[] };
  internal_url: string | null;
  email: EmailStatus;
}

export interface EmailLog {
  uid: number;
  received_at: string | null;
  from_addr: string | null;
  subject: string | null;
  status: 'receipt' | 'statement' | 'ignored' | 'failed';
  detail: string | null;
  receipt_id: string | null;
}

export interface EmailStatus {
  configured: boolean;
  user: string | null;
  folder: string | null;
  after_import: 'keep' | 'move' | 'delete' | null;
  move_to: string | null;
  last_check: string | null;
  last_error: string | null;
  recent: EmailLog[];
}

export interface NotificationLog {
  id: string;
  received_at: string;
  package: string | null;
  title: string | null;
  text: string | null;
  status: 'imported' | 'ignored' | 'duplicate' | 'unparsed' | 'not_bank';
  reason: string | null;
  transaction_id: string | null;
  transaction_description: string | null;
  transaction_amount: number | null;
  provisional: number | null;
}

export interface WhatsappLog {
  id: string;
  received_at: string | null;
  phone_tail: string | null;
  author: string | null;
  message_type: string | null;
  status: 'receipt' | 'statement' | 'ignored' | 'not_allowed' | 'failed';
  detail: string | null;
  receipt_id: string | null;
}

export interface WhatsappStatus {
  key: string;
  numbers: string;
  media_base: string;
  recent: WhatsappLog[];
}
