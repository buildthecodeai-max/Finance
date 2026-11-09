/**
 * Every report, in the order people look for them. The Reports page and the scheduler both read this list, so a new report
 * appears in both and the two can never drift apart.
 *  asAt    = a position on one date (no "from" date)
 *  account = needs a ledger account; client = a client is 'required' or 'optional'
 *  compare = can be set against the previous period or the same period last year
 */
export interface ReportDef { key: string; label: string; about: string; asAt?: boolean; account?: boolean; client?: 'required' | 'optional'; compare?: boolean; forecast?: boolean }
export interface ReportCategory { label: string; reports: ReportDef[] }

export const CATALOG: ReportCategory[] = [
  { label: 'Financial statements', reports: [
    { key: 'gl-pnl', label: 'Profit & Loss', compare: true, about: 'Income, cost of revenue and expenses from posted ledger entries, down to net profit. Click an account to see its postings.' },
    { key: 'balance-sheet', label: 'Balance Sheet', asAt: true, about: 'What the business owns, owes and is worth on one date. Assets must equal liabilities plus equity.' },
    { key: 'trial-balance', label: 'Trial Balance', asAt: true, about: 'Every account’s balance on one date. Total debits must equal total credits.' },
    { key: 'cash-flow', label: 'Cash Flow', about: 'Money in and out by month: payments, receipts and the cash and bank vouchers you record (voided payments excluded).' },
    { key: 'pnl', label: 'Sales-basis P&L', about: 'Profit from issued invoices, ticket invoices and recorded expenses — a management view that can differ from the ledger P&L until everything is posted.' },
    { key: 'tax-summary', label: 'Tax Summary', about: 'Tax collected on sales, tax paid on purchases and the net to pay, by month — from the ledger.' },
  ] },
  { label: 'Sales & profit', reports: [
    { key: 'sales-by-client', label: 'Sales by Client', about: 'Every client side by side: sales, profit, what they paid and what they still owe. Click a client to open their statement.' },
    { key: 'sales-by-agent', label: 'Sales by Agent', about: 'What each agent sold in the period and the profit it made.' },
    { key: 'booking-profitability', label: 'Booking Profitability', client: 'optional', about: 'Sales, cost and margin on each booking invoiced in the period, best first.' },
    { key: 'revenue-by-destination', label: 'Revenue by Destination', client: 'optional', about: 'Booking revenue grouped by destination, with airline tickets on their own line.' },
    { key: 'commission-summary', label: 'Commission Summary', about: 'Agent commission earned and payable.' },
  ] },
  { label: 'Client accounts', reports: [
    { key: 'client-statement', label: 'Client Statement', client: 'required', about: 'One client’s account: every invoice, receipt and credit note with a running balance.' },
    { key: 'ar-aging-summary', label: 'AR Aging Summary', asAt: true, client: 'optional', about: 'What each client owes, by how overdue it is — invoices and ticket invoices. Reconciled to the ledger.' },
    { key: 'ar-aging-detail', label: 'AR Aging Detail', asAt: true, client: 'optional', about: 'Every open invoice and ticket invoice, one by one.' },
    { key: 'invoice-register', label: 'Invoice Register', client: 'optional', about: 'All invoices issued in the period.' },
  ] },
  { label: 'Suppliers & payments', reports: [
    { key: 'ap-aging', label: 'Payables Aging', asAt: true, about: 'What is owed to suppliers and airlines, by how overdue it is. Reconciled to the ledger.' },
    { key: 'supplier-payments', label: 'Supplier Payments', about: 'Total paid to each supplier or airline in the period.' },
    { key: 'payment-register', label: 'Payment Register', client: 'optional', about: 'Every payment received and made in the period, with totals.' },
  ] },
  { label: 'Ledgers & books', reports: [
    { key: 'general-ledger', label: 'General Ledger', account: true, about: 'Every posting to one account with a running balance. Click a voucher to open it.' },
    { key: 'day-book', label: 'Day Book', about: 'Every ledger posting in the period, in date order.' },
    { key: 'cash-book', label: 'Cash & Bank Book', about: 'Opening, receipts, payments and closing balance for each cash and bank account.' },
  ] },
  { label: 'Planning', reports: [
    { key: 'cash-forecast', label: 'Cash Forecast', forecast: true, about: 'Money due in and out, week by week, from open invoices, ticket invoices and supplier bills.' },
    { key: 'departures', label: 'Departures', client: 'optional', about: 'Upcoming departures with the balance still due.' },
  ] },
];

/** Reports that need an extra choice (an account, a client, a forecast window) cannot run on a schedule. */
export const PARAM_REPORTS = new Set(CATALOG.flatMap((c) => c.reports).filter((r) => r.account || r.client === 'required' || r.forecast).map((r) => r.key));
