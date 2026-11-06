import { agencyLogoData } from '../services/vouchers.js';
import { Router } from 'express';
import ExcelJS from 'exceljs';
import { HttpError, requireRole } from '../auth.js';
import { fileKey, putFile, signedUrl } from '../storage.js';
import { htmlToPdf, tableHtml } from '../services/pdf.js';
import { T } from './util.js';
import { Tenant } from '../db.js';
import { BALANCE_SQL } from '../services/accounting.js';

export const reportsRouter = Router();

export interface Reconcile { label: string; report: number; source: number; difference: number; ok: boolean }
/** links[i] is an in-app route for rows[i] (drill-down); kinds[i] is 'section' | 'total' | 'muted' for styling. */
export interface Report { title: string; columns: string[]; rows: any[][]; reconcile?: Reconcile[]; note?: string; links?: (string | null)[]; kinds?: string[] }
const rec = (label: string, report: number, source: number): Reconcile => { const difference = Math.round((report - source) * 100) / 100; return { label, report: Math.round(report * 100) / 100, source: Math.round(source * 100) / 100, difference, ok: Math.abs(difference) <= 0.05 }; };
const isCurrent = (to: string) => to >= new Date().toISOString().slice(0, 10);
const ASOF = 'Aging uses current balances, so it is reconciled to the ledger only when the report date is today or later.';
export type Gen = (t: Tenant, from: string, to: string, opts?: Record<string, string>) => Promise<Report>;
/** Reports that need an extra parameter and so cannot be scheduled. */
export const PARAM_REPORTS = new Set(['general-ledger', 'client-statement']);
/** Ledger-derived statements: finance roles only (the older operational reports keep their existing access). */
const LEDGER_REPORTS = new Set(['sales-by-client', 'client-statement', 'trial-balance', 'balance-sheet', 'general-ledger', 'day-book', 'cash-book', 'payment-register', 'gl-pnl']);
const n2 = (v: any) => Number(v ?? 0).toFixed(2);
/** Optional "just this client" filter shared by the client-aware reports. */
async function clientFilter(t: Tenant, o?: Record<string, string>): Promise<{ id: number; name: string } | null> {
  if (!o?.client_id) return null;
  const id = Number(o.client_id); if (!id) throw new HttpError(400, 'Invalid client');
  const c = await t.get('clients', id); if (!c) throw new HttpError(404, 'Client not found');
  return c;
}
const forClient = (c: { name: string } | null) => (c ? ` — ${c.name}` : '');


const BAL_AT = `(a.opening_dr - a.opening_cr + COALESCE((SELECT SUM(g.debit - g.credit) FROM gl_entries g WHERE g.agency_id = a.agency_id AND g.account_id = a.id AND g.entry_date <= ?),0))`;
const sum = (xs: number[]) => Math.round(xs.reduce((s, x) => s + x, 0) * 100) / 100;
const VOUCHER_PAGE: Record<string, string> = { invoices: '/invoices', receipts: '/client-receipts', supplier_bills: '/supplier-bills', credit_notes: '/credit-notes', ticket_invoices: '/ticket-invoices',
  payment_runs: '/payment-runs', commission_periods: '/commissions', client_refunds: '/credit-notes', refunds: '/refunds', bank_transactions: '/reconciliation' };
/** Where the document behind a ledger voucher lives in the app. */
const voucherLink = (v: any): string | null =>
  v.ref_table === 'cash_vouchers' ? (v.voucher_type === 'receipt' ? '/receipts' : '/payment-vouchers')
    : v.voucher_type === 'journal' && !v.ref_table ? `/journal?view=${v.vid}` : VOUCHER_PAGE[v.ref_table] ?? null;
const LIMIT = 3000;

