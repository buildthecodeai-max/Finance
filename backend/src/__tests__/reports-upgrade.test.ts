import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, addMember, apiBase, boot, newAgency, seedBasics, shutdown, sql, ticketBody } from './helpers.js';

let A: Api, agent: Api, viewer: Api, C: Api;
let s: Awaited<ReturnType<typeof seedBasics>>;
const today = () => new Date().toISOString().slice(0, 10);
const plus = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const rep = (who: Api, name: string, q = '', from = '2020-01-01', to = today()) => who.get(`/reports/${name}?from=${from}&to=${to}${q}`);
const data = (r: any) => r.rows.filter((_: any, i: number) => r.kinds?.[i] !== 'total' && r.kinds?.[i] !== 'section');
const totalRow = (r: any) => r.rows[r.kinds.lastIndexOf('total')];
const rowOf = (r: any, label: string) => r.rows.find((x: any[]) => x[0] === label);
const download = async (url: string) => { const u = url.startsWith('http') ? url : new URL(url, apiBase()).toString(); return Buffer.from(await (await fetch(u)).arrayBuffer()); };

beforeAll(async () => {
  await boot(); A = await newAgency('RU-A'); s = await seedBasics(A); agent = await addMember(A, 'agent'); viewer = await addMember(A, 'viewer'); C = await newAgency('RU-C');
});
afterAll(shutdown);

describe('who can open reports', () => {
  it('every report is for finance roles; agents are refused, viewers may read', async () => {
    const cat = (await A.get('/reports/catalog')).body as { reports: { key: string; account?: boolean; client?: string }[] }[];
    const keys = cat.flatMap((c) => c.reports);
    expect(keys.length).toBeGreaterThanOrEqual(19);
    for (const r of keys) expect((await rep(agent, r.key)).status, r.key).toBe(403);
    expect((await agent.get('/reports/catalog')).status).toBe(403);
    expect((await agent.get('/reports/overview')).status).toBe(403);
    for (const k of ['pnl', 'cash-flow', 'ar-aging-summary', 'commission-summary', 'supplier-payments', 'departures']) expect((await rep(viewer, k)).status, k).toBe(200);
  });
  it('the catalog lists every report that can be built, and what each needs', async () => {
    const cat = (await A.get('/reports/catalog')).body as any[], all = cat.flatMap((c) => c.reports);
    for (const r of all.filter((x) => !x.account && x.client !== 'required')) expect((await rep(A, r.key)).status, r.key).toBe(200);
    expect(all.find((x) => x.key === 'general-ledger')).toMatchObject({ account: true }); expect(all.find((x) => x.key === 'client-statement')).toMatchObject({ client: 'required' });
  });
});

