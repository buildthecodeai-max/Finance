import crypto from 'node:crypto';
import { HttpError } from '../errors.js';
import { Tenant } from '../db.js';
import { r2 } from './money.js';

export type Kind = 'journals' | 'invoices' | 'bills' | 'payments';
export type Format = 'generic' | 'xero' | 'quickbooks';
const MAX_ROWS = 50_000;
/** Spreadsheet-safe CSV cell: quotes, and neutralises formula injection in text. */
export const cell = (v: unknown) => { const s = String(v ?? ''); const num = /^-?\d+(\.\d+)?$/.test(s); const t = !num && /^[=+\-@\t\r]/.test(s) ? `'${s}` : s; return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
const csv = (head: string[], rows: unknown[][]) => [head, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');

export async function setMapping(t: Tenant, accountId: number, code: string | null, name?: string | null) {
  await t.ref('accounts', accountId, 'account');
  const ex = await t.one('SELECT id FROM account_mappings WHERE agency_id = ? AND account_id = ?', [t.agencyId, accountId]);
  if (!code) { if (ex) await t.remove('account_mappings', ex.id); return; }
  if (ex) await t.update('account_mappings', ex.id, { external_code: code, external_name: name ?? null }); else await t.insert('account_mappings', { account_id: accountId, external_code: code, external_name: name ?? null });
}

/**
 * Build an accounting export. Journals are the system of record for Xero/QuickBooks: they must balance, and for the
 * provider formats every account used must have an explicit mapping — we never guess an external code.
 */
export async function buildExport(t: Tenant, kind: Kind, format: Format, from: string, to: string) {
  let head: string[], rows: unknown[][];
  if (kind === 'journals') {
    const lines = await t.query(`SELECT v.voucher_no, v.voucher_date, v.voucher_type, v.narration, a.id account_id, a.code, a.name, m.external_code, g.debit, g.credit
      FROM gl_entries g JOIN vouchers v ON v.id = g.voucher_id AND v.agency_id = g.agency_id JOIN accounts a ON a.id = g.account_id AND a.agency_id = g.agency_id
      LEFT JOIN account_mappings m ON m.account_id = a.id AND m.agency_id = a.agency_id WHERE g.agency_id = ? AND v.voucher_date BETWEEN ? AND ? ORDER BY v.voucher_date, v.id, g.id LIMIT ?`, [t.agencyId, from, to, MAX_ROWS + 1]);
    if (lines.length > MAX_ROWS) throw new HttpError(413, 'Too many rows — narrow the date range');
    const d = r2(lines.reduce((s: number, l: any) => s + l.debit, 0)), c = r2(lines.reduce((s: number, l: any) => s + l.credit, 0));
    if (Math.abs(d - c) > 0.005) throw new HttpError(409, `Ledger for this period does not balance (debits ${d}, credits ${c}); fix it before exporting`);
    if (format !== 'generic') {
      const missing = [...new Map(lines.filter((l: any) => !l.external_code).map((l: any) => [l.account_id, `${l.code} ${l.name}`])).values()];
      if (missing.length) throw Object.assign(new HttpError(409, `Map these accounts to ${format} codes first: ${missing.join(', ')}`), { problems: missing.map((m) => ({ message: m })) });
    }
    const dt = (x: any) => String(x).slice(0, 10);
    if (format === 'xero') { head = ['*Narration', '*Date', 'Description', '*AccountCode', '*TaxRate', '*Amount']; rows = lines.map((l: any) => [`${l.voucher_no} ${l.narration ?? ''}`.trim().slice(0, 255), dt(l.voucher_date), l.narration ?? '', l.external_code, 'Tax Exempt', r2(l.debit - l.credit).toFixed(2)]); }
    else if (format === 'quickbooks') { head = ['Journal No', 'Journal Date', 'Account', 'Debits', 'Credits', 'Description']; rows = lines.map((l: any) => [l.voucher_no, dt(l.voucher_date), l.external_code, l.debit ? l.debit.toFixed(2) : '', l.credit ? l.credit.toFixed(2) : '', l.narration ?? '']); }
    else { head = ['Date', 'Voucher', 'Type', 'Narration', 'AccountCode', 'AccountName', 'ExternalCode', 'Debit', 'Credit']; rows = lines.map((l: any) => [dt(l.voucher_date), l.voucher_no, l.voucher_type, l.narration ?? '', l.code, l.name, l.external_code ?? '', l.debit.toFixed(2), l.credit.toFixed(2)]); }
  } else if (kind === 'invoices') {
    const r = await t.query(`SELECT i.number, c.name client, i.issue_date, i.due_date, i.status, i.currency, i.fx_rate, i.subtotal, i.tax_total, i.total, i.amount_paid, i.amount_credited FROM invoices i JOIN clients c ON c.id = i.client_id AND c.agency_id = i.agency_id
      WHERE i.agency_id = ? AND i.voucher_id IS NOT NULL AND i.issue_date BETWEEN ? AND ? ORDER BY i.issue_date, i.id LIMIT ?`, [t.agencyId, from, to, MAX_ROWS]);
    head = ['Number', 'Client', 'Issued', 'Due', 'Status', 'Currency', 'FxRate', 'Net', 'Tax', 'Total', 'Paid', 'Credited']; rows = r.map((x: any) => [x.number, x.client, String(x.issue_date).slice(0, 10), String(x.due_date).slice(0, 10), x.status, x.currency, x.fx_rate, x.subtotal, x.tax_total, x.total, x.amount_paid, x.amount_credited]);
  } else if (kind === 'bills') {
    const r = await t.query(`SELECT b.bill_no, s.name supplier, b.supplier_ref, b.bill_date, b.due_date, b.status, b.currency, b.fx_rate, b.subtotal, b.tax_total, b.total, b.amount_paid FROM supplier_bills b JOIN suppliers s ON s.id = b.supplier_id AND s.agency_id = b.agency_id
      WHERE b.agency_id = ? AND b.voucher_id IS NOT NULL AND b.bill_date BETWEEN ? AND ? ORDER BY b.bill_date, b.id LIMIT ?`, [t.agencyId, from, to, MAX_ROWS]);
    head = ['Bill', 'Supplier', 'SupplierRef', 'Date', 'Due', 'Status', 'Currency', 'FxRate', 'Net', 'Tax', 'Total', 'Paid']; rows = r.map((x: any) => [x.bill_no, x.supplier, x.supplier_ref, String(x.bill_date).slice(0, 10), String(x.due_date).slice(0, 10), x.status, x.currency, x.fx_rate, x.subtotal, x.tax_total, x.total, x.amount_paid]);
  } else {
    const r = await t.query(`SELECT p.paid_at, p.direction, COALESCE(c.name, s.name) party, p.method, p.currency, p.fx_rate, p.amount, p.reference FROM payments p LEFT JOIN clients c ON c.id = p.client_id AND c.agency_id = p.agency_id LEFT JOIN suppliers s ON s.id = p.supplier_id AND s.agency_id = p.agency_id
      WHERE p.agency_id = ? AND p.voided = 0 AND p.paid_at BETWEEN ? AND ? ORDER BY p.paid_at, p.id LIMIT ?`, [t.agencyId, from, to, MAX_ROWS]);
    head = ['Date', 'Direction', 'Party', 'Method', 'Currency', 'FxRate', 'Amount', 'Reference']; rows = r.map((x: any) => [String(x.paid_at).slice(0, 10), x.direction, x.party ?? '', x.method, x.currency, x.fx_rate, x.amount, x.reference ?? '']);
  }
  const body = csv(head, rows), checksum = crypto.createHash('sha256').update(body).digest('hex');
  await t.insert('accounting_exports', { kind, format, date_from: from, date_to: to, row_count: rows.length, checksum, created_by: t.actor.userId });
  return { body, checksum, rows: rows.length };
}