// All amounts are converted to agency base currency using the invoice/payment fx_rate.
export const GENERATORS: Record<string, Gen> = {
  'pnl': async (t, from, to) => {
    const [rev] = await t.query(`SELECT COALESCE(SUM(i.subtotal*i.fx_rate),0) revenue FROM invoices i WHERE i.agency_id = ? AND i.status NOT IN ('draft','void') AND i.issue_date BETWEEN ? AND ?`, [t.agencyId, from, to]);
    const [cos] = await t.query(`SELECT COALESCE(SUM(l.unit_cost*l.quantity*i.fx_rate),0) cost FROM invoice_lines l JOIN invoices i ON i.id=l.invoice_id AND i.agency_id=l.agency_id WHERE l.agency_id = ? AND i.status NOT IN ('draft','void') AND i.issue_date BETWEEN ? AND ?`, [t.agencyId, from, to]);
    const exp = await t.query(`SELECT category, SUM(amount*fx_rate) amt FROM expenses WHERE agency_id = ? AND incurred_on BETWEEN ? AND ? GROUP BY category`, [t.agencyId, from, to]);
    const expTotal = exp.reduce((s: number, e: any) => s + e.amt, 0);
    const gross = rev.revenue - cos.cost;
    return { title: `Profit & Loss ${from} → ${to}`, columns: ['Line', 'Amount'], rows: [
      ['Revenue (ex-tax)', n2(rev.revenue)], ['Cost of sales (supplier cost)', n2(cos.cost)], ['Gross profit', n2(gross)],
      ...exp.map((e: any) => [`Expense: ${e.category}`, n2(e.amt)]), ['Total expenses', n2(expTotal)], ['Net profit', n2(gross - expTotal)]] };
  },
  'cash-flow': async (t, from, to) => {
    const rows = await t.query(`SELECT DATE_FORMAT(paid_at,'%Y-%m') m, SUM(CASE WHEN direction='inbound' THEN amount*fx_rate ELSE 0 END) inflow, SUM(CASE WHEN direction='outbound' THEN amount*fx_rate ELSE 0 END) outflow FROM payments WHERE agency_id = ? AND voided = 0 AND paid_at BETWEEN ? AND ? GROUP BY m ORDER BY m`, [t.agencyId, from, to]);
    let run = 0;
    return { title: `Cash Flow ${from} → ${to}`, columns: ['Month', 'Inflow', 'Outflow', 'Net', 'Cumulative'],
      rows: rows.map((r: any) => { run += r.inflow - r.outflow; return [r.m, n2(r.inflow), n2(r.outflow), n2(r.inflow - r.outflow), n2(run)]; }) };
  },
  'ar-aging-summary': async (t, _f, to, o) => {
    const cl = await clientFilter(t, o);
    const rows = await t.query(`SELECT c.name, SUM(CASE WHEN DATEDIFF(?,i.due_date)<=0 THEN b ELSE 0 END) current_,
      SUM(CASE WHEN DATEDIFF(?,i.due_date) BETWEEN 1 AND 30 THEN b ELSE 0 END) d30, SUM(CASE WHEN DATEDIFF(?,i.due_date) BETWEEN 31 AND 60 THEN b ELSE 0 END) d60,
      SUM(CASE WHEN DATEDIFF(?,i.due_date)>60 THEN b ELSE 0 END) d90, SUM(b) total
      FROM (SELECT *, (total-amount_credited-amount_paid)*fx_rate b FROM invoices) i JOIN clients c ON c.id=i.client_id AND c.agency_id=i.agency_id
      WHERE i.agency_id = ? AND i.status IN ('sent','partially_paid','overdue') ${cl ? 'AND i.client_id = ?' : ''} GROUP BY c.id, c.name ORDER BY total DESC`, [to, to, to, to, t.agencyId, ...(cl ? [cl.id] : [])]);
    return { title: `AR Aging Summary as at ${to}${forClient(cl)}`, columns: ['Client', 'Current', '1-30', '31-60', '60+', 'Total'],
      rows: rows.map((r: any) => [r.name, n2(r.current_), n2(r.d30), n2(r.d60), n2(r.d90), n2(r.total)]) };
  },
  'ar-aging-detail': async (t, _f, to, o) => {
    const cl = await clientFilter(t, o);
    const rows = await t.query(`SELECT i.number, c.name, i.due_date, i.currency, i.total, i.amount_paid, i.amount_credited, DATEDIFF(?, i.due_date) days FROM invoices i JOIN clients c ON c.id=i.client_id AND c.agency_id=i.agency_id WHERE i.agency_id = ? AND i.status IN ('sent','partially_paid','overdue') ${cl ? 'AND i.client_id = ?' : ''} ORDER BY days DESC`, [to, t.agencyId, ...(cl ? [cl.id] : [])]);
    return { title: `AR Aging Detail as at ${to}${forClient(cl)}`, columns: ['Invoice', 'Client', 'Due', 'Currency', 'Total', 'Paid', 'Balance', 'Days overdue'],
      rows: rows.map((r: any) => [r.number, r.name, r.due_date, r.currency, n2(r.total), n2(r.amount_paid + r.amount_credited), n2(r.total - r.amount_credited - r.amount_paid), Math.max(0, r.days)]) };
  },
  'commission-summary': async (t, from, to) => {
    const rows = await t.query(`SELECT COALESCE(u.name,'Unassigned') agent, COUNT(*) n, SUM(c.selling_price) sell, SUM(c.supplier_cost) cost, SUM(c.overhead) oh, SUM(c.net_commission) net, SUM(c.agent_amount) pay FROM commissions c LEFT JOIN users u ON u.id=c.agent_id WHERE c.agency_id = ? AND c.period BETWEEN ? AND ? GROUP BY u.id, u.name`, [t.agencyId, from.slice(0, 7), to.slice(0, 7)]);
    return { title: `Commission Summary ${from} → ${to}`, columns: ['Agent', 'Bookings', 'Selling', 'Cost', 'Overhead', 'Net commission', 'Agent payable'],
      rows: rows.map((r: any) => [r.agent, r.n, n2(r.sell), n2(r.cost), n2(r.oh), n2(r.net), n2(r.pay)]) };
  },
  'revenue-by-destination': async (t, from, to, o) => {
    const cl = await clientFilter(t, o);
    const rows = await t.query(`SELECT COALESCE(b.destination,'Unspecified') d, COUNT(DISTINCT b.id) n, SUM(i.subtotal*i.fx_rate) rev FROM invoices i LEFT JOIN bookings b ON b.id=i.booking_id AND b.agency_id=i.agency_id WHERE i.agency_id = ? AND i.status NOT IN ('draft','void') AND i.issue_date BETWEEN ? AND ? ${cl ? 'AND i.client_id = ?' : ''} GROUP BY d ORDER BY rev DESC`, [t.agencyId, from, to, ...(cl ? [cl.id] : [])]);
    return { title: `Booking Revenue by Destination ${from} → ${to}${forClient(cl)}`, columns: ['Destination', 'Bookings', 'Revenue'], rows: rows.map((r: any) => [r.d, r.n, n2(r.rev)]) };
  },
  'supplier-payments': async (t, from, to) => {
    const rows = await t.query(`SELECT s.name, COUNT(*) n, SUM(p.amount*p.fx_rate) amt FROM payments p JOIN suppliers s ON s.id=p.supplier_id AND s.agency_id=p.agency_id WHERE p.agency_id = ? AND p.voided = 0 AND p.direction='outbound' AND p.paid_at BETWEEN ? AND ? GROUP BY s.id, s.name ORDER BY amt DESC`, [t.agencyId, from, to]);
    return { title: `Supplier Payment Summary ${from} → ${to}`, columns: ['Supplier', 'Payments', 'Total paid'], rows: rows.map((r: any) => [r.name, r.n, n2(r.amt)]) };
  },
  'invoice-register': async (t, from, to, o) => {
    const cl = await clientFilter(t, o);
    const rows = await t.query(`SELECT i.number, c.name, i.issue_date, i.due_date, i.status, i.currency, i.total, i.amount_paid FROM invoices i JOIN clients c ON c.id=i.client_id AND c.agency_id=i.agency_id WHERE i.agency_id = ? AND i.issue_date BETWEEN ? AND ? ${cl ? 'AND i.client_id = ?' : ''} ORDER BY i.number`, [t.agencyId, from, to, ...(cl ? [cl.id] : [])]);
    return { title: `Invoice Register ${from} → ${to}${forClient(cl)}`, columns: ['Number', 'Client', 'Issued', 'Due', 'Status', 'Currency', 'Total', 'Paid'],
      rows: rows.map((r: any) => [r.number, r.name, r.issue_date, r.due_date, r.status, r.currency, n2(r.total), n2(r.amount_paid)]) };
  },
  'ap-aging': async (t, _f, to) => {
    const rows = await t.query(`SELECT s.name, b.bill_no, b.supplier_ref, b.due_date, b.currency, b.total, b.amount_paid, (b.total-b.amount_paid)*b.fx_rate base, DATEDIFF(?, b.due_date) days
      FROM supplier_bills b JOIN suppliers s ON s.id=b.supplier_id AND s.agency_id=b.agency_id WHERE b.agency_id = ? AND b.status IN ('approved','partially_paid') AND b.total-b.amount_paid > 0.005 ORDER BY b.due_date`, [to, t.agencyId]);
    return { title: `Payables Aging as at ${to}`, columns: ['Supplier', 'Bill', 'Their ref', 'Due', 'Currency', 'Outstanding', 'Outstanding (base)', 'Days overdue'],
      rows: rows.map((r: any) => [r.name, r.bill_no, r.supplier_ref, r.due_date, r.currency, n2(r.total - r.amount_paid), n2(r.base), Math.max(0, r.days)]) };
  },
  'gl-pnl': async (t, from, to) => {
    const rows = await t.query(`SELECT a.code, a.name, a.type_code, COALESCE(SUM(g.credit - g.debit),0) net FROM accounts a JOIN gl_entries g ON g.account_id = a.id AND g.agency_id = a.agency_id
      JOIN vouchers v ON v.id = g.voucher_id AND v.agency_id = g.agency_id WHERE a.agency_id = ? AND a.type_code BETWEEN 300 AND 499 AND v.voucher_date BETWEEN ? AND ? GROUP BY a.id, a.code, a.name, a.type_code ORDER BY a.code`, [t.agencyId, from, to]);
    const income = rows.filter((r: any) => r.type_code >= 400), costs = rows.filter((r: any) => r.type_code < 400), inc = income.reduce((s: number, r: any) => s + r.net, 0), cost = costs.reduce((s: number, r: any) => s - r.net, 0);
    return { title: `Profit & Loss (ledger) ${from} → ${to}`, columns: ['Account', 'Amount'], rows: [...income.map((r: any) => [`${r.code} ${r.name}`, n2(r.net)]), ['Total income', n2(inc)], ...costs.map((r: any) => [`${r.code} ${r.name}`, n2(-r.net)]), ['Total costs & expenses', n2(cost)], ['Net profit', n2(inc - cost)]] };
  },

  'trial-balance': async (t, _f, to) => {
    const rows = await t.query(`SELECT a.id, a.code, a.name, at.name type, ${BAL_AT} bal FROM accounts a JOIN account_types at ON at.code = a.type_code WHERE a.agency_id = ? ORDER BY a.code`, [to, t.agencyId]);
    const live = rows.filter((r: any) => Math.abs(r.bal) > 0.004), dr = (r: any) => (r.bal > 0 ? r.bal : 0), cr = (r: any) => (r.bal < 0 ? -r.bal : 0);
    const td = sum(live.map(dr)), tc = sum(live.map(cr));
    return { title: `Trial Balance as at ${to}`, columns: ['Code', 'Account', 'Type', 'Debit', 'Credit'],
      rows: [...live.map((r: any) => [r.code, r.name, r.type, n2(dr(r)), n2(cr(r))]), ['Total', '', '', n2(td), n2(tc)]],
      links: [...live.map((r: any) => `/accounts?open=${r.id}`), null], kinds: [...live.map(() => ''), 'total'],
      reconcile: [rec('Total debits vs total credits (must be equal)', td, tc)] };
  },
  'balance-sheet': async (t, _f, to) => {
    const all = await t.query(`SELECT a.id, a.code, a.name, at.nature, ${BAL_AT} bal FROM accounts a JOIN account_types at ON at.code = a.type_code WHERE a.agency_id = ? ORDER BY a.code`, [to, t.agencyId]);
    const live = all.filter((r: any) => Math.abs(r.bal) > 0.004), of = (n: string) => live.filter((r: any) => r.nature === n);
    const rows: any[][] = [], links: (string | null)[] = [], kinds: string[] = [];
    const add = (row: any[], kind = '', link: string | null = null) => { rows.push(row); kinds.push(kind); links.push(link); };
    add(['ASSETS', ''], 'section'); of('asset').forEach((r: any) => add([`${r.code} ${r.name}`, n2(r.bal)], '', `/accounts?open=${r.id}`));
    const assets = sum(of('asset').map((r: any) => r.bal)); add(['Total assets', n2(assets)], 'total');
    add(['LIABILITIES', ''], 'section'); of('liability').forEach((r: any) => add([`${r.code} ${r.name}`, n2(-r.bal)], '', `/accounts?open=${r.id}`));
    const liab = sum(of('liability').map((r: any) => -r.bal)); add(['Total liabilities', n2(liab)], 'total');
    add(['EQUITY', ''], 'section'); of('equity').forEach((r: any) => add([`${r.code} ${r.name}`, n2(-r.bal)], '', `/accounts?open=${r.id}`));
    const profit = sum([...of('income'), ...of('expense')].map((r: any) => -r.bal)); add(['Profit to date (income less expenses)', n2(profit)]);
    const equity = sum([...of('equity').map((r: any) => -r.bal), profit]); add(['Total equity', n2(equity)], 'total');
    add(['Total liabilities & equity', n2(liab + equity)], 'total');
    return { title: `Balance Sheet as at ${to}`, columns: ['Account', 'Amount'], rows, links, kinds,
      reconcile: [rec('Total assets vs total liabilities & equity (must be equal)', assets, liab + equity)] };
  },
  'general-ledger': async (t, from, to, o) => {
    const id = Number(o?.account_id); if (!id) throw new HttpError(400, 'Choose an account for the general ledger');
    const acc = await t.get('accounts', id); if (!acc) throw new HttpError(404, 'Account not found');
    const prior = await t.one<{ d: number }>('SELECT COALESCE(SUM(debit - credit),0) d FROM gl_entries WHERE agency_id = ? AND account_id = ? AND entry_date < ?', [t.agencyId, id, from]);
    const opening = sum([acc.opening_dr - acc.opening_cr, prior!.d]);
    const ents = await t.query(`SELECT g.entry_date, g.debit, g.credit, g.narration, v.id vid, v.voucher_no, v.voucher_type, v.ref_table FROM gl_entries g JOIN vouchers v ON v.id = g.voucher_id AND v.agency_id = g.agency_id
      WHERE g.agency_id = ? AND g.account_id = ? AND g.entry_date BETWEEN ? AND ? ORDER BY g.entry_date, g.id`, [t.agencyId, id, from, to]);
    let bal = opening;
    const rows: any[][] = [['', 'Opening balance', '', '', '', n2(opening)]], links: (string | null)[] = [null], kinds = ['muted'];
    for (const e of ents) { bal = sum([bal, e.debit, -e.credit]); rows.push([e.entry_date, e.voucher_no, e.narration ?? '', e.debit ? n2(e.debit) : '', e.credit ? n2(e.credit) : '', n2(bal)]); links.push(voucherLink(e)); kinds.push(''); }
    rows.push(['Total', '', '', n2(sum(ents.map((e: any) => e.debit))), n2(sum(ents.map((e: any) => e.credit))), n2(bal)]); links.push(null); kinds.push('total');
    const out: Report = { title: `General Ledger — ${acc.code} ${acc.name}, ${from} → ${to}`, columns: ['Date', 'Voucher', 'Narration', 'Debit', 'Credit', 'Balance'], rows, links, kinds,
      note: 'Balance: positive = debit, negative = credit.' };
    if (isCurrent(to)) { const cur = await t.one<{ v: number }>(`SELECT ${BALANCE_SQL} v FROM accounts a WHERE a.agency_id = ? AND a.id = ?`, [t.agencyId, id]); out.reconcile = [rec('Closing balance vs current account balance', bal, cur!.v)]; }
    return out;
  },
  'day-book': async (t, from, to) => {
    const ents = await t.query(`SELECT g.entry_date, g.debit, g.credit, g.narration, v.id vid, v.voucher_no, v.voucher_type, v.ref_table, a.code, a.name FROM gl_entries g
      JOIN vouchers v ON v.id = g.voucher_id AND v.agency_id = g.agency_id JOIN accounts a ON a.id = g.account_id AND a.agency_id = g.agency_id
      WHERE g.agency_id = ? AND g.entry_date BETWEEN ? AND ? ORDER BY g.entry_date, v.id, g.id LIMIT ${LIMIT + 1}`, [t.agencyId, from, to]);
    const tot = await t.one<{ d: number; c: number; n: number }>('SELECT COALESCE(SUM(debit),0) d, COALESCE(SUM(credit),0) c, COUNT(*) n FROM gl_entries WHERE agency_id = ? AND entry_date BETWEEN ? AND ?', [t.agencyId, from, to]);
    const shown = ents.slice(0, LIMIT);
    return { title: `Day Book ${from} → ${to}`, columns: ['Date', 'Voucher', 'Type', 'Account', 'Narration', 'Debit', 'Credit'],
      rows: [...shown.map((e: any) => [e.entry_date, e.voucher_no, e.voucher_type.replace(/_/g, ' '), `${e.code} ${e.name}`, e.narration ?? '', e.debit ? n2(e.debit) : '', e.credit ? n2(e.credit) : '']), ['Total', '', '', '', '', n2(tot!.d), n2(tot!.c)]],
      links: [...shown.map(voucherLink), null], kinds: [...shown.map(() => ''), 'total'],
      note: ents.length > LIMIT ? `Showing the first ${LIMIT} of ${tot!.n} lines; narrow the dates or export for the full day book.` : undefined,
      reconcile: [rec('Ledger debits vs credits for the period (must balance)', tot!.d, tot!.c)] };
  },
  'cash-book': async (t, from, to) => {
    const rows = await t.query(`SELECT a.id, a.code, a.name,
      a.opening_dr - a.opening_cr + COALESCE((SELECT SUM(g.debit - g.credit) FROM gl_entries g WHERE g.agency_id = a.agency_id AND g.account_id = a.id AND g.entry_date < ?),0) opening,
      COALESCE((SELECT SUM(g.debit) FROM gl_entries g WHERE g.agency_id = a.agency_id AND g.account_id = a.id AND g.entry_date BETWEEN ? AND ?),0) receipts,
      COALESCE((SELECT SUM(g.credit) FROM gl_entries g WHERE g.agency_id = a.agency_id AND g.account_id = a.id AND g.entry_date BETWEEN ? AND ?),0) payments
      FROM accounts a WHERE a.agency_id = ? AND a.type_code = 110 ORDER BY a.code`, [from, from, to, from, to, t.agencyId]);
    const cl = (r: any) => sum([r.opening, r.receipts, -r.payments]);
    const out: Report = { title: `Cash & Bank Book ${from} → ${to}`, columns: ['Account', 'Opening', 'Receipts', 'Payments', 'Closing'],
      rows: [...rows.map((r: any) => [`${r.code} ${r.name}`, n2(r.opening), n2(r.receipts), n2(r.payments), n2(cl(r))]),
        ['Total', n2(sum(rows.map((r: any) => r.opening))), n2(sum(rows.map((r: any) => r.receipts))), n2(sum(rows.map((r: any) => r.payments))), n2(sum(rows.map(cl)))]],
      links: [...rows.map((r: any) => `/accounts?open=${r.id}`), null], kinds: [...rows.map(() => ''), 'total'] };
    if (isCurrent(to)) { const cur = await t.one<{ v: number }>(`SELECT COALESCE(SUM(${BALANCE_SQL}),0) v FROM accounts a WHERE a.agency_id = ? AND a.type_code = 110`, [t.agencyId]); out.reconcile = [rec('Closing cash & bank vs current ledger balances', sum(rows.map(cl)), cur!.v)]; }
    return out;
  },
  'payment-register': async (t, from, to, o) => {
    const cl = await clientFilter(t, o);
    const ps = await t.query(`SELECT p.paid_at, p.direction, p.method, COALESCE(c.name, ic.name, s.name, '') party, p.reference, p.currency, p.amount, p.amount * p.fx_rate base
      FROM payments p LEFT JOIN clients c ON c.id = p.client_id AND c.agency_id = p.agency_id LEFT JOIN suppliers s ON s.id = p.supplier_id AND s.agency_id = p.agency_id
      LEFT JOIN invoices i ON i.id = p.invoice_id AND i.agency_id = p.agency_id LEFT JOIN clients ic ON ic.id = i.client_id AND ic.agency_id = p.agency_id
      WHERE p.agency_id = ? AND p.voided = 0 AND p.paid_at BETWEEN ? AND ? ${cl ? 'AND COALESCE(p.client_id, i.client_id) = ?' : ''} ORDER BY p.paid_at, p.id`, [t.agencyId, from, to, ...(cl ? [cl.id] : [])]);
    const inb = sum(ps.filter((p: any) => p.direction === 'inbound').map((p: any) => p.base)), out = sum(ps.filter((p: any) => p.direction === 'outbound').map((p: any) => p.base));
    const shown = ps.slice(0, LIMIT), blank = ['', '', '', '', '', ''];
    return { title: `Payment Register ${from} → ${to}${forClient(cl)}`, columns: ['Date', 'Direction', 'Method', 'Party', 'Reference', 'Currency', 'Amount', 'Amount (base)'],
      rows: [...shown.map((p: any) => [p.paid_at, p.direction, p.method.replace(/_/g, ' '), p.party, p.reference ?? '', p.currency, n2(p.amount), n2(p.base)]),
        ['Total received', ...blank, n2(inb)], ['Total paid', ...blank, n2(out)], ['Net', ...blank, n2(inb - out)]],
      kinds: [...shown.map(() => ''), 'total', 'total', 'total'], note: ps.length > LIMIT ? `Showing the first ${LIMIT} of ${ps.length} payments; totals cover all of them.` : undefined };
  },
  'sales-by-client': async (t, from, to) => {
    const sales = await t.query(`SELECT i.client_id id, COUNT(*) n, SUM(i.subtotal*i.fx_rate) sales, SUM(COALESCE(l.cost,0)*i.fx_rate) cost
      FROM invoices i LEFT JOIN (SELECT agency_id, invoice_id, SUM(unit_cost*quantity) cost FROM invoice_lines WHERE agency_id = ? GROUP BY agency_id, invoice_id) l ON l.invoice_id = i.id AND l.agency_id = i.agency_id
      WHERE i.agency_id = ? AND i.status NOT IN ('draft','void') AND i.issue_date BETWEEN ? AND ? GROUP BY i.client_id`, [t.agencyId, t.agencyId, from, to]);
    const recd = await t.query(`SELECT COALESCE(p.client_id, i.client_id) id, SUM(p.amount*p.fx_rate) amt FROM payments p LEFT JOIN invoices i ON i.id = p.invoice_id AND i.agency_id = p.agency_id
      WHERE p.agency_id = ? AND p.voided = 0 AND p.direction = 'inbound' AND p.paid_at BETWEEN ? AND ? GROUP BY COALESCE(p.client_id, i.client_id)`, [t.agencyId, from, to]);
    const open = await t.query(`SELECT client_id id, SUM((total-amount_credited-amount_paid)*fx_rate) amt FROM invoices WHERE agency_id = ? AND status IN ('sent','partially_paid','overdue') GROUP BY client_id`, [t.agencyId]);
    const names = new Map<number, string>((await t.query(`SELECT id, name FROM clients WHERE agency_id = ?`, [t.agencyId])).map((c: any) => [c.id, c.name]));
    const m = new Map<number, { n: number; sales: number; cost: number; recd: number; open: number }>();
    const row = (id: number) => { let r = m.get(id); if (!r) m.set(id, (r = { n: 0, sales: 0, cost: 0, recd: 0, open: 0 })); return r; };
    for (const r of sales) Object.assign(row(r.id), { n: r.n, sales: r.sales, cost: r.cost });
    for (const r of recd) if (r.id) row(r.id).recd = r.amt;
    for (const r of open) row(r.id).open = r.amt;
    const list = [...m.entries()].map(([id, r]) => ({ id, name: names.get(id) ?? `Client #${id}`, ...r })).sort((a, b) => b.sales - a.sales || b.open - a.open || a.name.localeCompare(b.name));
    const shown = list.slice(0, LIMIT);
    const tot = (f: (r: any) => number) => sum(list.map(f));
    const margin = (s: number, c: number) => (s ? n2(((s - c) / s) * 100) : '');
    const T = { n: list.reduce((s, r) => s + r.n, 0), sales: tot((r) => r.sales), cost: tot((r) => r.cost), recd: tot((r) => r.recd), open: tot((r) => r.open) };
    return { title: `Sales by Client ${from} → ${to}`, columns: ['Client', 'Invoices', 'Sales (ex-tax)', 'Cost of sales', 'Profit', 'Margin %', 'Received', 'Outstanding'],
      rows: [...shown.map((r) => [r.name, r.n, n2(r.sales), n2(r.cost), n2(r.sales - r.cost), margin(r.sales, r.cost), n2(r.recd), n2(r.open)]),
        ['Total', T.n, n2(T.sales), n2(T.cost), n2(T.sales - T.cost), margin(T.sales, T.cost), n2(T.recd), n2(T.open)]],
      links: [...shown.map((r) => `/reports?report=client-statement&client=${r.id}`), null], kinds: [...shown.map(() => ''), 'total'],
      note: `Sales, cost and profit are for invoices issued in the period (draft and void excluded). Received is money recorded in the period; Outstanding is what clients still owe as at today. Click a client for their statement.${list.length > LIMIT ? ` Showing the first ${LIMIT} of ${list.length} clients; the total covers all of them.` : ''}` };
  },
  'client-statement': async (t, from, to, o) => {
    const cl = await clientFilter(t, o); if (!cl) throw new HttpError(400, 'Choose a client for the statement');
    const full = await t.get('clients', cl.id);
    if (!full?.account_id) throw new HttpError(409, 'This client has no ledger account yet — post an invoice or receipt for them first');
    const r = await GENERATORS['general-ledger'](t, from, to, { account_id: String(full.account_id) });
    return { ...r, title: `Client Statement — ${cl.name}, ${from} → ${to}`, note: 'Everything posted to this client’s ledger account. Balance: positive = the client owes you, negative = you owe the client (for example an unallocated receipt).' };
  },
  'departures': async (t, from, to, o) => {
    const cl = await clientFilter(t, o);
    const rows = await t.query(`SELECT b.reference, b.destination, b.travel_start, b.travel_end, b.status, c.name client,
      (SELECT COUNT(*) FROM itinerary_items x WHERE x.agency_id = b.agency_id AND x.booking_id = b.id) legs,
      COALESCE((SELECT SUM((i.total-i.amount_credited-i.amount_paid)*i.fx_rate) FROM invoices i WHERE i.agency_id = b.agency_id AND i.booking_id = b.id AND i.status IN ('sent','partially_paid','overdue')),0) due
      FROM bookings b JOIN clients c ON c.id = b.client_id AND c.agency_id = b.agency_id WHERE b.agency_id = ? AND b.status NOT IN ('cancelled','lost','enquiry','quoted') AND b.travel_start BETWEEN ? AND ? ${cl ? 'AND b.client_id = ?' : ''} ORDER BY b.travel_start`, [t.agencyId, from, to, ...(cl ? [cl.id] : [])]);
    return { title: `Departures ${from} → ${to}${forClient(cl)}`, columns: ['Booking', 'Destination', 'Client', 'Departs', 'Returns', 'Status', 'Itinerary items', 'Balance due'], rows: rows.map((r: any) => [r.reference, r.destination ?? '', r.client, r.travel_start, r.travel_end ?? '', r.status, r.legs, n2(r.due)]) };
  },
};

