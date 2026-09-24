import {
  Account,
  BudgetLine,
  Category,
  PaymentPlan,
  SavingsAllocation,
  SavingsGoal,
  SavingsMovement,
  SavingsOverview,
  CategoryGroup,
  EmailStatus,
  ImportRecord,
  ImportResult,
  Keyword,
  Merchant,
  NoSlipReason,
  NotificationLog,
  Period,
  PeriodKpis,
  Product,
  ReceiptDetail,
  ReceiptSummary,
  Settings,
  Transaction,
  TrendPoint,
  WhatsappStatus,
} from '../types';

// Through HA Ingress no token is needed. When the UI is opened on the
// add-on's own port instead, the server asks for the API token; it's kept in
// localStorage for next time (wrapped — storage can be blocked).
const TOKEN_KEY = 'budgetpro.token';

export function getStoredToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setStoredToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // ignore
  }
}

export class AuthRequiredError extends Error {}

type AuthListener = () => void;
const authListeners = new Set<AuthListener>();
export function onAuthRequired(fn: AuthListener) {
  authListeners.add(fn);
  return () => {
    authListeners.delete(fn);
  };
}

function authHeaders(): Record<string, string> {
  const t = getStoredToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

// Every path is relative (no leading slash) so it resolves under HA's
// per-session Ingress prefix.
async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  const isForm = options.body instanceof FormData;
  const res = await fetch(url, {
    ...options,
    headers: { ...(isForm ? {} : { 'Content-Type': 'application/json' }), ...authHeaders(), ...(options.headers ?? {}) },
  });
  if (res.status === 401) {
    authListeners.forEach((fn) => fn());
    throw new AuthRequiredError('API token required');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || `Request failed: ${res.status}`);
  }
  // Lets always-visible bits (the "to reconcile" badge) refresh after edits.
  if (options.method && options.method !== 'GET') window.dispatchEvent(new Event(DATA_CHANGED));
  if (res.status === 204) return undefined as T;
  return res.json();
}

export const DATA_CHANGED = 'budgetpro:changed';

const json = (method: string, body?: unknown): RequestInit => ({ method, body: body === undefined ? undefined : JSON.stringify(body) });

function qs(params: Record<string, string | number | undefined | null>) {
  const s = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
  return s ? `?${s}` : '';
}

/** Backup download, fetched with the auth header and handed to the browser
 *  as a blob link (works over plain HTTP; no File System Access API). */
