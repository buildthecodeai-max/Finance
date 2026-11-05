import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, addMember, boot, newAgency, shutdown, sql } from './helpers.js';

let A: Api, B: Api, agent: Api, viewer: Api, fm: Api;
let cash: number, capital: number, rent: number;
const today = () => new Date().toISOString().slice(0, 10);
const rep = async (name: string, q = '', who = A) => who.get(`/reports/${name}?from=2020-01-01&to=${today()}${q}`);
const acct = async (type: number, name: string) => (await A.post('/accounting/accounts', { type_code: type, name })).body.id as number;
const journal = async (a: number, b: number, amt: number, narration: string) => (await A.post('/accounting/journal', { narration, lines: [{ account_id: a, debit: amt }, { account_id: b, credit: amt }] })).body.id as number;
let j1: number, j2: number;

beforeAll(async () => {
  await boot(); A = await newAgency('ACC'); B = await newAgency('ACC-B');
  agent = await addMember(A, 'agent'); viewer = await addMember(A, 'viewer'); fm = await addMember(A, 'finance_manager');
  cash = ((await A.get('/accounting/lookup?types=110')).body as any[]).find((x) => x.name.includes('Cash')).id;
  capital = await acct(230, 'Owner Capital'); rent = await acct(320, 'Office Rent');
  j1 = await journal(cash, capital, 1000, 'Capital introduced');
  j2 = await journal(rent, cash, 200, 'Rent paid');
});
afterAll(shutdown);

describe('statements built from the ledger', () => {
  it('trial balance balances, lists only live accounts and links to each account', async () => {
    const r = (await rep('trial-balance')).body;
    expect(r.reconcile[0]).toMatchObject({ ok: true });
    const total = r.rows[r.rows.length - 1];
    expect(total[0]).toBe('Total'); expect(total[3]).toBe('1000.00'); expect(total[4]).toBe('1000.00');
    expect(r.rows.some((x: any[]) => x[1] === 'Owner Capital' && x[4] === '1000.00')).toBe(true);
    expect(r.rows.some((x: any[]) => x[1] === 'Ticket Sales')).toBe(false);          // zero-balance accounts are left out
    expect(r.links[0]).toMatch(/^\/accounts\?open=\d+$/); expect(r.kinds[r.kinds.length - 1]).toBe('total');
  });

  it('trial balance as at an earlier date ignores later postings', async () => {
    const r = (await A.get('/reports/trial-balance?from=2020-01-01&to=2020-12-31')).body;
    expect(r.rows).toHaveLength(1);                                                   // only the Total row: nothing existed yet
    expect(r.reconcile[0].ok).toBe(true);
  });

  it('balance sheet balances: assets = liabilities + equity, with profit to date in equity', async () => {
    const r = (await rep('balance-sheet')).body;
    expect(r.reconcile[0]).toMatchObject({ ok: true });
    const get = (label: string) => Number(r.rows.find((x: any[]) => x[0] === label)?.[1]);
    expect(get('Total assets')).toBe(800); expect(get('Profit to date (income less expenses)')).toBe(-200);
    expect(get('Total equity')).toBe(800); expect(get('Total liabilities & equity')).toBe(800);
    expect(r.kinds.filter((k: string) => k === 'section')).toHaveLength(3);
  });

  it('general ledger shows the running balance, links vouchers and ties to the account balance', async () => {
    const r = (await rep('general-ledger', `&account_id=${cash}`)).body;
    expect(r.reconcile[0]).toMatchObject({ ok: true });
    expect(r.rows[0][1]).toBe('Opening balance');
    const lines = r.rows.slice(1, -1);
    expect(lines.map((x: any[]) => x[5])).toEqual(['1000.00', '800.00']);
    expect(r.rows[r.rows.length - 1].slice(3)).toEqual(['1000.00', '200.00', '800.00']);
    expect(r.links[1]).toBe(`/journal?view=${j1}`);
    expect((await rep('general-ledger')).status).toBe(400);                          // an account is required
  });

  it('day book lists every posting and its debits equal its credits', async () => {
    const r = (await rep('day-book')).body;
    expect(r.reconcile[0]).toMatchObject({ ok: true });
    expect(r.rows.filter((x: any[]) => x[1]?.startsWith('JV-'))).toHaveLength(4);
    expect(r.rows[r.rows.length - 1].slice(5)).toEqual(['1200.00', '1200.00']);
  });

  it('cash & bank book rolls opening, receipts and payments into the closing balance', async () => {
    const r = (await rep('cash-book')).body;
    const row = r.rows.find((x: any[]) => String(x[0]).includes('Cash in Hand'));
    expect(row.slice(1)).toEqual(['0.00', '1000.00', '200.00', '800.00']);
    expect(r.reconcile[0]).toMatchObject({ ok: true });
  });

  it('the cash book for a past period reconciles to nothing yet, but still totals correctly', async () => {
    const r = (await A.get('/reports/cash-book?from=2020-01-01&to=2020-12-31')).body;
    expect(r.reconcile).toBeUndefined();
    expect(r.rows[r.rows.length - 1].slice(1)).toEqual(['0.00', '0.00', '0.00', '0.00']);
  });
});