/** Each reconciler ties a report's total back to the ledger or to its source records and says so out loud. */
const RECONCILERS: Record<string, (t: Tenant, r: Report, from: string, to: string) => Promise<Reconcile[]>> = {
  'ar-aging-summary': async (t, r, _f, to) => arRec(t, r, to, 5),
  'ar-aging-detail': async (t, r, _f, to) => arRec(t, r, to, 6),
  'sales-by-client': async (t, r, _f, to) => arRec(t, { ...r, rows: r.rows.slice(0, -1) }, to, 7),
  'ap-aging': async (t, r, _f, to) => {
    if (!isCurrent(to)) return [];
    const gl = await t.one(`SELECT COALESCE(SUM(${BALANCE_SQL}),0) v FROM accounts a JOIN suppliers s ON s.account_id = a.id AND s.agency_id = a.agency_id WHERE a.agency_id = ?`, [t.agencyId]);
    return [rec('Payables aging total vs ledger supplier accounts', r.rows.reduce((s, x) => s + Number(x[6]), 0), -gl!.v)];
  },
  'gl-pnl': async (t, r, from, to) => {
    const bal = await t.one(`SELECT COALESCE(SUM(g.debit),0) d, COALESCE(SUM(g.credit),0) c FROM gl_entries g JOIN vouchers v ON v.id = g.voucher_id AND v.agency_id = g.agency_id WHERE g.agency_id = ? AND v.voucher_date BETWEEN ? AND ?`, [t.agencyId, from, to]);
    return [rec('Ledger debits vs credits for the period (must balance)', bal!.d, bal!.c)];
  },
};
async function arRec(t: Tenant, r: Report, to: string, col: number): Promise<Reconcile[]> {
  if (!isCurrent(to)) return [];
  const gl = await t.one(`SELECT COALESCE(SUM(${BALANCE_SQL}),0) v FROM accounts a JOIN clients c ON c.account_id = a.id AND c.agency_id = a.agency_id WHERE a.agency_id = ?`, [t.agencyId]);
  const un = await t.one(`SELECT COALESCE(SUM(unallocated * fx_rate),0) v FROM receipts WHERE agency_id = ? AND status = 'posted'`, [t.agencyId]);
  return [rec('Receivables aging total vs ledger client accounts (plus unallocated receipts)', r.rows.reduce((s, x) => s + Number(x[col]), 0), gl!.v + un!.v)];
}

