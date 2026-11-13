import { Router } from 'express';
import { HttpError, requireRole } from '../auth.js';
import { fileKey, putFile, signedUrl } from '../storage.js';
import { htmlToPdf } from '../services/pdf.js';
import { T } from './util.js';
import { Tenant } from '../db.js';
import { BALANCE_SQL, HIDE_VOIDED_PAIRS } from '../services/accounting.js';
import { agencyLogoData } from '../services/vouchers.js';
import { addDays, today } from '../services/money.js';
import { CATALOG, PARAM_REPORTS as PARAMS } from '../services/reportCatalog.js';
import { Chart, Reconcile, Report, Summary, colKinds, isWide, reportCsv, reportHtml, reportXlsx } from '../services/reportFiles.js';
import { BUCKETS, OpenItem, bucketOf, byParty, daysLate, isCurrent, payables, payablesLedger, receivables, receivablesLedger } from '../services/receivables.js';

export type { Reconcile, Report };
export const reportsRouter = Router();
/** Every report shows the agency's finances, so they are for finance roles only (the menu already hides them from agents). */
reportsRouter.use(requireRole('admin', 'finance_manager', 'viewer'));

const rec = (label: string, report: number, source: number): Reconcile => { const difference = Math.round((report - source) * 100) / 100; return { label, report: Math.round(report * 100) / 100, source: Math.round(source * 100) / 100, difference, ok: Math.abs(difference) <= 0.05 }; };
const ASOF = 'Aging for a past date is rebuilt from the documents and payments dated on or before it. It is not compared with the ledger, and receipts that are not tied to an invoice are not counted.';
export type Gen = (t: Tenant, from: string, to: string, opts?: Record<string, string>) => Promise<Report>;
/** Reports that need an extra parameter and so cannot be scheduled. */
export const PARAM_REPORTS = PARAMS;
const ISSUED = `('sent','partially_paid','overdue','paid','credited')`;   // invoices that have been issued to the client
const n2 = (v: any) => Number(v ?? 0).toFixed(2);
const num = (v: any) => Number(v) || 0;
const sum = (xs: number[]) => Math.round(xs.reduce((s, x) => s + x, 0) * 100) / 100;
/** An amount for a sentence: thousands separators and two decimals. */
const money2 = (v: any) => Number(v ?? 0).toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (a: number, b: number) => (b ? n2((a / b) * 100) : '');
const LIMIT = 3000, EXPORT_LIMIT = 50000;
/** The screen shows the first rows; a download carries all of them. */
const cap = (o?: Record<string, string>) => (o?.export === '1' ? EXPORT_LIMIT : LIMIT);
/** A row of totals: the label in the first column, the amounts where given. */
const totalOf = (width: number, label: string, at: Record<number, any>) => { const r: any[] = Array(width).fill(''); r[0] = label; for (const [i, v] of Object.entries(at)) r[Number(i)] = v; return r; };
const dataRows = (r: Report) => r.rows.filter((_, i) => !['total', 'section'].includes(r.kinds?.[i] ?? ''));

/** Optional "just this client" filter shared by the client-aware reports. */
async function clientFilter(t: Tenant, o?: Record<string, string>): Promise<{ id: number; name: string } | null> {
  if (!o?.client_id) return null;
  const id = Number(o.client_id); if (!id) throw new HttpError(400, 'Invalid client');
  const c = await t.get('clients', id); if (!c) throw new HttpError(404, 'Client not found');
  return c;
}
const forClient = (c: { name: string } | null) => (c ? ` — ${c.name}` : '');
const clientRoute = (clientId: number | null, accountId: number | null) => (clientId ? `/reports?report=client-statement&client=${clientId}` : accountId ? `/accounts?open=${accountId}` : null);

const BAL_AT = `(a.opening_dr - a.opening_cr + COALESCE((SELECT SUM(g.debit - g.credit) FROM gl_entries g WHERE g.agency_id = a.agency_id AND g.account_id = a.id AND g.entry_date <= ?),0))`;
const VOUCHER_PAGE: Record<string, string> = { invoices: '/invoices', receipts: '/client-receipts', supplier_bills: '/supplier-bills', credit_notes: '/credit-notes', ticket_invoices: '/ticket-invoices',
  payment_runs: '/payment-runs', commission_periods: '/commissions', client_refunds: '/credit-notes', refunds: '/refunds', bank_transactions: '/reconciliation' };
/** Where the document behind a ledger voucher lives in the app. */
const voucherLink = (v: any): string | null =>
  v.ref_table === 'cash_vouchers' ? (v.voucher_type === 'receipt' ? '/receipts' : '/payment-vouchers')
    : v.voucher_type === 'journal' && !v.ref_table ? `/journal?view=${v.vid}` : VOUCHER_PAGE[v.ref_table] ?? null;

const lengthDays = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 864e5) + 1;
const shiftYear = (d: string, k: number) => { const [y, m, dd] = d.split('-').map(Number); return new Date(Date.UTC(y + k, m - 1, dd)).toISOString().slice(0, 10); };

/* ------------------------------------------------------------------ shared figures */
/** What was sold in a period, on the sales basis (issued invoices, issued credit notes, confirmed ticket invoices). All in base currency. */
export async function sales(t: Tenant, from: string, to: string) {
  const [inv] = await t.query(`SELECT COALESCE(SUM(i.subtotal * i.fx_rate),0) v FROM invoices i WHERE i.agency_id = ? AND i.status IN ${ISSUED} AND i.issue_date BETWEEN ? AND ?`, [t.agencyId, from, to]);
  const [cos] = await t.query(`SELECT COALESCE(SUM(l.unit_cost * l.quantity * i.fx_rate),0) v FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id AND i.agency_id = l.agency_id
    WHERE l.agency_id = ? AND i.status IN ${ISSUED} AND i.issue_date BETWEEN ? AND ?`, [t.agencyId, from, to]);
  const [cn] = await t.query(`SELECT COALESCE(SUM(subtotal * fx_rate),0) v FROM credit_notes WHERE agency_id = ? AND status = 'issued' AND issue_date BETWEEN ? AND ?`, [t.agencyId, from, to]);
  const [tk] = await t.query(`SELECT COALESCE(SUM(l.receivable),0) revenue, COALESCE(SUM(l.receivable - l.profit),0) cost FROM ticket_lines l JOIN ticket_invoices i ON i.id = l.invoice_id AND i.agency_id = l.agency_id
    WHERE l.agency_id = ? AND i.status = 'confirmed' AND i.invoice_date BETWEEN ? AND ?`, [t.agencyId, from, to]);
  return { invoices: num(inv.v), credits: num(cn.v), cost: num(cos.v), tickets: num(tk.revenue), ticketCost: num(tk.cost) };
}
/** Money received and paid in a period: recorded payments plus the cash and bank vouchers (cleared ones only). */
async function cashMoves(t: Tenant, from: string, to: string) {
  const [p] = await t.query(`SELECT COALESCE(SUM(CASE WHEN direction='inbound' THEN amount*fx_rate ELSE 0 END),0) i, COALESCE(SUM(CASE WHEN direction='outbound' THEN amount*fx_rate ELSE 0 END),0) o FROM payments WHERE agency_id = ? AND voided = 0 AND paid_at BETWEEN ? AND ?`, [t.agencyId, from, to]);
  const [v] = await t.query(`SELECT COALESCE(SUM(CASE WHEN kind='receipt' THEN amount ELSE 0 END),0) i, COALESCE(SUM(CASE WHEN kind='payment' THEN amount ELSE 0 END),0) o FROM cash_vouchers WHERE agency_id = ? AND cleared = 1 AND COALESCE(cleared_date, voucher_date) BETWEEN ? AND ?`, [t.agencyId, from, to]);
  return { in: num(p.i) + num(v.i), out: num(p.o) + num(v.o) };
}

interface PnlRow { id: number; code: string; name: string; type: number; net: number }
async function ledgerPnl(t: Tenant, from: string, to: string): Promise<PnlRow[]> {
  const rows = await t.query(`SELECT a.id, a.code, a.name, a.type_code type, COALESCE(SUM(g.credit - g.debit),0) net FROM accounts a JOIN gl_entries g ON g.account_id = a.id AND g.agency_id = a.agency_id
    JOIN vouchers v ON v.id = g.voucher_id AND v.agency_id = g.agency_id WHERE a.agency_id = ? AND a.type_code BETWEEN 300 AND 499 AND v.voucher_date BETWEEN ? AND ? GROUP BY a.id, a.code, a.name, a.type_code ORDER BY a.code`, [t.agencyId, from, to]);
  return rows.map((r: any) => ({ id: r.id, code: String(r.code), name: r.name, type: Number(r.type), net: num(r.net) }));
}

