import { Tenant } from '../db.js';
import { HttpError } from '../auth.js';
import { r2 } from './money.js';

/** Default chart seeded per agency (mirrors the legacy software's accounts). */
const DEFAULT_ACCOUNTS: [number, string, string | null, null][] = [
  [110, 'Cash in Hand', 'cash', null], [110, 'Main Bank Account', 'bank', null],
  [410, 'Ticket Sales', 'sales', null], [410, 'Booking Revenue', 'booking_revenue', null], [210, 'Tax Payable (GST/VAT)', 'tax_payable', null], [121, 'Tax Receivable (input)', 'tax_input', null], [310, 'Supplier Costs', 'cost_of_sales', null], [321, 'FX Gain / Loss', 'fx_gain_loss', null], [420, 'Service Charges', 'service_charges', null],
  [320, 'Discount Allowed to Customers', null, null], [320, 'Electricity Bill', null, null], [320, 'Salaries', null, null],
  [320, 'Printing & Stationary', null, null], [320, 'Administrative Expenses', null, null], [320, 'Director Expenses', null, null],
  [320, 'Bonus to Staff', null, null], [320, 'Travelling & Conveyance', null, null], [320, 'Rent', null, null],
  [320, 'Repairs & Maintenance', null, null], [320, 'Computer Maintenance', null, null], [320, 'Telephone Bills', null, null],
  [320, 'Gas Bills', null, null], [320, 'Water Bills', null, null], [320, 'Entertainment', null, null], [320, 'MISC Expenses', null, null],
  [320, 'Commission Paid', 'commission_paid', null],
];

export async function seedChart(t: Tenant) {
  if (await t.one('SELECT id FROM accounts WHERE agency_id = ? LIMIT 1', [t.agencyId])) return;
  await t.insert('branches', { name: 'Head Office' });
  await t.insert('departments', { name: 'Main' });
  const branch = (await t.one('SELECT id FROM branches WHERE agency_id = ? LIMIT 1', [t.agencyId]))!.id;
  for (const [type, name, key] of DEFAULT_ACCOUNTS)
    await createAccount(t, { type_code: type, name, sys_key: key, branch_id: branch });
}

/** Code = 3-digit type + 4-digit sequence within the type, e.g. 3200021 (matches the legacy numbering). */
export async function nextAccountCode(t: Tenant, type: number): Promise<string> {
  await t.agency(true); // serialise code allocation per agency (see nextDocNo)
  const r = await t.one<{ m: string | null }>(
    `SELECT MAX(code) m FROM accounts WHERE agency_id = ? AND type_code = ? FOR UPDATE`, [t.agencyId, type]);
  const n = r?.m ? Number(String(r.m).slice(3)) + 1 : 1;
  return `${type}${String(n).padStart(4, '0')}`;
}

export async function createAccount(t: Tenant, a: Record<string, any>): Promise<number> {
  return t.insert('accounts', { ...a, code: a.code ?? (await nextAccountCode(t, a.type_code)), created_by: t.actor.userId });
}

export async function sysAccount(t: Tenant, key: string): Promise<number> {
  const a = await t.one('SELECT id FROM accounts WHERE agency_id = ? AND sys_key = ? LIMIT 1', [t.agencyId, key]);
  if (!a) throw new HttpError(500, `System account '${key}' missing — create an account with that key`);
  return a.id;
}

export interface Leg { account_id: number; debit?: number; credit?: number; narration?: string }

async function nextVoucherNo(t: Tenant, type: string) {
  const prefix = ({ receipt: 'RV', payment: 'PV', journal: 'JV', ticket_invoice: 'TI', refund: 'RF', invoice: 'IV', credit_note: 'CN', bill: 'BL', reversal: 'RX', commission: 'CM' } as Record<string, string>)[type];
  return nextDocNo(t, 'vouchers', 'voucher_no', prefix!, 'voucher_type = ?', [type]);
}

