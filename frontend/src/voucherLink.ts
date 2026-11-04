/** Where the document behind a ledger voucher lives in the app (null when it has no page of its own). */
const PAGE: Record<string, string> = {
  invoices: '/invoices', receipts: '/client-receipts', supplier_bills: '/supplier-bills', credit_notes: '/credit-notes', ticket_invoices: '/ticket-invoices',
  payment_runs: '/payment-runs', commission_periods: '/commissions', client_refunds: '/credit-notes', refunds: '/refunds', bank_transactions: '/reconciliation',
};
export const voucherHref = (v: { voucher_type: string; ref_table?: string | null; ref_id?: number | null; voucher_id?: number | null; id?: number }): string | null =>
  v.ref_table === 'cash_vouchers' ? (v.voucher_type === 'receipt' ? '/receipts' : '/payment-vouchers')
    : v.voucher_type === 'journal' && !v.ref_table ? `/journal?view=${v.voucher_id ?? v.id}`
    : v.voucher_type === 'reversal' && v.ref_table === 'vouchers' && v.ref_id ? `/journal?view=${v.voucher_id ?? v.id}`
    : (v.ref_table && PAGE[v.ref_table]) || null;