/** Build a report plus its reconciliation. Shared by the API and the scheduler so both always agree. */
export async function buildReport(t: Tenant, name: string, from: string, to: string, opts?: Record<string, string>): Promise<Report> {
  const gen = GENERATORS[name]; if (!gen) throw new HttpError(404, 'Unknown report');
  const report = await gen(t, from, to, opts);
  const own = report.note;
  report.note = `${own ? own + ' ' : ''}Amounts are in ${(await t.agency()).base_currency}, converted at the exchange rate locked on each document when it was issued or paid (document currencies are shown where relevant).`;
  const checks = opts?.client_id && name !== 'client-statement' ? undefined : await RECONCILERS[name]?.(t, report, from, to);   // a one-client view cannot tie to the whole-ledger total
  if (checks?.length) report.reconcile = checks; else if (name.includes('aging') && !opts?.client_id && !isCurrent(to)) report.note += ` ${ASOF}`;
  return report;
}

reportsRouter.get('/:name', (req, res, next) => (LEDGER_REPORTS.has(req.params.name as string) ? requireRole('admin', 'finance_manager', 'viewer')(req, res, next) : next()), async (req, res) => {
  const t = T(req);
  const y = new Date().getUTCFullYear();
  const from = String(req.query.from ?? `${y}-01-01`), to = String(req.query.to ?? new Date().toISOString().slice(0, 10));
  const opts = Object.fromEntries(Object.entries(req.query).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
  const report = await buildReport(t, req.params.name as string, from, to, opts);
  const format = String(req.query.format ?? 'json');
  if (format === 'json') return void res.json(report);

  // Exports are written to R2 and returned as a short-lived signed URL (never served publicly).
  let buf: Buffer, ext: string, mime: string;
  if (format === 'xlsx') {
    const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet(report.title.slice(0, 31));
    ws.addRow(report.columns).font = { bold: true };
    report.rows.forEach((r) => ws.addRow(r.map((v) => (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v))));
    ws.columns.forEach((c) => (c.width = 20));
    buf = Buffer.from(await wb.xlsx.writeBuffer()); ext = 'xlsx'; mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  } else if (format === 'pdf') {
    buf = await htmlToPdf(tableHtml(`${report.title}`, report.columns, report.rows, { agency: await t.agency(), logo: await agencyLogoData(await t.agency()) }).replace('</body>', `<p style="color:#6b7686;font-size:10px;margin-top:14px">${(report as any).note}</p></body>`)); ext = 'pdf'; mime = 'application/pdf';
  } else throw new HttpError(400, 'format must be json, xlsx or pdf');
  const key = await putFile(fileKey(t.agencyId, 'reports', `${req.params.name}.${ext}`), buf, mime);
  res.json({ url: await signedUrl(t.agencyId, key, `${req.params.name}.${ext}`) });
});
