import { Router } from 'express';
import ExcelJS from 'exceljs';
import { HttpError } from '../auth.js';
import { fileKey, putFile, signedUrl } from '../storage.js';
import { htmlToPdf, tableHtml } from '../services/pdf.js';
import { T } from './util.js';
import { Tenant } from '../db.js';
import { BALANCE_SQL } from '../services/accounting.js';

export const reportsRouter = Router();

export interface Reconcile { label: string; report: number; source: number; difference: number; ok: boolean }
export interface Report { title: string; columns: string[]; rows: any[][]; reconcile?: Reconcile[]; note?: string }
const rec = (label: string, report: number, source: number): Reconcile => { const difference = Math.round((report - source) * 100) / 100; return { label, report: Math.round(report * 100) / 100, source: Math.round(source * 100) / 100, difference, ok: Math.abs(difference) <= 0.05 }; };
const isCurrent = (to: string) => to >= new Date().toISOString().slice(0, 10);
const ASOF = 'Aging uses current balances, so it is reconciled to the ledger only when the report date is today or later.';
export type Gen = (t: Tenant, from: string, to: string) => Promise<Report>;
const n2 = (v: any) => Number(v ?? 0).toFixed(2);

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
    const rows = await t.query(`SELECT DATE_FORMAT(paid_at,'%Y-%m') m, SUM(CASE WHEN direction='inbound' THEN amount*fx_rate ELSE 0 END) inflow, SUM(CASE WHEN direction='outbound' THEN amount*fx_rate ELSE 0 END) outflow FROM payments WHERE agency_id = ? AND paid_at BETWEEN ? AND ? GROUP BY m ORDER BY m`, [t.agencyId, from, to]);
    let run = 0;
    return { title: `Cash Flow ${from} → ${to}`, columns: ['Month', 'Inflow', 'Outflow', 'Net', 'Cumulative'],
      rows: rows.map((r: any) => { run += r.inflow - r.outflow; return [r.m, n2(r.inflow), n2(r.outflow), n2(r.inflow - r.outflow), n2(run)]; }) };
  },
  'ar-aging-summary': async (t, _f, to) => {
    const rows = await t.query(`SELECT c.name, SUM(CASE WHEN DATEDIFF(?,i.due_date)<=0 THEN b ELSE 0 END) current_,
      SUM(CASE WHEN DATEDIFF(?,i.due_date) BETWEEN 1 AND 30 THEN b ELSE 0 END) d30, SUM(CASE WHEN DATEDIFF(?,i.due_date) BETWEEN 31 AND 60 THEN b ELSE 0 END) d60,
      SUM(CASE WHEN DATEDIFF(?,i.due_date)>60 THEN b ELSE 0 END) d90, SUM(b) total
      FROM (SELECT *, (total-amount_credited-amount_paid)*fx_rate b FROM invoices) i JOIN clients c ON c.id=i.client_id AND c.agency_id=i.agency_id
      WHERE i.agency_id = ? AND i.status IN ('sent','partially_paid','overdue') GROUP BY c.id, c.name ORDER BY total DESC`, [to, to, to, to, t.agencyId]);
    return { title: `AR Aging Summary as at ${to}`, columns: ['Client', 'Current', '1-30', '31-60', '60+', 'Total'],
      rows: rows.map((r: any) => [r.name, n2(r.current_), n2(r.d30), n2(r.d60), n2(r.d90), n2(r.total)]) };
  },
  'ar-aging-detail': async (t, _f, to) => {
    const rows = await t.query(`SELECT i.number, c.name, i.due_date, i.currency, i.total, i.amount_paid, i.amount_credited, DATEDIFF(?, i.due_date) days FROM invoices i JOIN clients c ON c.id=i.client_id AND c.agency_id=i.agency_id WHERE i.agency_id = ? AND i.status IN ('sent','partially_paid','overdue') ORDER BY days DESC`, [to, t.agencyId]);
    return { title: `AR Aging Detail as at ${to}`, columns: ['Invoice', 'Client', 'Due', 'Currency', 'Total', 'Paid', 'Balance', 'Days overdue'],
      rows: rows.map((r: any) => [r.number, r.name, r.due_date, r.currency, n2(r.total), n2(r.amount_paid + r.amount_credited), n2(r.total - r.amount_credited - r.amount_paid), Math.max(0, r.days)]) };
  },
  'commission-summary': async (t, from, to) => {
    const rows = await t.query(`SELECT COALESCE(u.name,'Unassigned') agent, COUNT(*) n, SUM(c.selling_price) sell, SUM(c.supplier_cost) cost, SUM(c.overhead) oh, SUM(c.net_commission) net, SUM(c.agent_amount) pay FROM commissions c LEFT JOIN users u ON u.id=c.agent_id WHERE c.agency_id = ? AND c.period BETWEEN ? AND ? GROUP BY u.id, u.name`, [t.agencyId, from.slice(0, 7), to.slice(0, 7)]);
    return { title: `Commission Summary ${from} → ${to}`, columns: ['Agent', 'Bookings', 'Selling', 'Cost', 'Overhead', 'Net commission', 'Agent payable'],
      rows: rows.map((r: any) => [r.agent, r.n, n2(r.sell), n2(r.cost), n2(r.oh), n2(r.net), n2(r.pay)]) };
  },
  'revenue-by-destination': async (t, from, to) => {
    const rows = await t.query(`SELECT COALESCE(b.destination,'Unspecified') d, COUNT(DISTINCT b.id) n, SUM(i.subtotal*i.fx_rate) rev FROM invoices i LEFT JOIN bookings b ON b.id=i.booking_id AND b.agency_id=i.agency_id WHERE i.agency_id = ? AND i.status NOT IN ('draft','void') AND i.issue_date BETWEEN ? AND ? GROUP BY d ORDER BY rev DESC`, [t.agencyId, from, to]);
    return { title: `Booking Revenue by Destination ${from} → ${to}`, columns: ['Destination', 'Bookings', 'Revenue'], rows: rows.map((r: any) => [r.d, r.n, n2(r.rev)]) };
  },
  'supplier-payments': async (t, from, to) => {
    const rows = await t.query(`SELECT s.name, COUNT(*) n, SUM(p.amount*p.fx_rate) amt FROM payments p JOIN suppliers s ON s.id=p.supplier_id AND s.agency_id=p.agency_id WHERE p.agency_id = ? AND p.direction='outbound' AND p.paid_at BETWEEN ? AND ? GROUP BY s.id, s.name ORDER BY amt DESC`, [t.agencyId, from, to]);
    return { title: `Supplier Payment Summary ${from} → ${to}`, columns: ['Supplier', 'Payments', 'Total paid'], rows: rows.map((r: any) => [r.name, r.n, n2(r.amt)]) };
  },
  'invoice-register': async (t, from, to) => {
    const rows = await t.query(`SELECT i.number, c.name, i.issue_date, i.due_date, i.status, i.currency, i.total, i.amount_paid FROM invoices i JOIN clients c ON c.id=i.client_id AND c.agency_id=i.agency_id WHERE i.agency_id = ? AND i.issue_date BETWEEN ? AND ? ORDER BY i.number`, [t.agencyId, from, to]);
    return { title: `Invoice Register ${from} → ${to}`, columns: ['Number', 'Client', 'Issued', 'Due', 'Status', 'Currency', 'Total', 'Paid'],
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
  'departures': async (t, from, to) => {
    const rows = await t.query(`SELECT b.reference, b.destination, b.travel_start, b.travel_end, b.status, c.name client,
      (SELECT COUNT(*) FROM itinerary_items x WHERE x.agency_id = b.agency_id AND x.booking_id = b.id) legs,
      COALESCE((SELECT SUM((i.total-i.amount_credited-i.amount_paid)*i.fx_rate) FROM invoices i WHERE i.agency_id = b.agency_id AND i.booking_id = b.id AND i.status IN ('sent','partially_paid','overdue')),0) due
      FROM bookings b JOIN clients c ON c.id = b.client_id AND c.agency_id = b.agency_id WHERE b.agency_id = ? AND b.status NOT IN ('cancelled','lost','enquiry','quoted') AND b.travel_start BETWEEN ? AND ? ORDER BY b.travel_start`, [t.agencyId, from, to]);
    return { title: `Departures ${from} → ${to}`, columns: ['Booking', 'Destination', 'Client', 'Departs', 'Returns', 'Status', 'Itinerary items', 'Balance due'], rows: rows.map((r: any) => [r.reference, r.destination ?? '', r.client, r.travel_start, r.travel_end ?? '', r.status, r.legs, n2(r.due)]) };
  },
};

/** Each reconciler ties a report's total back to the ledger or to its source records and says so out loud. */
const RECONCILERS: Record<string, (t: Tenant, r: Report, from: string, to: string) => Promise<Reconcile[]>> = {
  'ar-aging-summary': async (t, r, _f, to) => arRec(t, r, to, 5),
  'ar-aging-detail': async (t, r, _f, to) => arRec(t, r, to, 6),
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
export async function buildReport(t: Tenant, name: string, from: string, to: string): Promise<Report> {
  const gen = GENERATORS[name]; if (!gen) throw new HttpError(404, 'Unknown report');
  const report = await gen(t, from, to);
  report.note = `Amounts are in ${(await t.agency()).base_currency}, converted at the exchange rate locked on each document when it was issued or paid (document currencies are shown where relevant).`;
  const checks = await RECONCILERS[name]?.(t, report, from, to);
  if (checks?.length) report.reconcile = checks; else if (name.includes('aging') && !isCurrent(to)) report.note += ` ${ASOF}`;
  return report;
}

reportsRouter.get('/:name', async (req, res) => {
  const t = T(req);
  const y = new Date().getUTCFullYear();
  const from = String(req.query.from ?? `${y}-01-01`), to = String(req.query.to ?? new Date().toISOString().slice(0, 10));
  const report = await buildReport(t, req.params.name as string, from, to);
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
    buf = await htmlToPdf(tableHtml(`${report.title}`, report.columns, report.rows) .replace('</body>', `<p style="color:#6b7686;font-size:10px;margin-top:14px">${(report as any).note}</p></body>`)); ext = 'pdf'; mime = 'application/pdf';
  } else throw new HttpError(400, 'format must be json, xlsx or pdf');
  const key = await putFile(fileKey(t.agencyId, 'reports', `${req.params.name}.${ext}`), buf, mime);
  res.json({ url: await signedUrl(t.agencyId, key, `${req.params.name}.${ext}`) });
});