describe('payments reports ignore voided payments', () => {
  it('cash flow, supplier payments and the payment register count only live payments', async () => {
    const sup = (await A.post('/suppliers', { name: 'Coral Hotels', supplier_type: 'hotel' })).body.id;
    const ins = (inbound: boolean, amount: number, voided: number) => sql(
      `INSERT INTO payments (agency_id, direction, method, amount, currency, fx_rate, paid_at, supplier_id, voided) VALUES (?,?, 'bank_transfer', ?, 'USD', 1, ?, ?, ?)`,
      [A.agencyId, inbound ? 'inbound' : 'outbound', amount, today(), inbound ? null : sup, voided]);
    await ins(true, 500, 1); await ins(true, 100, 0); await ins(false, 70, 0); await ins(false, 900, 1);
    const flow = (await rep('cash-flow')).body.rows[0];
    expect(flow.slice(1, 4)).toEqual(['100.00', '70.00', '30.00']);
    expect((await rep('supplier-payments')).body.rows[0]).toEqual(['Coral Hotels', 1, '70.00']);
    const reg = (await rep('payment-register')).body;
    expect(reg.rows.filter((x: any[]) => x[1] === 'inbound' || x[1] === 'outbound')).toHaveLength(2);
    expect(reg.rows.slice(-3).map((x: any[]) => x[7])).toEqual(['100.00', '70.00', '30.00']);
    expect(reg.rows.some((x: any[]) => x[3] === 'Coral Hotels')).toBe(true);
  });
});

describe('journal vouchers: search, view and reverse', () => {
  it('lists with search and date filters and exposes the full voucher', async () => {
    expect(((await A.get('/accounting/journal?q=Rent')).body as any[]).map((x) => x.id)).toEqual([j2]);
    expect(((await A.get('/accounting/journal?from=2999-01-01')).body as any[])).toHaveLength(0);
    const v = (await A.get(`/accounting/journal/${j1}`)).body;
    expect(v).toMatchObject({ narration: 'Capital introduced', reversed_by_voucher: null }); expect(v.lines).toHaveLength(2); expect(v.created_by_name).toBe('Admin');
  });

  it('only finance roles may reverse; viewers can read', async () => {
    expect((await agent.post(`/accounting/journal/${j2}/reverse`, {})).status).toBe(403);
    expect((await viewer.post(`/accounting/journal/${j2}/reverse`, {})).status).toBe(403);
    expect((await viewer.get(`/accounting/journal/${j2}`)).status).toBe(200);
  });

  it('reversing needs no reason, mirrors the entry, cannot be repeated and cannot be reversed itself', async () => {
    const r = await fm.post(`/accounting/journal/${j2}/reverse`, {});
    expect(r.status).toBe(201);
    const tb = (await rep('trial-balance')).body;
    expect(tb.rows.some((x: any[]) => x[1] === 'Office Rent')).toBe(false);          // expense netted to zero
    expect(tb.reconcile[0].ok).toBe(true);
    const v = (await A.get(`/accounting/journal/${j2}`)).body;
    expect(v.reversed_by_voucher.id).toBe(r.body.id);
    expect((await A.get(`/accounting/journal/${r.body.id}`)).body.reversal_of_voucher.id).toBe(j2);
    expect((await A.post(`/accounting/journal/${j2}/reverse`, {})).status).toBe(409);
    expect((await A.post(`/accounting/journal/${r.body.id}/reverse`, {})).status).toBe(409);
    const list = (await A.get('/accounting/journal')).body as any[];
    expect(list.find((x) => x.id === j2).reversed_by).toBe(r.body.id);
    expect(list.find((x) => x.id === r.body.id)).toMatchObject({ reversal_of: j2 });          // the reversal is listed beside its original
    const ev = await sql("SELECT action FROM audit_log WHERE agency_id = ? AND entity = 'vouchers' AND entity_id = ?", [A.agencyId, j2]);
    expect(ev.length).toBeGreaterThan(0);
  });

  it('refuses to reverse an entry another module owns', async () => {
    const [bank] = await sql("SELECT id FROM accounts WHERE agency_id = ? AND type_code = 110 LIMIT 1", [A.agencyId]);
    const v = await sql("INSERT INTO vouchers (agency_id, voucher_type, voucher_no, voucher_date, ref_table, ref_id) VALUES (?, 'journal', 'JV-990001', ?, 'bank_transactions', 1)", [A.agencyId, today()]);
    expect((await A.post(`/accounting/journal/${(v as any).insertId}/reverse`, {})).status).toBe(409); void bank;
  });
});