export async function downloadBackup(): Promise<void> {
  const res = await fetch('api/backup', { headers: authHeaders() });
  if (!res.ok) throw new Error('Could not create the backup');
  const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? 'budgetpro-backup.json';
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Receipt images need the auth header too, so they're fetched and shown
 *  as blob URLs rather than a plain <img src>. */
export async function fetchReceiptFileUrl(id: string): Promise<string> {
  const res = await fetch(`api/receipts/${id}/file`, { headers: authHeaders() });
  if (!res.ok) throw new Error('Could not load the slip image');
  return URL.createObjectURL(await res.blob());
}

export const api = {
  settings: () => request<Settings>('api/settings'),
  updateSettings: (s: Partial<Settings>) => request<Settings>('api/settings', json('PUT', s)),
  regenerateToken: () => request<{ api_token: string }>('api/settings/regenerate-token', json('POST')),

  periods: (count = 12) => request<{ current: Period; periods: Period[] }>(`api/periods${qs({ count })}`),

  kpis: (period?: string) => request<PeriodKpis>(`api/kpis${qs({ period })}`),
  trend: (count = 6, period?: string) => request<TrendPoint[]>(`api/kpis/trend${qs({ count, period })}`),

  budget: (period: string) => request<{ period: Period; lines: BudgetLine[]; payment_plans: PaymentPlan[] }>(`api/budgets/${period}`),

  paymentPlans: (period?: string) => request<PaymentPlan[]>(`api/payment-plans${qs({ period })}`),
  createPaymentPlan: (p: Partial<PaymentPlan>) => request<PaymentPlan>('api/payment-plans', json('POST', p)),
  updatePaymentPlan: (id: string, p: Partial<PaymentPlan>) => request<PaymentPlan>(`api/payment-plans/${id}`, json('PUT', p)),
  deletePaymentPlan: (id: string) => request<void>(`api/payment-plans/${id}`, json('DELETE')),

  savings: (period?: string, all = false) => request<SavingsOverview>(`api/savings${qs({ period, all: all ? 1 : undefined })}`),
  createGoal: (g: Partial<SavingsGoal>) => request<SavingsGoal>('api/savings/goals', json('POST', g)),
  updateGoal: (id: string, g: Partial<SavingsGoal>) => request<SavingsGoal>(`api/savings/goals/${id}`, json('PUT', g)),
  deleteGoal: (id: string) => request<void>(`api/savings/goals/${id}`, json('DELETE')),
  goalMovements: (id: string) => request<SavingsMovement[]>(`api/savings/goals/${id}/movements`),
  addMovement: (id: string, m: { amount: number; date?: string; note?: string | null }) =>
    request<SavingsGoal>(`api/savings/goals/${id}/movements`, json('POST', m)),
  deleteMovement: (id: string) => request<void>(`api/savings/movements/${id}`, json('DELETE')),
  allocations: (txId: string) => request<SavingsAllocation[]>(`api/savings/allocations/${txId}`),
  setAllocations: (txId: string, allocations: { goal_id: string; amount: number }[]) =>
    request<SavingsAllocation[]>(`api/savings/allocations/${txId}`, json('PUT', { allocations })),
  saveBudget: (period: string, lines: { category_id: string; amount: number }[], setDefault = false) =>
    request<{ ok: true }>(`api/budgets/${period}`, json('PUT', { lines, set_default: setDefault })),
  copyPreviousBudget: (period: string) => request<{ copied: number }>(`api/budgets/${period}/copy-previous`, json('POST')),

  accounts: () => request<Account[]>('api/accounts'),
  createAccount: (a: Partial<Account>) => request<Account>('api/accounts', json('POST', a)),
  updateAccount: (id: string, a: Partial<Account>) => request<Account>(`api/accounts/${id}`, json('PUT', a)),
  deleteAccount: (id: string) => request<void>(`api/accounts/${id}`, json('DELETE')),

  categories: () => request<Category[]>('api/categories'),
  createCategory: (c: Partial<Category>) => request<Category>('api/categories', json('POST', c)),
  updateCategory: (id: string, c: Partial<Category>) => request<Category>(`api/categories/${id}`, json('PUT', c)),
  deleteCategory: (id: string) => request<void>(`api/categories/${id}`, json('DELETE')),
  resortCategory: (id: string) => request<{ lines: number; receipts: number }>(`api/categories/${id}/resort`, json('POST')),

  groups: () => request<CategoryGroup[]>('api/groups'),
  createGroup: (name: string) => request<CategoryGroup>('api/groups', json('POST', { name })),
  updateGroup: (id: string, g: { name: string; sort_order: number }) => request<CategoryGroup>(`api/groups/${id}`, json('PUT', g)),
  deleteGroup: (id: string) => request<void>(`api/groups/${id}`, json('DELETE')),

  keywords: () => request<Keyword[]>('api/keywords'),
  createKeyword: (keyword: string, category_id: string) => request<void>('api/keywords', json('POST', { keyword, category_id })),
  deleteKeyword: (id: string) => request<void>(`api/keywords/${id}`, json('DELETE')),

  merchants: () => request<Merchant[]>('api/merchants'),
  createMerchant: (m: Partial<Merchant>) => request<Merchant & { applied: number }>('api/merchants', json('POST', m)),
  updateMerchant: (id: string, m: Partial<Merchant>) => request<Merchant & { applied: number }>(`api/merchants/${id}`, json('PUT', m)),
  deleteMerchant: (id: string) => request<void>(`api/merchants/${id}`, json('DELETE')),
  applyRules: () => request<{ applied: number }>('api/merchants/apply', json('POST')),

  transactions: (f: { period?: string; status?: string; category_id?: string; account_id?: string; payment_plan_id?: string; q?: string }) =>
    request<Transaction[]>(`api/transactions${qs(f)}`),
  transaction: (id: string) => request<Transaction & { receipts: ReceiptSummary[] }>(`api/transactions/${id}`),
  createTransaction: (t: { account_id: string; date: string; description: string; amount: number; category_id?: string }) =>
    request<Transaction>('api/transactions', json('POST', t)),
  setCategory: (id: string, category_id: string, remember: boolean) =>
    request<Transaction & { also_categorized: number }>(`api/transactions/${id}/category`, json('PUT', { category_id, remember })),
  setSplits: (id: string, splits: { category_id: string; amount: number; note?: string | null }[]) =>
    request<Transaction>(`api/transactions/${id}/splits`, json('PUT', { splits })),
  patchTransaction: (id: string, p: { notes?: string | null; ignored?: boolean; no_slip_reason?: NoSlipReason | null; payment_plan_id?: string | null }) =>
    request<Transaction>(`api/transactions/${id}`, json('PATCH', p)),
  deleteTransaction: (id: string) => request<void>(`api/transactions/${id}`, json('DELETE')),

  imports: () => request<ImportRecord[]>('api/imports'),
  importFile: (file: File, accountId: string | null) => {
    const fd = new FormData();
    fd.append('file', file);
    if (accountId) fd.append('account_id', accountId);
    return request<ImportResult>('api/imports', { method: 'POST', body: fd });
  },
  deleteImport: (id: string) => request<void>(`api/imports/${id}`, json('DELETE')),
  whatsapp: () => request<WhatsappStatus>('api/whatsapp'),
  regenerateWhatsappKey: () => request<WhatsappStatus>('api/whatsapp/regenerate-key', json('POST')),
  email: () => request<EmailStatus>('api/email'),
  checkEmail: () => request<EmailStatus & { processed: number }>('api/email/check', json('POST')),
  reprocessEmail: (uid: number) => request<{ status: string; detail: string }>(`api/email/${uid}/reprocess`, json('POST')),
  scanInbox: () => request<{ processed: number; failed: number }>('api/imports/inbox/scan', json('POST')),
  notifications: () => request<NotificationLog[]>('api/notifications'),
  restoreBackup: (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return request<{ ok: true; counts: Record<string, number>; files: number }>('api/backup/restore', { method: 'POST', body: fd });
  },

  receipts: (unlinked = false) => request<ReceiptSummary[]>(`api/receipts${unlinked ? '?unlinked=1' : ''}`),
  receipt: (id: string) => request<ReceiptDetail>(`api/receipts/${id}`),
  uploadReceipts: (files: Blob[], names: string[], transactionId?: string) => {
    const fd = new FormData();
    files.forEach((f, i) => fd.append('files', f, names[i]));
    if (transactionId) fd.append('transaction_id', transactionId);
    return request<{ ids: string[] }>('api/receipts', { method: 'POST', body: fd });
  },
  updateReceipt: (id: string, r: { merchant_name: string | null; merchant_id: string | null; receipt_date: string | null; total: number | null }) =>
    request<ReceiptDetail>(`api/receipts/${id}`, json('PUT', r)),
  saveReceiptItems: (id: string, items: { raw_name: string; quantity: number; amount: number; category_id: string | null; barcode?: string | null }[]) =>
    request<ReceiptDetail>(`api/receipts/${id}/items`, json('PUT', { items })),
  rescanReceipt: (id: string) => request<ReceiptDetail>(`api/receipts/${id}/rescan`, json('POST')),
  linkReceipt: (id: string, transaction_id: string) => request<ReceiptDetail>(`api/receipts/${id}/link`, json('POST', { transaction_id })),
  unlinkReceipt: (id: string) => request<ReceiptDetail>(`api/receipts/${id}/unlink`, json('POST')),
  deleteReceipt: (id: string) => request<void>(`api/receipts/${id}`, json('DELETE')),

  products: (q?: string, category_id?: string) => request<Product[]>(`api/products${qs({ q, category_id })}`),
  updateProduct: (id: string, p: { category_id: string | null; name?: string }) => request<void>(`api/products/${id}`, json('PUT', p)),
};