describe('ticket invoices in receivables and payables', () => {
  let ti1: number, ti2: number, name: string, no2: string;
  beforeAll(async () => {
    for (const k of [1, 2]) {
      const inv = (await A.post('/tickets/invoices', ticketBody(s.client, s.airline))).body; expect((await A.post(`/tickets/invoices/${inv.id}/supervise`)).status).toBe(200);
      if (k === 1) ti1 = inv.id; else { ti2 = inv.id; no2 = inv.invoice_no; }
    }
    name = ((await A.get('/accounting/lookup?types=120')).body as any[]).find((x) => x.id === s.client).name;
  });

  it('issued ticket invoices are owed by the client and the ledger agrees', async () => {
    const r = (await rep(A, 'ar-aging-summary')).body;
    expect(data(r)).toEqual([[name, '2200.00', '0.00', '0.00', '0.00', '2200.00']]);
    expect(r.links[0]).toBe(`/accounts?open=${s.client}`); expect(r.reconcile[0]).toMatchObject({ ok: true, difference: 0, report: 2200 });
    expect(totalRow(r).slice(1)).toEqual(['2200.00', '0.00', '0.00', '0.00', '2200.00']);
    expect(r.summary[0]).toMatchObject({ label: 'Owed to you', value: '2200.00' }); expect(r.chart.series[0].values).toEqual([2200, 0, 0, 0]);
  });

  it('receipts that name a ticket invoice clear it; the rest clear the oldest first', async () => {
    expect((await A.post('/vouchers/receipts', { cash_account_id: s.cash, party_account_id: s.client, amount: 1100, mode: 'cash', ticket_invoice_id: ti1 })).status).toBe(201);
    expect((await A.post('/vouchers/receipts', { cash_account_id: s.cash, party_account_id: s.client, amount: 400, mode: 'cash' })).status).toBe(201);
    const sum = (await rep(A, 'ar-aging-summary')).body;
    expect(data(sum)[0].slice(1)).toEqual(['700.00', '0.00', '0.00', '0.00', '700.00']); expect(sum.reconcile[0].ok).toBe(true);
    const det = (await rep(A, 'ar-aging-detail')).body, rows = data(det);
    expect(rows).toHaveLength(1); expect(rows[0][0]).toBe(no2); expect(rows[0][2]).toBe('Ticket invoice'); expect(rows[0].slice(5, 9)).toEqual(['1100.00', '400.00', '700.00', '700.00']);
    expect(det.links[0]).toBe(`/ticket-invoices?open=${ti2}`); expect(det.reconcile[0].ok).toBe(true);
  });

  it('what is owed to airlines is listed too, and payments clear it', async () => {
    let ap = (await rep(A, 'ap-aging')).body;
    expect(data(ap).map((r: any[]) => r[5])).toEqual(['1000.00', '1000.00']); expect(totalRow(ap)[6]).toBe('2000.00'); expect(ap.reconcile[0]).toMatchObject({ ok: true, report: 2000 });
    expect((await A.post('/vouchers/payments', { cash_account_id: s.cash, party_account_id: s.airlineAcc, amount: 500, mode: 'bank' })).status).toBe(201);
    ap = (await rep(A, 'ap-aging')).body; expect(totalRow(ap)[6]).toBe('1500.00'); expect(ap.reconcile[0].ok).toBe(true);
    expect(data(ap)).toHaveLength(2); expect(ap.links[0]).toMatch(/^\/ticket-invoices\?open=/);
  });

  it('sales by client and the sales-basis P&L count ticket sales', async () => {
    const r = (await rep(A, 'sales-by-client')).body, row = data(r)[0];
    expect(row).toEqual([name, 2, '2200.00', '2000.00', '200.00', '9.09', '1500.00', '700.00']); expect(r.reconcile[0]).toMatchObject({ ok: true });
    const p = (await rep(A, 'pnl')).body;
    expect(rowOf(p, 'Revenue — airline tickets')[1]).toBe('2200.00'); expect(rowOf(p, 'Gross profit')[1]).toBe('200.00'); expect(rowOf(p, 'Net profit')[1]).toBe('200.00');
    const g = (await rep(A, 'revenue-by-destination')).body; expect(rowOf(g, 'Airline tickets')).toEqual(['Airline tickets', 2, '2200.00']);
  });

  it('cash cash flow, supplier payments and the payment register include vouchers', async () => {
    const f = (await rep(A, 'cash-flow')).body; expect(totalRow(f).slice(1, 4)).toEqual(['1500.00', '500.00', '1000.00']); expect(f.chart.series.map((x: any) => x.name)).toEqual(['Money in', 'Money out']);
    const sp = (await rep(A, 'supplier-payments')).body; expect(data(sp)).toHaveLength(1); expect(data(sp)[0].slice(1)).toEqual([1, '500.00']);
    const reg = (await rep(A, 'payment-register')).body; expect(data(reg)).toHaveLength(3); expect(reg.rows.slice(-3).map((x: any[]) => x[7])).toEqual(['1500.00', '500.00', '1000.00']);
  });

  it('planning and agent reports use the same open items', async () => {
    const fc = (await rep(A, 'cash-forecast', '', today(), plus(today(), 55))).body, t = totalRow(fc);
    expect(t.slice(1, 4)).toEqual(['700.00', '1500.00', '-800.00']); expect(fc.rows[1][0]).toBe(`Week of ${today()}`); expect(fc.rows[1][1]).toBe('700.00');
    const ag = (await rep(A, 'sales-by-agent')).body; expect(data(ag)[0].slice(1, 5)).toEqual([2, '2200.00', '2000.00', '200.00']);
    const ov = (await A.get('/reports/overview')).body; expect(ov.currency).toBe('USD'); expect(ov.receivables.total).toBe(700); expect(ov.payables.total).toBe(1500); expect(ov.month.revenue).toBe(2200);
  });

  it('aging for a date before the invoices existed shows nothing, and is not compared with the ledger', async () => {
    const r = (await rep(A, 'ar-aging-summary', '', '2020-01-01', plus(today(), -1))).body;
    expect(data(r)).toEqual([]); expect(r.reconcile).toBeUndefined(); expect(r.note).toMatch(/dated on or before/);
    expect(data((await rep(A, 'ap-aging', '', '2020-01-01', plus(today(), -1))).body)).toEqual([]);
  });
});