describe('client-wise reports', () => {
  let alpha: number, beta: number, invA: number;
  const mkClient = async (name: string) => (await A.post('/clients', { name, email: `${name.replace(/\W/g, '')}@c.test`, currency: 'USD' })).body.id as number;
  const issue = async (client: number, cost: number) => {
    const r = await A.post('/invoices', { client_id: client, currency: 'USD', lines: [{ product_type: 'hotel', description: 'Trip', unit_cost: cost, markup_pct: 10, tax_rate: 0 }] });
    const id = r.body.inv.id as number; await A.post(`/invoices/${id}/status`, { status: 'reviewed' }); await A.post(`/invoices/${id}/issue`); return id;
  };
  beforeAll(async () => {
    alpha = await mkClient('Alpha Tours'); beta = await mkClient('Beta Voyages');
    invA = await issue(alpha, 100); await issue(alpha, 200); await issue(beta, 1000);
    const r = await A.post('/finance/receipts', { client_id: alpha, cash_account_id: cash, method: 'bank_transfer', amount: 110, allocations: [{ invoice_id: invA, amount: 110 }] });
    expect(r.status).toBe(201);
  });

  it('sales by client ranks clients and shows profit, receipts and what they still owe', async () => {
    const r = (await rep('sales-by-client')).body;
    expect(r.rows.map((x: any[]) => x[0])).toEqual(['Beta Voyages', 'Alpha Tours', 'Total']);
    expect(r.rows[0].slice(1)).toEqual([1, '1100.00', '1000.00', '100.00', '9.09', '0.00', '1100.00']);
    expect(r.rows[1].slice(1)).toEqual([2, '330.00', '300.00', '30.00', '9.09', '110.00', '220.00']);
    expect(r.rows[2].slice(1)).toEqual([3, '1430.00', '1300.00', '130.00', '9.09', '110.00', '1320.00']);
    expect(r.links[1]).toBe(`/reports?report=client-statement&client=${alpha}`);
    expect(r.reconcile[0]).toMatchObject({ ok: true });
  });

  it('sales by client respects the period', async () => {
    const r = (await A.get('/reports/sales-by-client?from=2020-01-01&to=2020-12-31')).body;
    expect(r.rows.every((x: any[]) => x[0] === 'Total' || x[2] === '0.00')).toBe(true);        // nothing was invoiced back then
  });

  it('client statement is that client’s ledger with a running balance', async () => {
    const r = (await rep('client-statement', `&client_id=${alpha}`)).body;
    expect(r.title).toMatch(/Alpha Tours/);
    expect(r.rows[r.rows.length - 1].slice(3)).toEqual(['330.00', '110.00', '220.00']);
    expect(r.reconcile[0]).toMatchObject({ ok: true });
    expect((await rep('client-statement')).status).toBe(400);
    expect((await rep('client-statement', '&client_id=99999999')).status).toBe(404);
    expect((await rep('client-statement', `&client_id=${alpha}`, B)).status).toBe(404);             // another agency's client
  });

  it('existing reports can be narrowed to one client', async () => {
    const all = (await rep('invoice-register')).body.rows, one = (await rep('invoice-register', `&client_id=${beta}`)).body;
    expect(all.length).toBeGreaterThan(one.rows.length); expect(one.rows).toHaveLength(1); expect(one.rows[0][1]).toBe('Beta Voyages'); expect(one.title).toMatch(/Beta Voyages/);
    const aging = (await rep('ar-aging-summary', `&client_id=${alpha}`)).body;
    expect(aging.rows.map((x: any[]) => x[0])).toEqual(['Alpha Tours']); expect(aging.reconcile).toBeUndefined();   // a one-client slice cannot tie to the whole ledger
    const pay = (await rep('payment-register', `&client_id=${alpha}`)).body;
    expect(pay.rows.filter((x: any[]) => x[1] === 'inbound')).toHaveLength(1);
    expect((await rep('payment-register', `&client_id=${beta}`)).body.rows.filter((x: any[]) => x[1] === 'inbound')).toHaveLength(0);
  });

  it('client reports are for finance roles and cannot be scheduled', async () => {
    for (const n of ['sales-by-client', 'client-statement']) expect((await rep(n, `&client_id=${alpha}`, agent)).status).toBe(403);
    const [me] = await sql('SELECT email FROM users WHERE id = ?', [A.userId]);
    const sched = (name: string, report: string) => A.post('/automation/schedules', { name, report, range_kind: 'mtd', frequency: 'daily', format: 'pdf', recipients: [me.email] });
    const no = await sched('CS', 'client-statement'); expect(no.status).toBe(400); expect(JSON.stringify(no.body)).toMatch(/report/i);
    const ok = await sched('SBC', 'sales-by-client');
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
  });
});