const agingChart = (items: OpenItem[], asAt: string, name = 'Outstanding'): Chart => {
  const b = [0, 0, 0, 0]; for (const it of items) b[bucketOf(daysLate(asAt, it.due))] += it.balance;
  return { kind: 'bars', labels: BUCKETS, series: [{ name, values: b.map((x) => Math.round(x * 100) / 100), tone: 'accent' }] };
};
const agingSummary = (items: OpenItem[], asAt: string, word: string): Summary[] => {
  const tot = sum(items.map((i) => i.balance)), over = sum(items.filter((i) => daysLate(asAt, i.due) > 0).map((i) => i.balance)), old = sum(items.filter((i) => daysLate(asAt, i.due) > 60).map((i) => i.balance));
  return [{ label: word, value: n2(tot) }, { label: 'Overdue', value: n2(over), tone: over > 0 ? 'warn' : undefined }, { label: 'Over 60 days late', value: n2(old), tone: old > 0 ? 'bad' : undefined }];
};

// All amounts are converted to agency base currency using the invoice/payment fx_rate.
export const GENERATORS: Record<string, Gen> = {
  /* ---------------------------------------------------------------- financial statements */
  'pnl': async (t, from, to) => {
    const s = await sales(t, from, to);
    const exp = await t.query(`SELECT category, SUM(amount*fx_rate) amt FROM expenses WHERE agency_id = ? AND incurred_on BETWEEN ? AND ? GROUP BY category ORDER BY amt DESC`, [t.agencyId, from, to]);
    const expTotal = sum(exp.map((e: any) => num(e.amt))), revenue = s.invoices - s.credits + s.tickets, cost = s.cost + s.ticketCost, gross = revenue - cost, net = gross - expTotal;
    const rows: any[][] = [], kinds: string[] = [];
    const add = (label: string, v: number, kind = '') => { rows.push([label, n2(v)]); kinds.push(kind); };
    add('Revenue — invoices (ex-tax)', s.invoices);
    if (s.credits) add('Less: credit notes', -s.credits);
    if (s.tickets) add('Revenue — airline tickets', s.tickets);
    add('Total revenue', revenue, 'total');
    add('Cost of sales — suppliers', s.cost);
    if (s.ticketCost) add('Cost of sales — airline tickets and commissions', s.ticketCost);
    add('Gross profit', gross, 'total');
    exp.forEach((e: any) => add(`Expense: ${e.category}`, num(e.amt)));
    add('Total expenses', expTotal, 'total');
    add('Net profit', net, 'total');
    return { title: `Profit & Loss (sales basis) ${from} → ${to}`, columns: ['Line', 'Amount'], rows, kinds, types: ['text', 'money'],
      summary: [{ label: 'Revenue', value: n2(revenue) }, { label: 'Gross profit', value: n2(gross) }, { label: 'Net profit', value: n2(net), tone: net < 0 ? 'bad' : 'good' }, { label: 'Gross margin', value: pct(gross, revenue), unit: '%' }],
      note: 'Revenue counts issued invoices (ex-tax, less credit notes) and confirmed ticket invoices at what the client pays; costs are the supplier costs on those invoices and what the tickets cost you.' };
  },
  'gl-pnl': async (t, from, to, o) => {
    const mode = o?.compare === 'prev' || o?.compare === 'year' ? o.compare : '';
    const [pf, pt] = mode === 'prev' ? [addDays(from, -lengthDays(from, to)), addDays(from, -1)] : mode === 'year' ? [shiftYear(from, -1), shiftYear(to, -1)] : ['', ''];
    const cur = await ledgerPnl(t, from, to), prev = mode ? await ledgerPnl(t, pf, pt) : [];
    const curNet = new Map(cur.map((r) => [r.id, r.net])), prevNet = new Map(prev.map((r) => [r.id, r.net]));
    const known = new Map<number, PnlRow>(); for (const r of [...cur, ...prev]) if (!known.has(r.id)) known.set(r.id, r);
    const pick = (pred: (r: PnlRow) => boolean) => [...known.values()].filter(pred).sort((a, b) => a.code.localeCompare(b.code));
    const income = pick((r) => r.type >= 400), costs = pick((r) => r.type >= 310 && r.type < 320), opex = pick((r) => r.type >= 320 && r.type < 400);
    const rows: any[][] = [], kinds: string[] = [], links: (string | null)[] = [];
    const push = (label: string, c: number | null, p: number | null, kind = '', link: string | null = null) => {
      const row: any[] = [label, c === null ? '' : n2(c)];
      if (mode) row.push(p === null ? '' : n2(p), c === null || p === null ? '' : n2(c - p), c === null || p === null || !p ? '' : n2(((c - p) / Math.abs(p)) * 100));
      rows.push(row); kinds.push(kind); links.push(link);
    };
    const block = (title: string, list: PnlRow[], isIncome: boolean, totalLabel: string) => {
      const sign = isIncome ? 1 : -1;
      push(title, null, null, 'section');
      for (const r of list) push(`${r.code} ${r.name}`, sign * (curNet.get(r.id) ?? 0), mode ? sign * (prevNet.get(r.id) ?? 0) : null, '', `/reports?report=general-ledger&account=${r.id}&from=${from}&to=${to}`);
      const c = sum(list.map((r) => sign * (curNet.get(r.id) ?? 0))), p = sum(list.map((r) => sign * (prevNet.get(r.id) ?? 0)));
      push(totalLabel, c, mode ? p : null, 'total'); return [c, p];
    };
    const [inc, incP] = block('INCOME', income, true, 'Total income');
    let cos = 0, cosP = 0; if (costs.length) { [cos, cosP] = block('COST OF REVENUE', costs, false, 'Total cost of revenue'); push('Gross profit', inc - cos, mode ? incP - cosP : null, 'total'); }
    let exp = 0, expP = 0; if (opex.length) [exp, expP] = block('EXPENSES', opex, false, 'Total expenses');
    const net = inc - cos - exp;
    push('Net profit', net, mode ? incP - cosP - expP : null, 'total');
    // a profit can look healthy simply because costs have not been posted yet — say so when the sales records disagree
    const hints: string[] = [], s = await sales(t, from, to);
    if (s.cost - cos > 1) hints.push(`Invoices in this period carry ${money2(s.cost)} of supplier cost, but the ledger shows only ${money2(cos)} of cost of revenue. If your suppliers have billed you, enter their bills so this profit is complete. The Sales-basis P&L counts the invoice costs.`);
    const [ex] = await t.query(`SELECT COALESCE(SUM(amount * fx_rate),0) v FROM expenses WHERE agency_id = ? AND incurred_on BETWEEN ? AND ?`, [t.agencyId, from, to]);
    if (num(ex.v) - exp > 1) hints.push(`The Expenses page has ${money2(ex.v)} recorded for this period, but the ledger shows only ${money2(exp)} of operating expenses, so some costs may not be in this profit yet.`);
    return { title: `Profit & Loss (ledger) ${from} → ${to}${mode ? ` vs ${pf} → ${pt}` : ''}`, columns: mode ? ['Account', 'This period', 'Previous period', 'Change', 'Change %'] : ['Account', 'Amount'], rows, links, kinds,
      types: mode ? ['text', 'money', 'money', 'money', 'money'] : ['text', 'money'], hints,
      summary: [{ label: 'Income', value: n2(inc) }, { label: 'Costs & expenses', value: n2(cos + exp) }, { label: 'Net profit', value: n2(net), tone: net < 0 ? 'bad' : 'good' }, ...(inc ? [{ label: 'Net margin', value: pct(net, inc), unit: '%' as const }] : [])] };
  },
  'trial-balance': async (t, _f, to) => {
    const rows = await t.query(`SELECT a.id, a.code, a.name, at.name type, ${BAL_AT} bal FROM accounts a JOIN account_types at ON at.code = a.type_code WHERE a.agency_id = ? ORDER BY a.code`, [to, t.agencyId]);
    const live = rows.filter((r: any) => Math.abs(r.bal) > 0.004), dr = (r: any) => (r.bal > 0 ? r.bal : 0), cr = (r: any) => (r.bal < 0 ? -r.bal : 0);
    const td = sum(live.map(dr)), tc = sum(live.map(cr));
    return { title: `Trial Balance as at ${to}`, columns: ['Code', 'Account', 'Type', 'Debit', 'Credit'],
      rows: [...live.map((r: any) => [r.code, r.name, r.type, n2(dr(r)), n2(cr(r))]), ['Total', '', '', n2(td), n2(tc)]],
      links: [...live.map((r: any) => `/accounts?open=${r.id}`), null], kinds: [...live.map(() => ''), 'total'], types: ['text', 'text', 'text', 'money', 'money'],
      summary: [{ label: 'Total debits', value: n2(td) }, { label: 'Total credits', value: n2(tc) }],
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
    return { title: `Balance Sheet as at ${to}`, columns: ['Account', 'Amount'], rows, links, kinds, types: ['text', 'money'],
      summary: [{ label: 'Assets', value: n2(assets) }, { label: 'Liabilities', value: n2(liab) }, { label: 'Equity', value: n2(equity) }],
      reconcile: [rec('Total assets vs total liabilities & equity (must be equal)', assets, liab + equity)] };
  },
  'cash-flow': async (t, from, to) => {
    const rows = await t.query(`SELECT m, SUM(inflow) inflow, SUM(outflow) outflow FROM (
        SELECT DATE_FORMAT(paid_at,'%Y-%m') m, SUM(CASE WHEN direction='inbound' THEN amount*fx_rate ELSE 0 END) inflow, SUM(CASE WHEN direction='outbound' THEN amount*fx_rate ELSE 0 END) outflow FROM payments WHERE agency_id = ? AND voided = 0 AND paid_at BETWEEN ? AND ? GROUP BY m
        UNION ALL
        SELECT DATE_FORMAT(COALESCE(cleared_date, voucher_date),'%Y-%m') m, SUM(CASE WHEN kind='receipt' THEN amount ELSE 0 END) inflow, SUM(CASE WHEN kind='payment' THEN amount ELSE 0 END) outflow FROM cash_vouchers
          WHERE agency_id = ? AND cleared = 1 AND COALESCE(cleared_date, voucher_date) BETWEEN ? AND ? GROUP BY m) x GROUP BY m ORDER BY m`, [t.agencyId, from, to, t.agencyId, from, to]);
    let run = 0; const inn = sum(rows.map((r: any) => num(r.inflow))), out = sum(rows.map((r: any) => num(r.outflow)));
    return { title: `Cash Flow ${from} → ${to}`, columns: ['Month', 'Inflow', 'Outflow', 'Net', 'Cumulative'], types: ['text', 'money', 'money', 'money', 'money'],
      rows: [...rows.map((r: any) => { run += num(r.inflow) - num(r.outflow); return [r.m, n2(r.inflow), n2(r.outflow), n2(num(r.inflow) - num(r.outflow)), n2(run)]; }), ['Total', n2(inn), n2(out), n2(inn - out), '']],
      kinds: [...rows.map(() => ''), 'total'],
      summary: [{ label: 'Money in', value: n2(inn), tone: 'good' }, { label: 'Money out', value: n2(out) }, { label: 'Net', value: n2(inn - out), tone: inn - out < 0 ? 'bad' : 'good' }],
      chart: { kind: 'bars', labels: rows.map((r: any) => r.m), series: [{ name: 'Money in', values: rows.map((r: any) => num(r.inflow)), tone: 'good' }, { name: 'Money out', values: rows.map((r: any) => num(r.outflow)), tone: 'bad' }] } };
  },
  'tax-summary': async (t, from, to) => {
    const label = (await t.agency()).tax_label || 'Tax';
    const rows = await t.query(`SELECT DATE_FORMAT(g.entry_date,'%Y-%m') m,
        COALESCE(SUM(CASE WHEN a.sys_key = 'tax_payable' THEN g.credit - g.debit ELSE 0 END),0) collected, COALESCE(SUM(CASE WHEN a.sys_key = 'tax_input' THEN g.debit - g.credit ELSE 0 END),0) paid
      FROM gl_entries g JOIN accounts a ON a.id = g.account_id AND a.agency_id = g.agency_id WHERE g.agency_id = ? AND g.entry_date BETWEEN ? AND ? AND a.sys_key IN ('tax_payable','tax_input') GROUP BY m ORDER BY m`, [t.agencyId, from, to]);
    const col = sum(rows.map((r: any) => num(r.collected))), paid = sum(rows.map((r: any) => num(r.paid)));
    return { title: `${label} Summary ${from} → ${to}`, columns: ['Month', `${label} collected on sales`, `${label} paid on purchases`, `Net ${label} to pay`], types: ['text', 'money', 'money', 'money'],
      rows: [...rows.map((r: any) => [r.m, n2(r.collected), n2(r.paid), n2(num(r.collected) - num(r.paid))]), ['Total', n2(col), n2(paid), n2(col - paid)]], kinds: [...rows.map(() => ''), 'total'],
      summary: [{ label: `${label} collected`, value: n2(col) }, { label: `${label} paid`, value: n2(paid) }, { label: 'Net to pay', value: n2(col - paid), tone: col - paid > 0 ? 'warn' : 'good' }],
      note: `Taken from the ledger's tax accounts, by posting date. Payments you make to the tax authority are not netted off here.` };
  },

  /* ------------------------------------------------------------------- sales & profit */
  'sales-by-client': async (t, from, to, o) => {
    const clients: any[] = await t.query('SELECT id, name, account_id FROM clients WHERE agency_id = ?', [t.agencyId]);
    const byId = new Map(clients.map((c) => [c.id, c])), byAcct = new Map(clients.filter((c) => c.account_id).map((c) => [c.account_id, c]));
    const accNames = new Map<number, string>((await t.query('SELECT id, name FROM accounts WHERE agency_id = ?', [t.agencyId])).map((a: any) => [a.id, a.name]));
    type Row = { key: string; name: string; clientId: number | null; accountId: number | null; n: number; sales: number; cost: number; recd: number; open: number };
    const m = new Map<string, Row>();
    const row = (accountId: number | null, clientId: number | null, name: string) => { const key = accountId ? `acct:${accountId}` : `client:${clientId}`; let r = m.get(key); if (!r) m.set(key, (r = { key, name, clientId, accountId, n: 0, sales: 0, cost: 0, recd: 0, open: 0 })); return r; };
    const ofClient = (id: number) => { const c = byId.get(id); return row(c?.account_id ?? null, id, c?.name ?? `Client #${id}`); };
    const ofAccount = (a: number) => { const c = byAcct.get(a); return row(a, c?.id ?? null, c?.name ?? accNames.get(a) ?? `Account #${a}`); };
    for (const r of await t.query(`SELECT i.client_id id, COUNT(*) n, SUM(i.subtotal*i.fx_rate) sales, SUM(COALESCE(l.cost,0)*i.fx_rate) cost
      FROM invoices i LEFT JOIN (SELECT agency_id, invoice_id, SUM(unit_cost*quantity) cost FROM invoice_lines WHERE agency_id = ? GROUP BY agency_id, invoice_id) l ON l.invoice_id = i.id AND l.agency_id = i.agency_id
      WHERE i.agency_id = ? AND i.status IN ${ISSUED} AND i.issue_date BETWEEN ? AND ? GROUP BY i.client_id`, [t.agencyId, t.agencyId, from, to])) { const x = ofClient(r.id); x.n += num(r.n); x.sales += num(r.sales); x.cost += num(r.cost); }
    for (const r of await t.query(`SELECT client_id id, SUM(subtotal*fx_rate) credits FROM credit_notes WHERE agency_id = ? AND status = 'issued' AND issue_date BETWEEN ? AND ? GROUP BY client_id`, [t.agencyId, from, to])) ofClient(r.id).sales -= num(r.credits);
    for (const r of await t.query(`SELECT i.client_account_id a, COUNT(DISTINCT i.id) n, SUM(l.receivable) sales, SUM(l.receivable - l.profit) cost FROM ticket_invoices i JOIN ticket_lines l ON l.invoice_id = i.id AND l.agency_id = i.agency_id
      WHERE i.agency_id = ? AND i.status = 'confirmed' AND i.invoice_date BETWEEN ? AND ? GROUP BY i.client_account_id`, [t.agencyId, from, to])) { const x = ofAccount(r.a); x.n += num(r.n); x.sales += num(r.sales); x.cost += num(r.cost); }
    for (const r of await t.query(`SELECT COALESCE(p.client_id, i.client_id) id, SUM(p.amount*p.fx_rate) amt FROM payments p LEFT JOIN invoices i ON i.id = p.invoice_id AND i.agency_id = p.agency_id
      WHERE p.agency_id = ? AND p.voided = 0 AND p.direction = 'inbound' AND p.paid_at BETWEEN ? AND ? GROUP BY COALESCE(p.client_id, i.client_id)`, [t.agencyId, from, to])) if (r.id) ofClient(r.id).recd += num(r.amt);
    for (const r of await t.query(`SELECT party_account_id a, SUM(amount) amt FROM cash_vouchers WHERE agency_id = ? AND kind = 'receipt' AND cleared = 1 AND COALESCE(cleared_date, voucher_date) BETWEEN ? AND ? GROUP BY party_account_id`, [t.agencyId, from, to])) if (byAcct.has(r.a) || m.has(`acct:${r.a}`)) ofAccount(r.a).recd += num(r.amt);
    for (const p of byParty(await receivables(t, today()), today())) { const x = row(p.accountId, p.clientId, p.name); x.open += p.total; }
    const list = [...m.values()].sort((a, b) => b.sales - a.sales || b.open - a.open || a.name.localeCompare(b.name)), shown = list.slice(0, cap(o));
    const tot = (f: (r: Row) => number) => sum(list.map(f)), T = { n: list.reduce((s, r) => s + r.n, 0), sales: tot((r) => r.sales), cost: tot((r) => r.cost), recd: tot((r) => r.recd), open: tot((r) => r.open) };
    const margin = (s: number, c: number) => (s ? n2(((s - c) / s) * 100) : '');
    const top = list.filter((r) => r.sales > 0).slice(0, 8);
    return { title: `Sales by Client ${from} → ${to}`, columns: ['Client', 'Invoices', 'Sales (ex-tax)', 'Cost of sales', 'Profit', 'Margin %', 'Received', 'Outstanding'], types: ['text', 'int', 'money', 'money', 'money', 'money', 'money', 'money'],
      rows: [...shown.map((r) => [r.name, r.n, n2(r.sales), n2(r.cost), n2(r.sales - r.cost), margin(r.sales, r.cost), n2(r.recd), n2(r.open)]), ['Total', T.n, n2(T.sales), n2(T.cost), n2(T.sales - T.cost), margin(T.sales, T.cost), n2(T.recd), n2(T.open)]],
      links: [...shown.map((r) => clientRoute(r.clientId, r.accountId)), null], kinds: [...shown.map(() => ''), 'total'],
      summary: [{ label: 'Sales', value: n2(T.sales) }, { label: 'Profit', value: n2(T.sales - T.cost), tone: T.sales - T.cost < 0 ? 'bad' : 'good' }, { label: 'Margin', value: margin(T.sales, T.cost), unit: '%' }, { label: 'Still owed', value: n2(T.open), tone: T.open > 0 ? 'warn' : undefined }],
      chart: top.length ? { kind: 'bars', labels: top.map((r) => r.name), series: [{ name: 'Sales', values: top.map((r) => Math.round(r.sales * 100) / 100), tone: 'accent' }, { name: 'Profit', values: top.map((r) => Math.round((r.sales - r.cost) * 100) / 100), tone: 'good' }] } : undefined,
      note: `Sales, cost and profit are for invoices and ticket invoices issued in the period, less credit notes (drafts and void excluded). Received is money recorded in the period; Outstanding is what clients still owe as at today. Click a client for their statement.${list.length > shown.length ? ` Showing the first ${shown.length} of ${list.length} clients; the total covers all of them.` : ''}` };
  },
  'sales-by-agent': async (t, from, to) => {
    type Row = { uid: number; name: string; n: number; sales: number; cost: number };
    const m = new Map<number, Row>(); const row = (uid: number, name: string) => { let r = m.get(uid); if (!r) m.set(uid, (r = { uid, name, n: 0, sales: 0, cost: 0 })); return r; };
    for (const r of await t.query(`SELECT COALESCE(u.id,0) uid, COALESCE(u.name,'Unassigned') name, COUNT(DISTINCT i.id) n, SUM(i.subtotal*i.fx_rate) sales, SUM(COALESCE(l.cost,0)*i.fx_rate) cost
      FROM invoices i LEFT JOIN bookings b ON b.id = i.booking_id AND b.agency_id = i.agency_id LEFT JOIN users u ON u.id = b.agent_id
      LEFT JOIN (SELECT agency_id, invoice_id, SUM(unit_cost*quantity) cost FROM invoice_lines WHERE agency_id = ? GROUP BY agency_id, invoice_id) l ON l.invoice_id = i.id AND l.agency_id = i.agency_id
      WHERE i.agency_id = ? AND i.status IN ${ISSUED} AND i.issue_date BETWEEN ? AND ? GROUP BY u.id, u.name`, [t.agencyId, t.agencyId, from, to])) { const x = row(r.uid, r.name); x.n += num(r.n); x.sales += num(r.sales); x.cost += num(r.cost); }
    for (const r of await t.query(`SELECT COALESCE(u.id,0) uid, COALESCE(u.name,'Unassigned') name, SUM(i.subtotal*i.fx_rate) credits FROM credit_notes i JOIN invoices v ON v.id = i.invoice_id AND v.agency_id = i.agency_id
      LEFT JOIN bookings b ON b.id = v.booking_id AND b.agency_id = v.agency_id LEFT JOIN users u ON u.id = b.agent_id WHERE i.agency_id = ? AND i.status = 'issued' AND i.issue_date BETWEEN ? AND ? GROUP BY u.id, u.name`, [t.agencyId, from, to])) row(r.uid, r.name).sales -= num(r.credits);
    for (const r of await t.query(`SELECT COALESCE(u.id,0) uid, COALESCE(u.name,'Unassigned') name, COUNT(DISTINCT i.id) n, SUM(l.receivable) sales, SUM(l.receivable - l.profit) cost FROM ticket_invoices i JOIN ticket_lines l ON l.invoice_id = i.id AND l.agency_id = i.agency_id
      LEFT JOIN users u ON u.id = i.employee_id WHERE i.agency_id = ? AND i.status = 'confirmed' AND i.invoice_date BETWEEN ? AND ? GROUP BY u.id, u.name`, [t.agencyId, from, to])) { const x = row(r.uid, r.name); x.n += num(r.n); x.sales += num(r.sales); x.cost += num(r.cost); }
    const list = [...m.values()].sort((a, b) => b.sales - b.cost - (a.sales - a.cost) || a.name.localeCompare(b.name)), T = { n: list.reduce((s, r) => s + r.n, 0), sales: sum(list.map((r) => r.sales)), cost: sum(list.map((r) => r.cost)) };
    return { title: `Sales by Agent ${from} → ${to}`, columns: ['Agent', 'Invoices', 'Sales (ex-tax)', 'Cost of sales', 'Profit', 'Margin %'], types: ['text', 'int', 'money', 'money', 'money', 'money'],
      rows: [...list.map((r) => [r.name, r.n, n2(r.sales), n2(r.cost), n2(r.sales - r.cost), pct(r.sales - r.cost, r.sales)]), ['Total', T.n, n2(T.sales), n2(T.cost), n2(T.sales - T.cost), pct(T.sales - T.cost, T.sales)]], kinds: [...list.map(() => ''), 'total'],
      summary: [{ label: 'Sales', value: n2(T.sales) }, { label: 'Profit', value: n2(T.sales - T.cost), tone: T.sales - T.cost < 0 ? 'bad' : 'good' }],
      chart: list.length ? { kind: 'bars', labels: list.slice(0, 8).map((r) => r.name), series: [{ name: 'Profit', values: list.slice(0, 8).map((r) => Math.round((r.sales - r.cost) * 100) / 100), tone: 'good' }] } : undefined,
      note: 'Invoices are credited to the agent on the booking; ticket invoices to the employee who entered them. Credit notes are taken off.' };
  },
  'booking-profitability': async (t, from, to, o) => {
    const cl = await clientFilter(t, o), lim = cap(o);
    const rows = await t.query(`SELECT b.id, b.reference, c.name client, COALESCE(b.destination,'') destination, b.travel_start,
        SUM(i.subtotal*i.fx_rate) - COALESCE((SELECT SUM(cn.subtotal*cn.fx_rate) FROM credit_notes cn JOIN invoices i2 ON i2.id = cn.invoice_id AND i2.agency_id = cn.agency_id WHERE cn.agency_id = b.agency_id AND i2.booking_id = b.id AND cn.status = 'issued' AND cn.issue_date BETWEEN ? AND ?),0) sales,
        COALESCE(SUM(l.cost*i.fx_rate),0) spend
      FROM invoices i JOIN bookings b ON b.id = i.booking_id AND b.agency_id = i.agency_id JOIN clients c ON c.id = b.client_id AND c.agency_id = b.agency_id
      LEFT JOIN (SELECT agency_id, invoice_id, SUM(unit_cost*quantity) cost FROM invoice_lines WHERE agency_id = ? GROUP BY agency_id, invoice_id) l ON l.invoice_id = i.id AND l.agency_id = i.agency_id
      WHERE i.agency_id = ? AND i.status IN ${ISSUED} AND i.issue_date BETWEEN ? AND ? ${cl ? 'AND b.client_id = ?' : ''}
      GROUP BY b.id, b.agency_id, b.reference, c.name, b.destination, b.travel_start ORDER BY (sales - spend) DESC LIMIT ${lim + 1}`, [from, to, t.agencyId, t.agencyId, from, to, ...(cl ? [cl.id] : [])]);
    const shown = rows.slice(0, lim), S = sum(shown.map((r: any) => num(r.sales))), C = sum(shown.map((r: any) => num(r.spend)));
    return { title: `Booking Profitability ${from} → ${to}${forClient(cl)}`, columns: ['Booking', 'Client', 'Destination', 'Departs', 'Sales (ex-tax)', 'Cost of sales', 'Profit', 'Margin %'], types: ['text', 'text', 'text', 'date', 'money', 'money', 'money', 'money'],
      rows: [...shown.map((r: any) => [r.reference, r.client, r.destination, r.travel_start ?? '', n2(r.sales), n2(r.spend), n2(num(r.sales) - num(r.spend)), pct(num(r.sales) - num(r.spend), num(r.sales))]), totalOf(8, 'Total', { 4: n2(S), 5: n2(C), 6: n2(S - C), 7: pct(S - C, S) })],
      links: [...shown.map((r: any) => `/bookings/${r.id}`), null], kinds: [...shown.map(() => ''), 'total'],
      summary: [{ label: 'Bookings', value: String(shown.length) }, { label: 'Sales', value: n2(S) }, { label: 'Profit', value: n2(S - C), tone: S - C < 0 ? 'bad' : 'good' }, { label: 'Margin', value: pct(S - C, S), unit: '%' }],
      note: rows.length > lim ? `Showing the ${lim} most profitable bookings; narrow the dates for the rest.` : 'Only invoices that belong to a booking are counted, best margin first.' };
  },
  'revenue-by-destination': async (t, from, to, o) => {
    const cl = await clientFilter(t, o), m = new Map<string, { n: number; rev: number }>(); const row = (d: string) => { let r = m.get(d); if (!r) m.set(d, (r = { n: 0, rev: 0 })); return r; };
    for (const r of await t.query(`SELECT COALESCE(b.destination,'Unspecified') d, COUNT(DISTINCT b.id) n, SUM(i.subtotal*i.fx_rate) rev FROM invoices i LEFT JOIN bookings b ON b.id = i.booking_id AND b.agency_id = i.agency_id
      WHERE i.agency_id = ? AND i.status IN ${ISSUED} AND i.issue_date BETWEEN ? AND ? ${cl ? 'AND i.client_id = ?' : ''} GROUP BY d`, [t.agencyId, from, to, ...(cl ? [cl.id] : [])])) { const x = row(r.d); x.n += num(r.n); x.rev += num(r.rev); }
    for (const r of await t.query(`SELECT COALESCE(b.destination,'Unspecified') d, SUM(cn.subtotal*cn.fx_rate) cr FROM credit_notes cn JOIN invoices i ON i.id = cn.invoice_id AND i.agency_id = cn.agency_id LEFT JOIN bookings b ON b.id = i.booking_id AND b.agency_id = i.agency_id
      WHERE cn.agency_id = ? AND cn.status = 'issued' AND cn.issue_date BETWEEN ? AND ? ${cl ? 'AND i.client_id = ?' : ''} GROUP BY d`, [t.agencyId, from, to, ...(cl ? [cl.id] : [])])) row(r.d).rev -= num(r.cr);
    const acct = cl ? (await t.get('clients', cl.id))?.account_id : null;
    if (!cl || acct) { const [tk] = await t.query(`SELECT COUNT(DISTINCT i.id) n, COALESCE(SUM(l.receivable),0) rev FROM ticket_invoices i JOIN ticket_lines l ON l.invoice_id = i.id AND l.agency_id = i.agency_id
      WHERE i.agency_id = ? AND i.status = 'confirmed' AND i.invoice_date BETWEEN ? AND ? ${acct ? 'AND i.client_account_id = ?' : ''}`, [t.agencyId, from, to, ...(acct ? [acct] : [])]); if (num(tk.rev)) { const x = row('Airline tickets'); x.n += num(tk.n); x.rev += num(tk.rev); } }
    const list = [...m.entries()].sort((a, b) => b[1].rev - a[1].rev), N = list.reduce((s, [, v]) => s + v.n, 0), R = sum(list.map(([, v]) => v.rev));
    return { title: `Booking Revenue by Destination ${from} → ${to}${forClient(cl)}`, columns: ['Destination', 'Bookings', 'Revenue'], types: ['text', 'int', 'money'],
      rows: [...list.map(([d, v]) => [d, v.n, n2(v.rev)]), ['Total', N, n2(R)]], kinds: [...list.map(() => ''), 'total'],
      summary: [{ label: 'Revenue', value: n2(R) }, { label: 'Destinations', value: String(list.length) }],
      chart: list.length ? { kind: 'bars', labels: list.slice(0, 8).map(([d]) => d), series: [{ name: 'Revenue', values: list.slice(0, 8).map(([, v]) => Math.round(v.rev * 100) / 100), tone: 'accent' }] } : undefined,
      note: 'Revenue is ex-tax and net of credit notes. Airline tickets are not tied to a destination, so they are shown on their own line (the count is ticket invoices).' };
  },
  'commission-summary': async (t, from, to) => {
    const rows = await t.query(`SELECT COALESCE(u.name,'Unassigned') agent, COUNT(*) n, SUM(c.selling_price) sell, SUM(c.supplier_cost) cost, SUM(c.overhead) oh, SUM(c.net_commission) net, SUM(c.agent_amount) pay FROM commissions c LEFT JOIN users u ON u.id=c.agent_id WHERE c.agency_id = ? AND c.period BETWEEN ? AND ? GROUP BY u.id, u.name ORDER BY net DESC`, [t.agencyId, from.slice(0, 7), to.slice(0, 7)]);
    const S = (k: string) => sum(rows.map((r: any) => num(r[k])));
    return { title: `Commission Summary ${from} → ${to}`, columns: ['Agent', 'Bookings', 'Selling', 'Cost', 'Overhead', 'Net commission', 'Agent payable'], types: ['text', 'int', 'money', 'money', 'money', 'money', 'money'],
      rows: [...rows.map((r: any) => [r.agent, r.n, n2(r.sell), n2(r.cost), n2(r.oh), n2(r.net), n2(r.pay)]), ['Total', rows.reduce((s: number, r: any) => s + num(r.n), 0), n2(S('sell')), n2(S('cost')), n2(S('oh')), n2(S('net')), n2(S('pay'))]], kinds: [...rows.map(() => ''), 'total'],
      summary: [{ label: 'Net commission', value: n2(S('net')) }, { label: 'Agent payable', value: n2(S('pay')), tone: S('pay') > 0 ? 'warn' : undefined }] };
  },

  /* --------------------------------------------------------------------- receivables */
  'ar-aging-summary': async (t, _f, to, o) => {
    const cl = await clientFilter(t, o), items = await receivables(t, to, { clientId: cl?.id }), parties = byParty(items, to);
    const B = [0, 1, 2, 3].map((i) => sum(parties.map((p) => p.b[i]))), tot = sum(parties.map((p) => p.total));
    return { title: `AR Aging Summary as at ${to}${forClient(cl)}`, columns: ['Client', 'Current', '1-30', '31-60', '60+', 'Total'], types: ['text', 'money', 'money', 'money', 'money', 'money'],
      rows: [...parties.map((p) => [p.name, n2(p.b[0]), n2(p.b[1]), n2(p.b[2]), n2(p.b[3]), n2(p.total)]), ['Total', ...B.map(n2), n2(tot)]],
      links: [...parties.map((p) => clientRoute(p.clientId, p.accountId)), null], kinds: [...parties.map(() => ''), 'total'],
      summary: agingSummary(items, to, 'Owed to you'), chart: agingChart(items, to),
      note: items.some((i) => i.doc === 'ticket') ? 'Ticket invoices have no payments of their own: receipts you record against the client clear the oldest ticket invoices first.' : undefined };
  },
  'ar-aging-detail': async (t, _f, to, o) => {
    const cl = await clientFilter(t, o), base = (await t.agency()).base_currency;
    const items = (await receivables(t, to, { clientId: cl?.id })).sort((a, b) => daysLate(to, b.due) - daysLate(to, a.due) || a.name.localeCompare(b.name));
    const rows = items.map((it) => { const other = it.doc === 'other'; return [it.number, it.name, it.doc === 'invoice' ? 'Invoice' : it.doc === 'ticket' ? 'Ticket invoice' : 'Ledger', other ? '' : it.due, it.currency || base, other ? '' : n2(it.total), other ? '' : n2(it.total - it.docBalance), n2(it.docBalance), n2(it.balance), other ? '' : Math.max(0, daysLate(to, it.due))]; });
    const tot = sum(items.map((i) => i.balance));
    return { title: `AR Aging Detail as at ${to}${forClient(cl)}`, columns: ['Document', 'Client', 'Type', 'Due', 'Currency', 'Total', 'Paid', 'Balance', 'Balance (base)', 'Days overdue'], types: ['text', 'text', 'text', 'date', 'text', 'money', 'money', 'money', 'money', 'int'],
      rows: [...rows, totalOf(10, 'Total', { 8: n2(tot) })], kinds: [...rows.map(() => ''), 'total'],
      links: [...items.map((it) => (it.doc === 'invoice' ? `/invoices?open=${it.id}` : it.doc === 'ticket' ? `/ticket-invoices?open=${it.id}` : it.accountId ? `/accounts?open=${it.accountId}` : null)), null], summary: agingSummary(items, to, 'Owed to you') };
  },
  'invoice-register': async (t, from, to, o) => {
    const cl = await clientFilter(t, o);
    const rows = await t.query(`SELECT i.id, i.number, c.name, i.issue_date, i.due_date, i.status, i.currency, i.total, i.amount_paid FROM invoices i JOIN clients c ON c.id=i.client_id AND c.agency_id=i.agency_id WHERE i.agency_id = ? AND i.issue_date BETWEEN ? AND ? ${cl ? 'AND i.client_id = ?' : ''} ORDER BY i.number LIMIT ${cap(o) + 1}`, [t.agencyId, from, to, ...(cl ? [cl.id] : [])]);
    const shown = rows.slice(0, cap(o)), one = new Set(shown.map((r: any) => r.currency)).size <= 1;
    return { title: `Invoice Register ${from} → ${to}${forClient(cl)}`, columns: ['Number', 'Client', 'Issued', 'Due', 'Status', 'Currency', 'Total', 'Paid'], types: ['text', 'text', 'date', 'date', 'text', 'text', 'money', 'money'],
      rows: [...shown.map((r: any) => [r.number, r.name, r.issue_date, r.due_date, r.status, r.currency, n2(r.total), n2(r.amount_paid)]), totalOf(8, one ? `Total (${shown.length} invoices)` : `Total (${shown.length} invoices, mixed currencies)`, one ? { 6: n2(sum(shown.map((r: any) => num(r.total)))), 7: n2(sum(shown.map((r: any) => num(r.amount_paid)))) } : {})],
      links: [...shown.map((r: any) => `/invoices?open=${r.id}`), null], kinds: [...shown.map(() => ''), 'total'],
      summary: [{ label: 'Invoices', value: String(shown.length) }, ...(one ? [{ label: 'Invoiced', value: n2(sum(shown.map((r: any) => num(r.total)))) }, { label: 'Paid', value: n2(sum(shown.map((r: any) => num(r.amount_paid)))), tone: 'good' as const }] : [])],
      note: rows.length > cap(o) ? `Showing the first ${cap(o)} invoices; narrow the dates or download for the rest.` : undefined };
  },

  /* ---------------------------------------------------------------------- payables */
  'ap-aging': async (t, _f, to) => {
    const items = (await payables(t, to)).sort((a, b) => daysLate(to, a.due) - daysLate(to, b.due) === 0 ? a.name.localeCompare(b.name) : daysLate(to, b.due) - daysLate(to, a.due)), base = (await t.agency()).base_currency;
    const rows = items.map((it) => { const other = it.doc === 'other'; return [it.name, it.number, it.theirRef, other ? '' : it.due, it.currency || base, n2(it.docBalance), n2(it.balance), other ? '' : Math.max(0, daysLate(to, it.due))]; });
    const tot = sum(items.map((i) => i.balance));
    return { title: `Payables Aging as at ${to}`, columns: ['Supplier', 'Bill', 'Their ref', 'Due', 'Currency', 'Outstanding', 'Outstanding (base)', 'Days overdue'], types: ['text', 'text', 'text', 'date', 'text', 'money', 'money', 'int'],
      rows: [...rows, totalOf(8, 'Total', { 6: n2(tot) })], kinds: [...rows.map(() => ''), 'total'],
      links: [...items.map((it) => (it.doc === 'ticket' ? `/ticket-invoices?open=${it.id}` : null)), null], summary: agingSummary(items, to, 'You owe'), chart: agingChart(items, to, 'You owe'),
      note: items.some((i) => i.doc === 'ticket') ? 'Airlines and vendors on ticket invoices are listed under the ticket invoice number; payments you record to them clear the oldest first.' : undefined };
  },
  'supplier-payments': async (t, from, to, o) => {
    const m = new Map<string, { name: string; n: number; amt: number }>(); const add = (name: string, n: number, amt: number) => { const k = name.toLowerCase(); const r = m.get(k) ?? { name, n: 0, amt: 0 }; r.n += n; r.amt += amt; m.set(k, r); };
    for (const r of await t.query(`SELECT s.name, COUNT(*) n, SUM(p.amount*p.fx_rate) amt FROM payments p JOIN suppliers s ON s.id=p.supplier_id AND s.agency_id=p.agency_id WHERE p.agency_id = ? AND p.voided = 0 AND p.direction='outbound' AND p.paid_at BETWEEN ? AND ? GROUP BY s.id, s.name`, [t.agencyId, from, to])) add(r.name, num(r.n), num(r.amt));
    for (const r of await t.query(`SELECT a.name, COUNT(*) n, SUM(c.amount) amt FROM cash_vouchers c JOIN accounts a ON a.id = c.party_account_id AND a.agency_id = c.agency_id WHERE c.agency_id = ? AND c.kind = 'payment' AND c.cleared = 1 AND c.voucher_date BETWEEN ? AND ? GROUP BY a.id, a.name`, [t.agencyId, from, to])) add(r.name, num(r.n), num(r.amt));
    const list = [...m.values()].sort((a, b) => b.amt - a.amt || a.name.localeCompare(b.name)), N = list.reduce((s, r) => s + r.n, 0), A = sum(list.map((r) => r.amt));
    return { title: `Supplier Payment Summary ${from} → ${to}`, columns: ['Supplier', 'Payments', 'Total paid'], types: ['text', 'int', 'money'], rows: [...list.map((r) => [r.name, r.n, n2(r.amt)]), ['Total', N, n2(A)]], kinds: [...list.map(() => ''), 'total'],
      summary: [{ label: 'Paid out', value: n2(A) }, { label: 'Payments', value: String(N) }], note: 'Includes payments you record as cash, cheque or bank vouchers to airlines and other vendors.' };
  },
  'payment-register': async (t, from, to, o) => {
    const cl = await clientFilter(t, o), clAcct = cl ? (await t.get('clients', cl.id))?.account_id ?? 0 : null;
    const ps = await t.query(`SELECT p.id, p.paid_at d, p.direction, p.method, COALESCE(c.name, ic.name, s.name, '') party, p.reference, p.currency, p.amount, p.amount * p.fx_rate base
      FROM payments p LEFT JOIN clients c ON c.id = p.client_id AND c.agency_id = p.agency_id LEFT JOIN suppliers s ON s.id = p.supplier_id AND s.agency_id = p.agency_id
      LEFT JOIN invoices i ON i.id = p.invoice_id AND i.agency_id = p.agency_id LEFT JOIN clients ic ON ic.id = i.client_id AND ic.agency_id = p.agency_id
      WHERE p.agency_id = ? AND p.voided = 0 AND p.paid_at BETWEEN ? AND ? ${cl ? 'AND COALESCE(p.client_id, i.client_id) = ?' : ''}`, [t.agencyId, from, to, ...(cl ? [cl.id] : [])]);
    const vs = await t.query(`SELECT c.id, COALESCE(c.cleared_date, c.voucher_date) d, CASE c.kind WHEN 'receipt' THEN 'inbound' ELSE 'outbound' END direction, c.mode method, a.name party, COALESCE(NULLIF(c.cheque_no,''), c.voucher_no) reference, c.amount
      FROM cash_vouchers c JOIN accounts a ON a.id = c.party_account_id AND a.agency_id = c.agency_id WHERE c.agency_id = ? AND c.cleared = 1 AND COALESCE(c.cleared_date, c.voucher_date) BETWEEN ? AND ? ${cl ? 'AND c.party_account_id = ?' : ''}`, [t.agencyId, from, to, ...(cl ? [clAcct] : [])]);
    const cur = (await t.agency()).base_currency;
    const all = [...ps.map((p: any) => ({ ...p, key: 0 })), ...vs.map((v: any) => ({ ...v, currency: cur, base: v.amount, key: 1 }))].sort((a, b) => String(a.d).localeCompare(String(b.d)) || a.key - b.key || a.id - b.id);
    const inb = sum(all.filter((p) => p.direction === 'inbound').map((p) => num(p.base))), out = sum(all.filter((p) => p.direction === 'outbound').map((p) => num(p.base)));
    const shown = all.slice(0, cap(o)), blank = ['', '', '', '', '', ''];
    return { title: `Payment Register ${from} → ${to}${forClient(cl)}`, columns: ['Date', 'Direction', 'Method', 'Party', 'Reference', 'Currency', 'Amount', 'Amount (base)'], types: ['date', 'text', 'text', 'text', 'text', 'text', 'money', 'money'],
      rows: [...shown.map((p: any) => [p.d, p.direction, String(p.method).replace(/_/g, ' '), p.party, p.reference ?? '', p.currency, n2(p.amount), n2(p.base)]), ['Total received', ...blank, n2(inb)], ['Total paid', ...blank, n2(out)], ['Net', ...blank, n2(inb - out)]],
      kinds: [...shown.map(() => ''), 'total', 'total', 'total'], summary: [{ label: 'Received', value: n2(inb), tone: 'good' }, { label: 'Paid', value: n2(out) }, { label: 'Net', value: n2(inb - out), tone: inb - out < 0 ? 'bad' : 'good' }],
      note: all.length > shown.length ? `Showing the first ${shown.length} of ${all.length} payments; totals cover all of them. Download for the full list.` : undefined };
  },

  /* ----------------------------------------------------------------- ledgers & books */
  'general-ledger': async (t, from, to, o) => {
    const id = Number(o?.account_id); if (!id) throw new HttpError(400, 'Choose an account for the general ledger');
    const acc = await t.get('accounts', id); if (!acc) throw new HttpError(404, 'Account not found');
    const prior = await t.one<{ d: number }>('SELECT COALESCE(SUM(debit - credit),0) d FROM gl_entries WHERE agency_id = ? AND account_id = ? AND entry_date < ?', [t.agencyId, id, from]);
    const opening = sum([acc.opening_dr - acc.opening_cr, prior!.d]);
    const ents = await t.query(`SELECT g.entry_date, g.debit, g.credit, g.narration, v.id vid, v.voucher_no, v.voucher_type, v.ref_table FROM gl_entries g JOIN vouchers v ON v.id = g.voucher_id AND v.agency_id = g.agency_id
      WHERE g.agency_id = ? AND g.account_id = ? AND g.entry_date BETWEEN ? AND ? ${HIDE_VOIDED_PAIRS} ORDER BY g.entry_date, g.id`, [t.agencyId, id, from, to, from, to, from, to]);
    let bal = opening;
    const rows: any[][] = [['', 'Opening balance', '', '', '', n2(opening)]], links: (string | null)[] = [null], kinds = ['muted'];
    for (const e of ents) { bal = sum([bal, e.debit, -e.credit]); rows.push([e.entry_date, e.voucher_no, e.narration ?? '', e.debit ? n2(e.debit) : '', e.credit ? n2(e.credit) : '', n2(bal)]); links.push(voucherLink(e)); kinds.push(''); }
    rows.push(['Total', '', '', n2(sum(ents.map((e: any) => e.debit))), n2(sum(ents.map((e: any) => e.credit))), n2(bal)]); links.push(null); kinds.push('total');
    const out: Report = { title: `General Ledger — ${acc.code} ${acc.name}, ${from} → ${to}`, columns: ['Date', 'Voucher', 'Narration', 'Debit', 'Credit', 'Balance'], rows, links, kinds, types: ['date', 'text', 'text', 'money', 'money', 'money'],
      note: 'Balance: positive = debit, negative = credit.' };
    if (isCurrent(to)) { const cur = await t.one<{ v: number }>(`SELECT ${BALANCE_SQL} v FROM accounts a WHERE a.agency_id = ? AND a.id = ?`, [t.agencyId, id]); out.reconcile = [rec('Closing balance vs current account balance', bal, cur!.v)]; }
    return out;
  },
  'client-statement': async (t, from, to, o) => {
    const cl = await clientFilter(t, o); if (!cl) throw new HttpError(400, 'Choose a client for the statement');
    const full = await t.get('clients', cl.id);
    if (!full?.account_id) throw new HttpError(409, 'This client has no ledger account yet — post an invoice or receipt for them first');
    const r = await GENERATORS['general-ledger'](t, from, to, { account_id: String(full.account_id) });
    return { ...r, title: `Client Statement — ${cl.name}, ${from} → ${to}`, note: 'Everything posted to this client’s ledger account. Balance: positive = the client owes you, negative = you owe the client (for example an unallocated receipt).' };
  },
  'day-book': async (t, from, to, o) => {
    const lim = cap(o);
    const ents = await t.query(`SELECT g.entry_date, g.debit, g.credit, g.narration, v.id vid, v.voucher_no, v.voucher_type, v.ref_table, a.code, a.name FROM gl_entries g
      JOIN vouchers v ON v.id = g.voucher_id AND v.agency_id = g.agency_id JOIN accounts a ON a.id = g.account_id AND a.agency_id = g.agency_id
      WHERE g.agency_id = ? AND g.entry_date BETWEEN ? AND ? ORDER BY g.entry_date, v.id, g.id LIMIT ${lim + 1}`, [t.agencyId, from, to]);
    const tot = await t.one<{ d: number; c: number; n: number }>('SELECT COALESCE(SUM(debit),0) d, COALESCE(SUM(credit),0) c, COUNT(*) n FROM gl_entries WHERE agency_id = ? AND entry_date BETWEEN ? AND ?', [t.agencyId, from, to]);
    const shown = ents.slice(0, lim);
    return { title: `Day Book ${from} → ${to}`, columns: ['Date', 'Voucher', 'Type', 'Account', 'Narration', 'Debit', 'Credit'], types: ['date', 'text', 'text', 'text', 'text', 'money', 'money'],
      rows: [...shown.map((e: any) => [e.entry_date, e.voucher_no, e.voucher_type.replace(/_/g, ' '), `${e.code} ${e.name}`, e.narration ?? '', e.debit ? n2(e.debit) : '', e.credit ? n2(e.credit) : '']), ['Total', '', '', '', '', n2(tot!.d), n2(tot!.c)]],
      links: [...shown.map(voucherLink), null], kinds: [...shown.map(() => ''), 'total'],
      note: ents.length > lim ? `Showing the first ${lim} of ${tot!.n} lines; narrow the dates or download for the full day book.` : undefined,
      reconcile: [rec('Ledger debits vs credits for the period (must balance)', tot!.d, tot!.c)] };
  },
  'cash-book': async (t, from, to) => {
    const rows = await t.query(`SELECT a.id, a.code, a.name,
      a.opening_dr - a.opening_cr + COALESCE((SELECT SUM(g.debit - g.credit) FROM gl_entries g WHERE g.agency_id = a.agency_id AND g.account_id = a.id AND g.entry_date < ?),0) opening,
      COALESCE((SELECT SUM(g.debit) FROM gl_entries g WHERE g.agency_id = a.agency_id AND g.account_id = a.id AND g.entry_date BETWEEN ? AND ?),0) receipts,
      COALESCE((SELECT SUM(g.credit) FROM gl_entries g WHERE g.agency_id = a.agency_id AND g.account_id = a.id AND g.entry_date BETWEEN ? AND ?),0) payments
      FROM accounts a WHERE a.agency_id = ? AND a.type_code = 110 ORDER BY a.code`, [from, from, to, from, to, t.agencyId]);
    const cl = (r: any) => sum([r.opening, r.receipts, -r.payments]);
    const out: Report = { title: `Cash & Bank Book ${from} → ${to}`, columns: ['Account', 'Opening', 'Receipts', 'Payments', 'Closing'], types: ['text', 'money', 'money', 'money', 'money'],
      rows: [...rows.map((r: any) => [`${r.code} ${r.name}`, n2(r.opening), n2(r.receipts), n2(r.payments), n2(cl(r))]),
        ['Total', n2(sum(rows.map((r: any) => r.opening))), n2(sum(rows.map((r: any) => r.receipts))), n2(sum(rows.map((r: any) => r.payments))), n2(sum(rows.map(cl)))]],
      links: [...rows.map((r: any) => `/accounts?open=${r.id}`), null], kinds: [...rows.map(() => ''), 'total'], summary: [{ label: 'Cash & bank now', value: n2(sum(rows.map(cl))) }] };
    if (isCurrent(to)) { const cur = await t.one<{ v: number }>(`SELECT COALESCE(SUM(${BALANCE_SQL}),0) v FROM accounts a WHERE a.agency_id = ? AND a.type_code = 110`, [t.agencyId]); out.reconcile = [rec('Closing cash & bank vs current ledger balances', sum(rows.map(cl)), cur!.v)]; }
    return out;
  },

  /* ----------------------------------------------------------------------- planning */
  'departures': async (t, from, to, o) => {
    const cl = await clientFilter(t, o);
    const rows = await t.query(`SELECT b.id, b.reference, b.destination, b.travel_start, b.travel_end, b.status, c.name client,
      (SELECT COUNT(*) FROM itinerary_items x WHERE x.agency_id = b.agency_id AND x.booking_id = b.id) legs,
      COALESCE((SELECT SUM((i.total-i.amount_credited-i.amount_paid)*i.fx_rate) FROM invoices i WHERE i.agency_id = b.agency_id AND i.booking_id = b.id AND i.status IN ('sent','partially_paid','overdue')),0) due
      FROM bookings b JOIN clients c ON c.id = b.client_id AND c.agency_id = b.agency_id WHERE b.agency_id = ? AND b.status NOT IN ('cancelled','lost','enquiry','quoted') AND b.travel_start BETWEEN ? AND ? ${cl ? 'AND b.client_id = ?' : ''} ORDER BY b.travel_start`, [t.agencyId, from, to, ...(cl ? [cl.id] : [])]);
    const D = sum(rows.map((r: any) => num(r.due)));
    return { title: `Departures ${from} → ${to}${forClient(cl)}`, columns: ['Booking', 'Destination', 'Client', 'Departs', 'Returns', 'Status', 'Itinerary items', 'Balance due'], types: ['text', 'text', 'text', 'date', 'date', 'text', 'int', 'money'],
      rows: [...rows.map((r: any) => [r.reference, r.destination ?? '', r.client, r.travel_start, r.travel_end ?? '', r.status, r.legs, n2(r.due)]), totalOf(8, `Total (${rows.length} departures)`, { 7: n2(D) })],
      links: [...rows.map((r: any) => `/bookings/${r.id}`), null], kinds: [...rows.map(() => ''), 'total'], summary: [{ label: 'Departures', value: String(rows.length) }, { label: 'Balance still due', value: n2(D), tone: D > 0 ? 'warn' : undefined }] };
  },
  'cash-forecast': async (t, from, to) => {
    const start = from, end = to > from ? to : addDays(from, 55), now = today();
    const ins = await receivables(t, now), outs = await payables(t, now);
    const weeks = Math.max(1, Math.min(26, Math.ceil(lengthDays(start, end) / 7))), last = weeks + 1;
    const slot = (due: string) => { const n = Math.round((Date.parse(`${due}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 864e5); return n < 0 ? 0 : n >= weeks * 7 ? last : 1 + Math.floor(n / 7); };
    const inn = Array(last + 1).fill(0), out = Array(last + 1).fill(0);
    for (const i of ins) inn[slot(i.due)] += i.balance;
    for (const i of outs) out[slot(i.due)] += i.balance;
    const labels = ['Overdue or due earlier', ...Array.from({ length: weeks }, (_, k) => `Week of ${addDays(start, k * 7)}`), 'Later'];
    let run = 0;
    const rows = labels.map((l, k) => { run += inn[k] - out[k]; return [l, n2(inn[k]), n2(out[k]), n2(inn[k] - out[k]), n2(run)]; });
    const I = sum(inn), O = sum(out);
    return { title: `Cash Forecast ${start} → ${end}`, columns: ['Period', 'Money in', 'Money out', 'Net', 'Cumulative'], types: ['text', 'money', 'money', 'money', 'money'],
      rows: [...rows, ['Total', n2(I), n2(O), n2(I - O), '']], kinds: [...rows.map(() => ''), 'total'],
      summary: [{ label: 'Due in', value: n2(I), tone: 'good' }, { label: 'Due out', value: n2(O) }, { label: 'Net', value: n2(I - O), tone: I - O < 0 ? 'bad' : 'good' }],
      chart: { kind: 'bars', labels: labels.map((l) => l.replace('Week of ', '')), series: [{ name: 'Money in', values: inn.map((x) => Math.round(x * 100) / 100), tone: 'good' }, { name: 'Money out', values: out.map((x) => Math.round(x * 100) / 100), tone: 'bad' }] },
      note: 'Built from what is open today, by due date: invoices and ticket invoices owed to you, and supplier bills and airlines you owe. Sales you have not invoiced yet are not included, and clients may pay later than their due date.' };
  },
};

/** Each reconciler ties a report's total back to the ledger or to its source records and says so out loud. */
const RECONCILERS: Record<string, (t: Tenant, r: Report, from: string, to: string) => Promise<Reconcile[]>> = {
  'ar-aging-summary': async (t, r, _f, to) => (isCurrent(to) ? [rec('Receivables aging total vs ledger client accounts (plus unallocated receipts)', sum(dataRows(r).map((x) => Number(x[5]))), await receivablesLedger(t))] : []),
  'ar-aging-detail': async (t, r, _f, to) => (isCurrent(to) ? [rec('Receivables aging total vs ledger client accounts (plus unallocated receipts)', sum(dataRows(r).map((x) => Number(x[8]))), await receivablesLedger(t))] : []),
  'sales-by-client': async (t, r, _f, to) => (isCurrent(to) ? [rec('Outstanding total vs ledger client accounts (plus unallocated receipts)', sum(dataRows(r).map((x) => Number(x[7]))), await receivablesLedger(t))] : []),
  'ap-aging': async (t, r, _f, to) => (isCurrent(to) ? [rec('Payables aging total vs ledger supplier and airline accounts', sum(dataRows(r).map((x) => Number(x[6]))), await payablesLedger(t))] : []),
  'gl-pnl': async (t, r, from, to) => {
    const bal = await t.one(`SELECT COALESCE(SUM(g.debit),0) d, COALESCE(SUM(g.credit),0) c FROM gl_entries g JOIN vouchers v ON v.id = g.voucher_id AND v.agency_id = g.agency_id WHERE g.agency_id = ? AND v.voucher_date BETWEEN ? AND ?`, [t.agencyId, from, to]);
    return [rec('Ledger debits vs credits for the period (must balance)', bal!.d, bal!.c)];
  },
};

/** Build a report plus its reconciliation. Shared by the API and the scheduler so both always agree. */
export async function buildReport(t: Tenant, name: string, from: string, to: string, opts?: Record<string, string>): Promise<Report> {
  const gen = GENERATORS[name]; if (!gen) throw new HttpError(404, 'Unknown report');
  const report = await gen(t, from, to, opts);
  const own = report.note;
  report.note = `${own ? own + ' ' : ''}Amounts are in ${(await t.agency()).base_currency}, converted at the exchange rate locked on each document when it was issued or paid (document currencies are shown where relevant).`;
  const checks = opts?.client_id && name !== 'client-statement' ? undefined : await RECONCILERS[name]?.(t, report, from, to);   // a one-client view cannot tie to the whole-ledger total
  if (checks?.length) report.reconcile = checks; else if (name.includes('aging') && !isCurrent(to)) report.note += ` ${ASOF}`;
  report.types = colKinds(report);
  return report;
}

const dateOk = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

/** The list of reports, for the Reports page and the scheduler. */
reportsRouter.get('/catalog', (_req, res) => { res.json(CATALOG); });

/** The few numbers worth seeing before opening any report: this month so far against the same days last month, and what is owed each way. */
reportsRouter.get('/overview', async (req, res) => {
  const t = T(req), a = await t.agency(), now = today(), monthStart = `${now.slice(0, 7)}-01`;
  const prevEnd = addDays(monthStart, -1), prevStart = `${prevEnd.slice(0, 7)}-01`, day = Number(now.slice(8, 10)), prevTo = addDays(prevStart, day - 1) > prevEnd ? prevEnd : addDays(prevStart, day - 1);
  const period = async (from: string, to: string) => { const s = await sales(t, from, to), c = await cashMoves(t, from, to), revenue = s.invoices - s.credits + s.tickets; return { from, to, revenue, profit: revenue - s.cost - s.ticketCost, cashIn: c.in, cashOut: c.out }; };
  const ar = await receivables(t, now), ap = await payables(t, now);
  const over = (xs: OpenItem[], min: number) => sum(xs.filter((i) => daysLate(now, i.due) > min).map((i) => i.balance));
  const cash = await t.one<{ v: number }>(`SELECT COALESCE(SUM(${BALANCE_SQL}),0) v FROM accounts a WHERE a.agency_id = ? AND a.type_code = 110`, [t.agencyId]);
  res.json({ currency: a.base_currency, today: now, month: await period(monthStart, now), previous: await period(prevStart, prevTo),
    receivables: { total: sum(ar.map((i) => i.balance)), overdue: over(ar, 0), over60: over(ar, 60) }, payables: { total: sum(ap.map((i) => i.balance)), overdue: over(ap, 0) }, cash: num(cash!.v) });
});

reportsRouter.get('/:name', async (req, res) => {
  const t = T(req), name = req.params.name as string;
  const y = new Date().getUTCFullYear();
  const from = String(req.query.from ?? `${y}-01-01`), to = String(req.query.to ?? today());
  if (!dateOk(from) || !dateOk(to)) throw new HttpError(400, 'from and to must be dates (YYYY-MM-DD)');
  const format = String(req.query.format ?? 'json');
  if (!['json', 'xlsx', 'pdf', 'csv'].includes(format)) throw new HttpError(400, 'format must be json, xlsx, pdf or csv');
  const opts = Object.fromEntries(Object.entries(req.query).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
  if (format !== 'json') opts.export = '1';   // a download carries every row, not just the first screenful
  const report = await buildReport(t, name, from, to, opts);
  if (format === 'json') return void res.json(report);

  // Exports are written to R2 and returned as a short-lived signed URL (never served publicly).
  const agency = await t.agency(), brand = { agency, logo: await agencyLogoData(agency) };
  let buf: Buffer, ext: string, mime: string;
  if (format === 'xlsx') { buf = await reportXlsx(report, brand); ext = 'xlsx'; mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'; }
  else if (format === 'csv') { buf = reportCsv(report); ext = 'csv'; mime = 'text/csv'; }
  else { buf = await htmlToPdf(reportHtml(report, brand), { footer: `${agency.name} · ${report.title}`, landscape: isWide(report) }); ext = 'pdf'; mime = 'application/pdf'; }
  const key = await putFile(fileKey(t.agencyId, 'reports', `${name}.${ext}`), buf, mime);
  res.json({ url: await signedUrl(t.agencyId, key, `${name}.${ext}`) });
});