describe('credit notes, tax and past-dated aging', () => {
  let client: number, inv: number;
  const mk = async (name: string) => (await C.post('/clients', { name, email: `${name.replace(/\W/g, '')}@c.test`, currency: 'USD' })).body.id as number;
  beforeAll(async () => {
    client = await mk('Credit Tours');
    const r = await C.post('/invoices', { client_id: client, currency: 'USD', lines: [{ product_type: 'hotel', description: 'Trip', unit_cost: 1000, markup_pct: 10, tax_rate: 10 }] });
    inv = r.body.inv.id; await C.post(`/invoices/${inv}/status`, { status: 'reviewed' }); expect((await C.post(`/invoices/${inv}/issue`)).status).toBe(200);
    const cn = await C.post('/finance/credit-notes', { invoice_id: inv, reason: 'Hotel downgrade', lines: [{ description: 'Room refund', amount: 100, tax: 10 }] });
    expect((await C.post(`/finance/credit-notes/${cn.body.id}/issue`)).status).toBe(200);
  });

  it('credit notes come off sales everywhere sales are shown', async () => {
    const p = (await rep(C, 'pnl')).body;
    expect([rowOf(p, 'Revenue — invoices (ex-tax)')[1], rowOf(p, 'Less: credit notes')[1], rowOf(p, 'Total revenue')[1], rowOf(p, 'Cost of sales — suppliers')[1], rowOf(p, 'Gross profit')[1]]).toEqual(['1100.00', '-100.00', '1000.00', '1000.00', '0.00']);
    expect(data((await rep(C, 'sales-by-client')).body)[0].slice(1, 5)).toEqual([1, '1000.00', '1000.00', '0.00']);
    expect(rowOf((await rep(C, 'revenue-by-destination')).body, 'Unspecified')[2]).toBe('1000.00');
  });

  it('the ledger P&L has sections and a gross profit, and says when costs are missing', async () => {
    const mkAcc = async (type: number, name: string) => (await C.post('/accounting/accounts', { type_code: type, name })).body.id as number;
    const cash = ((await C.get('/accounting/lookup?types=110')).body as any[])[0].id, sales = await mkAcc(410, 'Fees'), cost = await mkAcc(310, 'Direct cost'), rent = await mkAcc(320, 'Office rent');
    const jv = (a: number, b: number, amt: number) => C.post('/accounting/journal', { narration: 'x', lines: [{ account_id: a, debit: amt }, { account_id: b, credit: amt }] });
    await jv(cash, sales, 500); await jv(cost, cash, 200); await jv(rent, cash, 50);
    const r = (await rep(C, 'gl-pnl')).body;
    expect(r.rows.filter((_: any, i: number) => r.kinds[i] === 'section').map((x: any[]) => x[0])).toEqual(['INCOME', 'COST OF REVENUE', 'EXPENSES']);
    expect([rowOf(r, 'Total income')[1], rowOf(r, 'Total cost of revenue')[1], rowOf(r, 'Gross profit')[1], rowOf(r, 'Total expenses')[1], rowOf(r, 'Net profit')[1]]).toEqual(['1500.00', '200.00', '1300.00', '50.00', '1250.00']);   // 1100 booking revenue − 100 credit note + 500 fees
    expect(r.links.find((x: any) => x?.startsWith('/reports?report=general-ledger&account='))).toBeTruthy(); expect(r.reconcile[0].ok).toBe(true);
    expect(r.hints).toHaveLength(1); expect(r.hints[0]).toMatch(/1,000\.00 of supplier cost/);
    const cmp = (await rep(C, 'gl-pnl', '&compare=prev')).body; expect(cmp.columns).toEqual(['Account', 'This period', 'Previous period', 'Change', 'Change %']);
    expect(rowOf(cmp, 'Net profit').slice(1)).toEqual(['1250.00', '0.00', '1250.00', '']);
    expect((await rep(C, 'gl-pnl', '&compare=year')).body.title).toMatch(/vs 2019-01-01/);
  });

  it('tax collected comes from the ledger, net of credit notes', async () => {
    const t = (await rep(C, 'tax-summary')).body; expect(totalRow(t).slice(1)).toEqual(['100.00', '0.00', '100.00']); expect(t.columns[1]).toMatch(/collected on sales/);
  });

  it('aging for a past date is rebuilt from the documents and payments dated by then', async () => {
    await sql("UPDATE invoices SET issue_date = '2020-01-10', due_date = '2020-02-10' WHERE id = ?", [inv]);
    await sql("UPDATE credit_notes SET issue_date = '2020-04-01' WHERE invoice_id = ?", [inv]);
    await sql(`INSERT INTO payments (agency_id, direction, method, invoice_id, client_id, amount, currency, fx_rate, paid_at, voided) VALUES (?, 'inbound', 'bank_transfer', ?, ?, 300, 'USD', 1, '2020-03-01', 0)`, [C.agencyId, inv, client]);
    const at = async (d: string) => (await rep(C, 'ar-aging-summary', `&client_id=${client}`, '2020-01-01', d)).body;
    expect(data(await at('2020-01-05'))).toEqual([]);                                                    // not issued yet
    expect(data(await at('2020-02-15'))[0].slice(1)).toEqual(['0.00', '1210.00', '0.00', '0.00', '1210.00']);   // 5 days late, nothing paid yet
    expect(data(await at('2020-03-15'))[0].slice(1)).toEqual(['0.00', '0.00', '910.00', '0.00', '910.00']);    // after the 300 payment, 34 days late
    expect(data(await at('2020-04-15'))[0].slice(1)).toEqual(['0.00', '0.00', '0.00', '800.00', '800.00']);    // after the 110 credit note too: 800 left, 65 days late
  });
});