/** Posts a balanced voucher. Rejects unbalanced entries (to the cent). Returns voucher id. Run inside t.tx(). */
export async function postVoucher(t: Tenant, v: {
  type: 'receipt' | 'payment' | 'journal' | 'ticket_invoice' | 'refund' | 'invoice' | 'credit_note' | 'bill' | 'reversal' | 'commission'; date: string; narration?: string;
  ref_table?: string; ref_id?: number; legs: Leg[];
}): Promise<number> {
  const legs = v.legs.filter((l) => (l.debit ?? 0) !== 0 || (l.credit ?? 0) !== 0)
    .map((l) => {
      // negative amounts flip side so callers can pass signed results
      let d = r2(l.debit ?? 0), c = r2(l.credit ?? 0);
      if (d < 0) { c += -d; d = 0; } if (c < 0) { d += -c; c = 0; }
      return { ...l, debit: d, credit: c };
    });
  const dr = r2(legs.reduce((s, l) => s + l.debit, 0)), cr = r2(legs.reduce((s, l) => s + l.credit, 0));
  if (!legs.length) throw new HttpError(400, 'Voucher has no amounts');
  if (Math.abs(dr - cr) > 0.005) throw new HttpError(400, `Voucher out of balance: Dr ${dr} ≠ Cr ${cr}`);
  await t.assertPeriodOpen(v.date);
  const id = await t.insert('vouchers', {
    voucher_type: v.type, voucher_no: await nextVoucherNo(t, v.type), voucher_date: v.date,
    narration: v.narration ?? null, ref_table: v.ref_table ?? null, ref_id: v.ref_id ?? null, created_by: t.actor.userId ?? null,
  });
  for (const l of legs) {
    // locking read: sees accounts created by a transaction we just waited for (a plain read would use our older snapshot)
    if (!(await t.one('SELECT id FROM accounts WHERE agency_id = ? AND id = ? LOCK IN SHARE MODE', [t.agencyId, l.account_id]))) throw new HttpError(400, `Unknown account ${l.account_id}`);
    await t.query(
      'INSERT INTO gl_entries (agency_id, voucher_id, account_id, entry_date, debit, credit, narration) VALUES (?,?,?,?,?,?,?)',
      [t.agencyId, id, l.account_id, v.date, l.debit, l.credit, l.narration ?? v.narration ?? null]);
  }
  return id;
}

/** Remove a voucher and its GL entries (used by Re-Post and by edits to unposted documents). */
export async function unpostVoucher(t: Tenant, voucherId: number | null | undefined) {
  if (!voucherId) return;
  const v = await t.get('vouchers', voucherId);
  if (v) await t.assertPeriodOpen(v.voucher_date); // posted history in a locked period is reversed, not deleted
  await t.query('DELETE FROM gl_entries WHERE agency_id = ? AND voucher_id = ?', [t.agencyId, voucherId]);
  await t.remove('vouchers', voucherId);
}

export async function nextDocNo(t: Tenant, table: string, col: string, prefix: string, where = '1=1', params: any[] = []) {
  // Serialise numbering per agency: inside a transaction this row lock is held until commit, so concurrent creators queue
  // instead of computing the same number (which used to fail the loser with a spurious 'Duplicate record').
  await t.agency(true);
  // max numeric suffix + 1 (COUNT would re-issue numbers after a delete)
  const r = await t.one<{ n: number | null }>(
    `SELECT MAX(CAST(SUBSTRING_INDEX(${col}, '-', -1) AS UNSIGNED)) n FROM ${table} WHERE agency_id = ? AND ${where} FOR UPDATE`, [t.agencyId, ...params]); // locking read: sees rows committed by transactions we just waited for
  return `${prefix}-${String((r?.n ?? 0) + 1).padStart(6, '0')}`;
}

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
const below1000 = (n: number): string =>
  n < 20 ? ONES[n] : n < 100 ? `${TENS[Math.floor(n / 10)]}${n % 10 ? ' ' + ONES[n % 10] : ''}`
    : `${ONES[Math.floor(n / 100)]} Hundred${n % 100 ? ' ' + below1000(n % 100) : ''}`;

/** Amount in words for cheque printing, e.g. 1250.50 -> "One Thousand Two Hundred Fifty and 50/100 Only". */
export function amountInWords(amount: number): string {
  const whole = Math.floor(Math.abs(amount)), cents = Math.round((Math.abs(amount) - whole) * 100);
  const scales: [number, string][] = [[1e9, 'Billion'], [1e6, 'Million'], [1e3, 'Thousand']];
  let n = whole, out: string[] = [];
  for (const [v, name] of scales) if (n >= v) { out.push(`${below1000(Math.floor(n / v))} ${name}`); n %= v; }
  if (n > 0 || !out.length) out.push(n === 0 ? 'Zero' : below1000(n));
  return `${out.join(' ')}${cents ? ` and ${String(cents).padStart(2, '0')}/100` : ''} Only`;
}

/** Account balance helper SQL: opening + GL movement, as Dr−Cr. */
export const BALANCE_SQL = `(a.opening_dr - a.opening_cr + COALESCE((SELECT SUM(g.debit - g.credit) FROM gl_entries g WHERE g.agency_id = a.agency_id AND g.account_id = a.id),0))`;