describe('account detail, access and isolation', () => {
  it('shows activity for an account and counts transactions in the list', async () => {
    const d = (await viewer.get(`/accounting/accounts/${cash}`)).body;
    expect(d).toMatchObject({ txns: 4, debit: 1310, credit: 200, nature: 'asset' }); expect(d.linked).toBeNull();
    const list = (await A.get('/accounting/accounts?q=Owner')).body as any[];
    expect(list[0]).toMatchObject({ name: 'Owner Capital', txns: 1 });
    expect((await A.get('/accounting/accounts/99999999')).status).toBe(404);
  });

  it('ledger statements are for finance roles only; agents are refused, other agencies see nothing', async () => {
    for (const n of ['trial-balance', 'balance-sheet', 'day-book', 'cash-book', 'payment-register', 'gl-pnl']) {
      expect((await rep(n, '', agent)).status).toBe(403);
      expect((await rep(n, '', viewer)).status).toBe(200);
    }
    expect((await rep('general-ledger', `&account_id=${cash}`, B)).status).toBe(404);
    expect((await rep('trial-balance', '', B)).body.rows).toHaveLength(1);
    expect((await A.get(`/accounting/accounts/${cash}`, ) ).status).toBe(200);
    expect((await B.get(`/accounting/accounts/${cash}`)).status).toBe(404);
  });

  it('new statements export to Excel and PDF-ready files like every other report', async () => {
    for (const [n, q] of [['trial-balance', ''], ['balance-sheet', ''], ['general-ledger', `&account_id=${cash}`]] as const) {
      const r = await rep(n, `${q}&format=xlsx`);
      expect(r.status).toBe(200); expect(r.body.url).toMatch(/reports/);
    }
  });

  it('parameterised reports cannot be scheduled', async () => {
    const r = await A.post('/automation/schedules', { name: 'GL', report: 'general-ledger', range_kind: 'mtd', frequency: 'daily', format: 'pdf', recipients: ['a@test.dev'] });
    expect(r.status).toBe(400);
  });
});