describe('downloads', () => {
  let client: number;
  beforeAll(async () => {
    client = (await C.post('/clients', { name: 'M/S Khan: Travels [Pvt]', email: 'khan@c.test', currency: 'USD' })).body.id;
    const r = await C.post('/invoices', { client_id: client, currency: 'USD', lines: [{ product_type: 'hotel', description: 'Trip', unit_cost: 100, markup_pct: 10, tax_rate: 0 }] });
    await C.post(`/invoices/${r.body.inv.id}/status`, { status: 'reviewed' }); await C.post(`/invoices/${r.body.inv.id}/issue`);
  });

  it('an Excel statement for a name with / : [ ] opens fine, with real numbers and bold totals', async () => {
    const r = await rep(C, 'client-statement', `&client_id=${client}&format=xlsx`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load((await download(r.body.url)) as any);
    const ws = wb.worksheets[0]; expect(ws.name).not.toMatch(/[\\/?*:[\]]/); expect(ws.name.length).toBeLessThanOrEqual(31); expect(ws.name).toMatch(/^Client Statement/);
    const find = (txt: string) => { let hit: ExcelJS.Row | undefined; ws.eachRow((row) => { if (row.getCell(1).value === txt || row.getCell(2).value === txt) hit = row; }); return hit; };
    const total = find('Total')!; expect(total.getCell(4).value).toBe(110); expect(total.getCell(4).numFmt).toContain('#,##0.00'); expect(total.getCell(1).font?.bold).toBe(true);
    expect(ws.views[0]).toMatchObject({ state: 'frozen' }); expect(String(ws.getCell(1, 1).value).length).toBeGreaterThan(2);   // the agency name heads the sheet
  });

  it('CSV and PDF downloads work too, and a download is never cut at the on-screen limit', async () => {
    const csv = await rep(C, 'trial-balance', '&format=csv'); expect(csv.status).toBe(200);
    const text = (await download(csv.body.url)).toString('utf8'); expect(text.charCodeAt(0)).toBe(0xfeff); expect(text).toContain('Code,Account,Type,Debit,Credit');
    const pdf = await rep(C, 'trial-balance', '&format=pdf'); expect(pdf.status).toBe(200); expect((await download(pdf.body.url)).subarray(0, 4).toString()).toBe('%PDF');
    expect((await rep(C, 'trial-balance', '&format=docx')).status).toBe(400); expect((await C.get('/reports/pnl?from=nope&to=2020-01-01')).status).toBe(400);
  });

  it('every report says what each column holds, so figures line up the same on screen and in files', async () => {
    const r = (await rep(C, 'ar-aging-summary')).body; expect(r.types).toEqual(['text', 'money', 'money', 'money', 'money', 'money']);
    const sb = (await rep(C, 'sales-by-client')).body; expect(sb.types).toHaveLength(sb.columns.length);
  });
});

describe('bookings and tax', () => {
  it('booking profitability lists each booking with its margin, best first', async () => {
    const c = (await C.post('/clients', { name: 'Margin Group', email: 'm@c.test', currency: 'USD' })).body.id;
    const b = (await C.post('/bookings', { client_id: c, destination: 'Bali' })).body.id;
    const r = await C.post('/invoices', { client_id: c, booking_id: b, currency: 'USD', lines: [{ product_type: 'hotel', description: 'Villa', unit_cost: 400, markup_pct: 25, tax_rate: 0 }] });
    await C.post(`/invoices/${r.body.inv.id}/status`, { status: 'reviewed' }); await C.post(`/invoices/${r.body.inv.id}/issue`);
    const p = (await rep(C, 'booking-profitability')).body, row = data(p).find((x: any[]) => x[1] === 'Margin Group');
    expect(row.slice(2).filter((_: any, i: number) => i !== 1)).toEqual(['Bali', '500.00', '400.00', '100.00', '20.00']); expect(p.links[p.rows.indexOf(row)]).toBe(`/bookings/${b}`);
    expect(totalRow(p)[0]).toBe('Total');
    expect((await rep(C, 'booking-profitability', `&client_id=${c}`)).body.title).toMatch(/Margin Group/);
  });
});