const SYS_ACCOUNTS: Record<string, [number, string]> = {
  booking_revenue: [410, 'Booking Revenue'], tax_payable: [210, 'Tax Payable (GST/VAT)'], tax_input: [121, 'Tax Receivable (input)'],
  cost_of_sales: [310, 'Supplier Costs'], fx_gain_loss: [321, 'FX Gain / Loss'], agent_commission_expense: [320, 'Agent Commission Expense'],
  commission_payable: [210, 'Commissions Payable'], commission_income: [420, 'Supplier Commission Income'], bank_fees: [321, 'Bank Charges'], cash: [110, 'Cash in Hand'], bank: [110, 'Main Bank Account'],
};
/** System account by key, created on first use (older agencies predate some of these). */
export async function ensureSys(t: Tenant, key: string): Promise<number> {
  const find = () => t.one('SELECT id FROM accounts WHERE agency_id = ? AND sys_key = ? LIMIT 1 LOCK IN SHARE MODE', [t.agencyId, key]);
  const a = await find();
  if (a) return a.id;
  const def = SYS_ACCOUNTS[key]; if (!def) throw new HttpError(500, `Unknown system account ${key}`);
  await t.agency(true);                         // serialise creators, then re-check: another transaction may have just made it
  const again = await find(); if (again) return again.id;
  return createAccount(t, { type_code: def[0], name: def[1], sys_key: key });
}

/** Control account for a client (type 120) or supplier (type 210); created on first use and linked. */
export async function ensureParty(t: Tenant, table: 'clients' | 'suppliers', id: number): Promise<number> {
  // lock the party row so two concurrent first-time postings can't both create (and link) an account
  const row = (await t.query(`SELECT * FROM ${table === 'clients' ? 'clients' : 'suppliers'} WHERE agency_id = ? AND id = ? FOR UPDATE`, [t.agencyId, id]))[0];
  if (!row) throw new HttpError(400, `Unknown ${table === 'clients' ? 'client' : 'supplier'}`);
  if (row.account_id) return row.account_id;
  const accountId = await createAccount(t, { type_code: table === 'clients' ? 120 : 210, name: row.name });
  await t.update(table, id, { account_id: accountId });
  return accountId;
}

/** Reverse a posted voucher (swap debit/credit) instead of deleting it. Honours period locks on the reversal date. */
/**
 * Display filter for ledger listings: a voided receipt/payment and its reversal cancel to zero, so when BOTH fall inside the period shown
 * they are left out of the list (the totals and running balance are unchanged). Needs aliases g = gl_entries, v = vouchers; params: [from, to, from, to].
 */
export const HIDE_VOIDED_PAIRS = `
  AND NOT (v.voucher_type IN ('receipt','payment') AND v.reversed_by IS NOT NULL AND g.entry_date >= ?
           AND EXISTS (SELECT 1 FROM gl_entries r WHERE r.agency_id = g.agency_id AND r.voucher_id = v.reversed_by AND r.entry_date <= ?))
  AND NOT (v.reversal_of IS NOT NULL AND EXISTS (SELECT 1 FROM vouchers o WHERE o.agency_id = v.agency_id AND o.id = v.reversal_of AND o.voucher_type IN ('receipt','payment')
           AND EXISTS (SELECT 1 FROM gl_entries og WHERE og.agency_id = o.agency_id AND og.voucher_id = o.id AND og.entry_date >= ?)) AND g.entry_date <= ?)`;

export async function reverseVoucher(t: Tenant, voucherId: number, date: string, reason: string): Promise<number> {
  const v = await t.get('vouchers', voucherId);
  if (!v) throw new HttpError(404, 'Voucher not found');
  if (v.reversed_by) throw new HttpError(409, 'Voucher is already reversed');
  const legs = await t.query('SELECT account_id, debit, credit, narration FROM gl_entries WHERE agency_id = ? AND voucher_id = ?', [t.agencyId, voucherId]);
  const rid = await postVoucher(t, { type: 'reversal', date, narration: `Reversal of ${v.voucher_no}: ${reason}`, ref_table: 'vouchers', ref_id: voucherId,
    legs: legs.map((l: any) => ({ account_id: l.account_id, debit: l.credit, credit: l.debit, narration: `Reversal: ${l.narration ?? ''}`.slice(0, 480) })) });
  await t.update('vouchers', voucherId, { reversed_by: rid });
  await t.update('vouchers', rid, { reversal_of: voucherId });
  return rid;
}

/** Second-person approval above the agency threshold (base currency). */
export async function assertSecondApprover(t: Tenant, baseAmount: number, makerId: number | null | undefined, checkerId: number, what: string) {
  const a = await t.agency();
  if (a.approval_threshold > 0 && baseAmount > a.approval_threshold && makerId === checkerId)
    throw new HttpError(403, `${what} above ${a.approval_threshold} must be approved by a different person`);
}
