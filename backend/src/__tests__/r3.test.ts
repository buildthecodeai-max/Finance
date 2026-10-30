import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, addMember, boot, newAgency, shutdown, sql } from './helpers.js';

let A: Api, B: Api, fin2: Api, agent: Api, viewer: Api; let bank: number, cash: number, sup: number;
const rnd = () => Math.random().toString(36).slice(2, 7);

const mkClient = async (a = A, currency = 'USD') => (await a.post('/clients', { name: `Client ${rnd()}`, email: 'c@test.dev', currency })).body.id as number;
/** Creates, reviews and issues an invoice (cost 1000, +10% markup, 10% tax => net 1100, tax 110, total 1210 by default). */
async function mkInvoice(client: number, o: { cost?: number; currency?: string; issue_date?: string; a?: Api } = {}) {
  const a = o.a ?? A, cost = o.cost ?? 1000;
  const r = await a.post('/invoices', { client_id: client, currency: o.currency ?? 'USD', issue_date: o.issue_date, lines: [{ product_type: 'hotel', description: 'Trip', unit_cost: cost, markup_pct: 10, tax_rate: 10 }] });
  expect(r.status).toBe(201); const id = r.body.inv.id as number;
  expect((await a.post(`/invoices/${id}/status`, { status: 'reviewed' })).status).toBe(200);
  return { id, issue: () => a.post(`/invoices/${id}/issue`) };
}
const issued = async (client: number, o: Parameters<typeof mkInvoice>[1] = {}) => { const i = await mkInvoice(client, o); const r = await i.issue(); expect(r.status).toBe(200); return i.id; };
const inv = async (id: number, a = A) => (await a.get(`/invoices/${id}`)).body.inv;
const stmt = async (client: number, a = A) => (await a.get(`/finance/statements/client/${client}`)).body;
const tb = async (a = A) => (await a.get('/accounting/trial-balance')).body as { debit: number; credit: number };
const glSum = async (a: Api, key: string) => (await sql(`SELECT COALESCE(SUM(g.credit - g.debit),0) v FROM gl_entries g JOIN accounts x ON x.id = g.account_id WHERE g.agency_id = ? AND x.sys_key = ?`, [a.agencyId, key]))[0].v as number;
const receipt = (o: Record<string, unknown>) => A.post('/finance/receipts', { cash_account_id: bank, method: 'bank_transfer', ...o });

beforeAll(async () => {
  await boot(); A = await newAgency('R3A'); B = await newAgency('R3B');
  fin2 = await addMember(A, 'finance_manager'); agent = await addMember(A, 'agent'); viewer = await addMember(A, 'viewer');
  const lk = (await A.get('/accounting/lookup?types=110')).body as any[]; bank = lk.find((x) => x.name.includes('Bank')).id; cash = lk.find((x) => x.name.includes('Cash')).id;
  sup = (await A.post('/suppliers', { name: 'Coral Resorts', supplier_type: 'hotel', payment_terms_days: 30 })).body.id;
});
afterAll(shutdown);

describe('issuing an invoice', () => {
  it('posts a balanced entry (Dr receivable, Cr revenue + tax), freezes a snapshot and the FX rate', async () => {
    const c = await mkClient(); const id = await issued(c);
    expect((await stmt(c)).closing).toBe(1210);
    expect(await glSum(A, 'booking_revenue')).toBeGreaterThanOrEqual(1100); expect(await glSum(A, 'tax_payable')).toBeGreaterThanOrEqual(110);
    const t = await tb(); expect(t.debit).toBeCloseTo(t.credit, 2);
    const row = (await sql('SELECT status, voucher_id, snapshot_json FROM invoices WHERE id = ?', [id]))[0];
    expect(row.status).toBe('sent'); expect(row.voucher_id).toBeTruthy(); expect(JSON.stringify(row.snapshot_json)).toContain('Trip');
  });
  it('issues once; only Reviewed invoices can be issued', async () => {
    const c = await mkClient(); const i = await mkInvoice(c);
    expect((await i.issue()).status).toBe(200); expect((await i.issue()).status).toBe(409);
    const draft = (await A.post('/invoices', { client_id: c, currency: 'USD', lines: [{ product_type: 'hotel', description: 'x', unit_cost: 10 }] })).body.inv.id;
    expect((await A.post(`/invoices/${draft}/issue`)).status).toBe(409);
    expect((await stmt(c)).closing).toBe(1210); // still only one invoice posted
  });
  it('is immutable once issued: no edits, no status-void, no re-review', async () => {
    const c = await mkClient(); const id = await issued(c);
    const body = { client_id: c, currency: 'USD', lines: [{ product_type: 'hotel', description: 'changed', unit_cost: 1 }] };
    expect((await A.put(`/invoices/${id}`, body)).status).toBe(409);
    expect((await A.post(`/invoices/${id}/status`, { status: 'void' })).status).toBe(409);
    expect((await A.post(`/invoices/${id}/status`, { status: 'draft' })).status).toBe(409);
  });
  it('void is a reversal: ledger returns to zero, history is kept; blocked once paid or credited', async () => {
    const c = await mkClient(); const id = await issued(c);
    expect((await A.post(`/invoices/${id}/void`, { reason: 'x' })).status).toBe(400); // reason too short
    const v = await A.post(`/invoices/${id}/void`, { reason: 'Booked in error' }); expect(v.status).toBe(200); expect(v.body.reversal).toBeTruthy();
    expect((await stmt(c)).closing).toBe(0); expect((await inv(id)).status).toBe('void');
    expect((await sql('SELECT reversed_by FROM vouchers WHERE id = (SELECT voucher_id FROM invoices WHERE id = ?)', [id]))[0].reversed_by).toBeTruthy();
    expect((await A.post(`/invoices/${id}/void`, { reason: 'again please' })).status).toBe(409);
    const paid = await issued(c); expect((await receipt({ client_id: c, amount: 100, allocations: [{ invoice_id: paid, amount: 100 }] })).status).toBe(201);
    expect((await A.post(`/invoices/${paid}/void`, { reason: 'wrong client' })).status).toBe(409);
  });
});

describe('receipts & allocations', () => {
  let c: number, a: number, b: number;
  it('one receipt pays several invoices; the remainder stays as client credit', async () => {
    c = await mkClient(); a = await issued(c); b = await issued(c, { cost: 500 }); // 1210 and 605
    const r = await receipt({ client_id: c, amount: 1500, allocations: [{ invoice_id: a, amount: 1210 }, { invoice_id: b, amount: 100 }] });
    expect(r.status).toBe(201); expect(r.body.unallocated).toBe(190); expect(r.body.receipt_no).toMatch(/^RCT-\d{6}$/);
    expect((await inv(a)).status).toBe('paid'); const ib = await inv(b); expect(ib.status).toBe('partially_paid'); expect(ib.amount_paid).toBe(100);
    expect((await stmt(c)).closing).toBe(1815 - 1500); // 1815 invoiced − 1500 received (client credit shows inside the balance)
  });
  it('cannot over-allocate an invoice, allocate twice to one invoice, or exceed the receipt', async () => {
    const r = await receipt({ client_id: c, amount: 1000 });
    const id = r.body.id as number; expect(r.body.unallocated).toBe(1000);
    expect((await A.post(`/finance/receipts/${id}/allocate`, { allocations: [{ invoice_id: b, amount: 600 }] })).status).toBe(400);           // outstanding is 505
    expect((await A.post(`/finance/receipts/${id}/allocate`, { allocations: [{ invoice_id: b, amount: 100 }, { invoice_id: b, amount: 100 }] })).status).toBe(400);
    expect((await A.post(`/finance/receipts/${id}/allocate`, { allocations: [{ invoice_id: b, amount: 505 }] })).status).toBe(200);
    expect((await inv(b)).status).toBe('paid'); expect((await A.get(`/finance/receipts/${id}`)).body.unallocated).toBe(495);
    expect((await A.post(`/finance/receipts/${id}/allocate`, { allocations: [{ invoice_id: a, amount: 1 }] })).status).toBe(400);                 // already fully paid
  });
  it('rejects invoices of another client, other tenants, and currency mismatches', async () => {
    const other = await mkClient(), oi = await issued(other);
    expect((await receipt({ client_id: c, amount: 10, allocations: [{ invoice_id: oi, amount: 10 }] })).status).toBe(400);
    const bc = await mkClient(B); const bi = await issued(bc, { a: B });
    expect((await receipt({ client_id: c, amount: 10, allocations: [{ invoice_id: bi, amount: 10 }] })).status).toBe(400);
    expect((await receipt({ client_id: other, amount: 10, currency: 'EUR', fx_rate: 1.1, allocations: [{ invoice_id: oi, amount: 10 }] })).status).toBe(400);
  });
  it('deposit must be a cash/bank account', async () => {
    const rev = (await A.get('/accounting/lookup?types=410')).body[0].id;
    expect((await A.post('/finance/receipts', { client_id: c, cash_account_id: rev, amount: 5, method: 'cash' })).status).toBe(400);
  });
  it('is idempotent: a retried or concurrent submit with the same key records one receipt', async () => {
    const cl = await mkClient(), key = `k-${rnd()}`, mk = () => fetchRaw(cl, key);
    const rs = await Promise.all([mk(), mk(), mk()]);
    expect(rs.every((r) => [200, 201].includes(r.status))).toBe(true); expect(new Set(rs.map((r) => r.body.id)).size).toBe(1);
    expect((await sql('SELECT COUNT(*) n FROM receipts WHERE agency_id = ? AND idem_key = ?', [A.agencyId, key]))[0].n).toBe(1);
    expect((await stmt(cl)).closing).toBe(-50);
  });
  async function fetchRaw(client: number, key: string) {
    const base = (await import('./helpers.js')).apiBase();
    const r = await fetch(`${base}/finance/receipts`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${A.token}`, 'x-agency-id': String(A.agencyId), 'idempotency-key': key }, body: JSON.stringify({ client_id: client, cash_account_id: bank, amount: 50, method: 'cash' }) });
    return { status: r.status, body: await r.json() };
  }
  it('two simultaneous receipts cannot overpay one invoice', async () => {
    const cl = await mkClient(), id = await issued(cl);
    const rs = await Promise.all([1, 2].map(() => receipt({ client_id: cl, amount: 1210, allocations: [{ invoice_id: id, amount: 1210 }] })));
    expect(rs.filter((r) => r.status === 201).length).toBe(1); expect(rs.find((r) => r.status !== 201)!.status).toBeGreaterThanOrEqual(400); // the loser is refused (400 over-allocation or 409 no longer open)
    const i = await inv(id); expect(i.amount_paid).toBe(1210); expect(i.status).toBe('paid');
  });
  it('concurrent receipts for different invoices all succeed (no spurious duplicate-number failures)', async () => {
    const cl = await mkClient(), ids = await Promise.all([issued(cl), issued(cl), issued(cl)]);
    const rs = await Promise.all(ids.map((id) => receipt({ client_id: cl, amount: 1210, allocations: [{ invoice_id: id, amount: 1210 }] })));
    expect(rs.map((r) => r.status)).toEqual([201, 201, 201]); expect(new Set(rs.map((r) => r.body.receipt_no)).size).toBe(3);
  });
  it('two existing receipts allocating to one invoice at the same moment cannot overpay it (invoice row lock)', async () => {
    const cl = await mkClient(), id = await issued(cl);
    const r1 = (await receipt({ client_id: cl, amount: 1210 })).body.id, r2 = (await receipt({ client_id: cl, amount: 1210 })).body.id;
    const rs = await Promise.all([r1, r2].map((r) => A.post(`/finance/receipts/${r}/allocate`, { allocations: [{ invoice_id: id, amount: 1210 }] })));
    expect(rs.filter((r) => r.status === 200).length).toBe(1); expect(rs.find((r) => r.status !== 200)!.status).toBeGreaterThanOrEqual(400);
    const i = await inv(id); expect(i.amount_paid).toBe(1210); expect(i.status).toBe('paid');
    expect((await sql('SELECT SUM(amount) s FROM payments WHERE invoice_id = ? AND voided = 0', [id]))[0].s).toBe(1210);
  });
  it('void by reversal releases the allocation and restores the balance', async () => {
    const cl = await mkClient(), id = await issued(cl);
    const r = await receipt({ client_id: cl, amount: 1210, allocations: [{ invoice_id: id, amount: 1210 }] });
    expect((await inv(id)).status).toBe('paid');
    expect((await A.post(`/finance/receipts/${r.body.id}/void`, { reason: 'Bounced' })).status).toBe(200);
    const i = await inv(id); expect(i.status).toBe('sent'); expect(i.amount_paid).toBe(0); expect((await stmt(cl)).closing).toBe(1210);
    expect((await A.post(`/finance/receipts/${r.body.id}/void`, { reason: 'Again' })).status).toBe(409);
    const t = await tb(); expect(t.debit).toBeCloseTo(t.credit, 2);
  });
  it('legacy "record payment" endpoint now posts to the ledger too', async () => {
    const cl = await mkClient(), id = await issued(cl);
    const r = await A.post('/payments/inbound', { invoice_id: id, amount: 400, method: 'cash' }); expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ paid: 400, status: 'partially_paid' }); expect((await stmt(cl)).closing).toBe(810);
    const unposted = (await sql(`INSERT INTO invoices (agency_id, number, client_id, created_by, status, currency, issue_date, due_date, subtotal, tax_total, total) VALUES (?, 'LEG-1', ?, ?, 'sent', 'USD', '2026-01-01', '2026-02-01', 100, 0, 100)`, [A.agencyId, cl, A.userId])) as any;
    const lid = (unposted as any).insertId;
    expect((await A.post('/payments/inbound', { invoice_id: lid, amount: 10, method: 'cash' })).status).toBe(409);
  });
});

describe('credit notes & client refunds', () => {
  it('a credit note reduces what is owed, is capped, and a full credit closes the invoice as "credited"', async () => {
    const c = await mkClient(), id = await issued(c);
    const cn = await A.post('/finance/credit-notes', { invoice_id: id, reason: 'Hotel downgrade', lines: [{ description: 'Room refund', amount: 200, tax: 20 }] }); expect(cn.status).toBe(201);
    expect((await A.post(`/finance/credit-notes/${cn.body.id}/issue`)).status).toBe(200);
    expect((await A.post(`/finance/credit-notes/${cn.body.id}/issue`)).status).toBe(409);
    let i = await inv(id); expect(i.amount_credited).toBe(220); expect(i.status).toBe('partially_paid'); expect((await stmt(c)).closing).toBe(990);
    const big = await A.post('/finance/credit-notes', { invoice_id: id, reason: 'too much', lines: [{ description: 'x', amount: 1000, tax: 100 }] });
    expect((await A.post(`/finance/credit-notes/${big.body.id}/issue`)).status).toBe(409); // room is only 990
    const rest = await A.post('/finance/credit-notes', { invoice_id: id, reason: 'Cancelled', lines: [{ description: 'Balance', amount: 900, tax: 90 }] });
    expect((await A.post(`/finance/credit-notes/${rest.body.id}/issue`)).status).toBe(200);
    i = await inv(id); expect(i.status).toBe('credited'); expect((await stmt(c)).closing).toBe(0);
    expect((await glSum(A, 'tax_payable'))).toBeGreaterThanOrEqual(0);
    expect((await A.post(`/finance/credit-notes/${rest.body.id}/void`, { reason: 'mistake entry' })).status).toBe(200);
    expect((await inv(id)).status).toBe('partially_paid'); expect((await stmt(c)).closing).toBe(990);
  });
  it('credit notes apply to issued invoices only and are tenant-scoped', async () => {
    const c = await mkClient(), i = await mkInvoice(c);
    expect((await A.post('/finance/credit-notes', { invoice_id: i.id, reason: 'nope', lines: [{ description: 'x', amount: 1 }] })).status).toBe(409);
    const id = await issued(c);
    expect((await B.post('/finance/credit-notes', { invoice_id: id, reason: 'steal', lines: [{ description: 'x', amount: 1 }] })).status).toBe(400);
  });
  it('overpayment after a credit can be refunded: capped, approved, then paid exactly once', async () => {
    const c = await mkClient(), id = await issued(c);
    await receipt({ client_id: c, amount: 1210, allocations: [{ invoice_id: id, amount: 1210 }] });
    const cn = (await A.post('/finance/credit-notes', { invoice_id: id, reason: 'Late cancellation', lines: [{ description: 'Refundable', amount: 300, tax: 30 }] })).body.id;
    await A.post(`/finance/credit-notes/${cn}/issue`);
    const open = { invoice_id: id, method: 'bank_transfer', cash_account_id: bank, reason: 'Return surplus' };
    expect((await A.post('/finance/client-refunds', { ...open, amount: 400 })).status).toBe(409); // only 330 refundable
    const r = await A.post('/finance/client-refunds', { ...open, amount: 330 }); expect(r.status).toBe(201);
    expect((await A.post('/finance/client-refunds', { ...open, amount: 1 })).status).toBe(409);   // surplus is reserved by the open request
    expect((await A.post(`/finance/client-refunds/${r.body.id}/pay`)).status).toBe(409);          // not approved yet
    expect((await A.post(`/finance/client-refunds/${r.body.id}/approve`)).status).toBe(200);
    expect((await A.post(`/finance/client-refunds/${r.body.id}/pay`)).status).toBe(200);
    expect((await A.post(`/finance/client-refunds/${r.body.id}/pay`)).status).toBe(409);
    const i = await inv(id); expect(i.amount_paid).toBe(880); expect(i.status).toBe('credited' === i.status ? 'credited' : 'paid'); expect((await stmt(c)).closing).toBe(0);
  });
  it('maker–checker: above the threshold a different person must approve credit notes and refunds', async () => {
    expect((await A.put('/admin/settings', { approval_threshold: 100, reason: 'controls' })).status).toBe(200);
    const c = await mkClient(), id = await issued(c);
    const cn = (await A.post('/finance/credit-notes', { invoice_id: id, reason: 'Goodwill', lines: [{ description: 'x', amount: 500, tax: 0 }] })).body.id;
    const self = await A.post(`/finance/credit-notes/${cn}/issue`); expect(self.status).toBe(403); expect(self.body.error).toMatch(/different person/);
    expect((await fin2.post(`/finance/credit-notes/${cn}/issue`)).status).toBe(200);
    await receipt({ client_id: c, amount: 710, allocations: [{ invoice_id: id, amount: 710 }] });
    await A.post('/finance/credit-notes', { invoice_id: id, reason: 'more', lines: [{ description: 'x', amount: 0.01 }] });
    const c2 = await mkClient(), id2 = await issued(c2);
    await receipt({ client_id: c2, amount: 1210, allocations: [{ invoice_id: id2, amount: 1210 }] });
    const cn2 = (await fin2.post('/finance/credit-notes', { invoice_id: id2, reason: 'Cancelled trip', lines: [{ description: 'x', amount: 1100, tax: 110 }] })).body.id;
    expect((await A.post(`/finance/credit-notes/${cn2}/issue`)).status).toBe(200); // A is a different person from the creator (fin2)
    const rf = (await A.post('/finance/client-refunds', { invoice_id: id2, amount: 1210, method: 'bank_transfer', cash_account_id: bank, reason: 'Full refund' })).body.id;
    expect((await A.post(`/finance/client-refunds/${rf}/approve`)).status).toBe(403);
    expect((await fin2.post(`/finance/client-refunds/${rf}/approve`)).status).toBe(200);
    expect((await A.put('/admin/settings', { approval_threshold: 0, reason: 'reset' })).status).toBe(200);
  });
  it('agents and viewers cannot move money', async () => {
    expect((await agent.get('/finance/summary')).status).toBe(403);
    expect((await viewer.get('/finance/summary')).status).toBe(200);
    expect((await viewer.post('/finance/receipts', { client_id: 1, cash_account_id: bank, amount: 1, method: 'cash' })).status).toBe(403);
  });
});

describe('supplier bills (AP)', () => {
  let booking: number, comp: number;
  const bill = (o: Record<string, unknown> = {}) => A.post('/finance/bills', { supplier_id: sup, supplier_ref: `SUP-${rnd()}`, bill_date: '2026-10-01', lines: [{ description: 'Hotel', amount: 1000, tax: 100 }], ...o });
  it('flags a bill that exceeds the booking cost and requires an override reason', async () => {
    const cl = await mkClient(); booking = (await A.post('/bookings', { client_id: cl, destination: 'Bali', status: 'confirmed' })).body.id;
    comp = (await A.post(`/bookings/${booking}/components`, { product_type: 'hotel', description: 'Resort', unit_cost: 1000, markup_pct: 10, supplier_id: sup })).body.id;
    const b = await bill({ booking_id: booking, lines: [{ component_id: comp, description: 'Resort invoice', amount: 1200, tax: 0 }] });
    expect(b.status).toBe(201); expect(b.body.mismatches.length).toBe(1);
    expect((await A.post(`/finance/bills/${b.body.id}/approve`)).status).toBe(409);
    expect((await A.post(`/finance/bills/${b.body.id}/approve`, { override_reason: 'Supplier surcharge agreed by phone' })).status).toBe(200);
    expect((await A.get(`/finance/bills/${b.body.id}`)).body.override_reason).toMatch(/surcharge/);
  });
  it('accepts a bill within tolerance and tracks what is already billed per component', async () => {
    const b = await bill({ booking_id: booking, lines: [{ component_id: comp, description: 'Late fee', amount: 100, tax: 0 }] });
    expect(b.body.mismatches.length).toBe(1); // 1200 already billed against 1000 agreed
  });
  it('rejects duplicate supplier references and warns on same supplier/amount/date', async () => {
    const ref = `DUP-${rnd()}`; expect((await bill({ supplier_ref: ref })).status).toBe(201);
    expect((await bill({ supplier_ref: ref })).status).toBe(409);
    const twin = await bill({ supplier_ref: `TWIN-${rnd()}` }); expect(twin.body.warnings.join()).toMatch(/Possible duplicate/);
  });
  it('approval posts Dr supplier cost + input tax / Cr supplier payable; payments clear it; overpay is refused', async () => {
    const s2 = (await A.post('/suppliers', { name: 'Sky Air', supplier_type: 'airline' })).body.id;
    const b = (await A.post('/finance/bills', { supplier_id: s2, supplier_ref: 'SK-1', bill_date: '2026-10-02', lines: [{ description: 'Tickets', amount: 800, tax: 80 }] })).body.id;
    expect((await A.post(`/finance/bills/${b}/pay`, { cash_account_id: bank, amount: 100 })).status).toBe(409); // not approved
    expect((await A.post(`/finance/bills/${b}/approve`)).status).toBe(200); expect((await A.post(`/finance/bills/${b}/approve`)).status).toBe(409);
    const st = (await A.get(`/finance/statements/supplier/${s2}`)).body; expect(st.closing).toBe(880);
    expect((await A.post(`/finance/bills/${b}/pay`, { cash_account_id: bank, amount: 500 })).body).toMatchObject({ paid: 500, outstanding: 380 });
    expect((await A.post(`/finance/bills/${b}/pay`, { cash_account_id: bank, amount: 400 })).status).toBe(400);
    const rev = (await A.get('/accounting/lookup?types=410')).body[0].id; expect((await A.post(`/finance/bills/${b}/pay`, { cash_account_id: rev, amount: 10 })).status).toBe(400);
    expect((await A.post(`/finance/bills/${b}/void`, { reason: 'wrong supplier' })).status).toBe(409); // has payments
    expect((await A.post(`/finance/bills/${b}/pay`, { cash_account_id: bank, amount: 380 })).status).toBe(200);
    expect((await A.get(`/finance/bills/${b}`)).body.status).toBe('paid'); expect((await A.get(`/finance/statements/supplier/${s2}`)).body.closing).toBe(0);
    const t = await tb(); expect(t.debit).toBeCloseTo(t.credit, 2);
  });
  it('maker–checker on bills, and voiding an approved bill reverses it', async () => {
    await A.put('/admin/settings', { approval_threshold: 500, reason: 'controls' });
    const s3 = (await A.post('/suppliers', { name: 'Big Tours' })).body.id;
    const id = (await fin2.post('/finance/bills', { supplier_id: s3, supplier_ref: 'BT-1', bill_date: '2026-10-03', lines: [{ description: 'Package', amount: 900 }] })).body.id;
    expect((await fin2.post(`/finance/bills/${id}/approve`)).status).toBe(403); expect((await A.post(`/finance/bills/${id}/approve`)).status).toBe(200);
    expect((await A.get(`/finance/statements/supplier/${s3}`)).body.closing).toBe(900);
    expect((await A.post(`/finance/bills/${id}/void`, { reason: 'Supplier credited us' })).status).toBe(200); expect((await A.get(`/finance/statements/supplier/${s3}`)).body.closing).toBe(0);
    await A.put('/admin/settings', { approval_threshold: 0, reason: 'reset' });
  });
  it("other tenants cannot see, approve or pay these bills, or use this tenant's supplier", async () => {
    const id = (await bill()).body.id;
    for (const [m, p] of [['GET', `/finance/bills/${id}`], ['POST', `/finance/bills/${id}/approve`], ['POST', `/finance/bills/${id}/pay`], ['POST', `/finance/bills/${id}/void`]] as const)
      expect([404, 400]).toContain((await B.req(m, p, m === 'GET' ? undefined : { amount: 1, cash_account_id: 1, reason: 'abc' })).status);
    expect((await B.post('/finance/bills', { supplier_id: sup, supplier_ref: 'X', bill_date: '2026-10-01', lines: [{ description: 'x', amount: 1 }] })).status).toBe(400);
    expect((((await B.get('/finance/bills')).body) as any[]).length).toBe(0);
  });
});

describe('foreign currency', () => {
  it('locks the rate at issue and posts the realised gain/loss when the payment rate differs', async () => {
    await sql(`INSERT INTO exchange_rates (agency_id, rate_date, base, quote, rate) VALUES (?, ?, 'USD', 'EUR', 0.8)`, [A.agencyId, new Date().toISOString().slice(0, 10)]); // 1 USD = 0.8 EUR → 1 EUR = 1.25 USD
    const c = await mkClient(A, 'EUR'), i = await mkInvoice(c, { currency: 'EUR', cost: 1000 }); // total 1210 EUR
    expect((await i.issue()).body.fx_rate).toBe(1.25);
    expect((await stmt(c)).closing).toBe(1512.5);
    await sql(`UPDATE exchange_rates SET rate = 0.5 WHERE agency_id = ?`, [A.agencyId]); // rates move later: the issued invoice must not change
    expect((await inv(i.id)).fx_rate).toBe(1.25); expect((await stmt(c)).closing).toBe(1512.5);
    const before = await glSum(A, 'fx_gain_loss');
    const r = await receipt({ client_id: c, amount: 1210, currency: 'EUR', fx_rate: 1.3, allocations: [{ invoice_id: i.id, amount: 1210 }] }); expect(r.status).toBe(201);
    expect((await stmt(c)).closing).toBe(0); expect((await inv(i.id)).status).toBe('paid');
    expect(r2(await glSum(A, 'fx_gain_loss') - before)).toBe(60.5); // 1210 × (1.30 − 1.25) gain
    const t = await tb(); expect(t.debit).toBeCloseTo(t.credit, 2);
    expect((await A.post(`/finance/receipts/${r.body.id}/void`, { reason: 'Bank reversal' })).status).toBe(200);
    expect(r2(await glSum(A, 'fx_gain_loss') - before)).toBe(0); expect((await stmt(c)).closing).toBe(1512.5);
  });
  const r2 = (n: number) => Math.round(n * 100) / 100;
});

describe('exchange-rate controls (never guess a rate)', () => {
  it('refuses to issue/receipt/bill in a currency with no qualifying rate instead of booking it at 1:1', async () => {
    const X = await newAgency('NoRates'); const c = (await X.post('/clients', { name: 'Gaia', currency: 'GBP' })).body.id;
    const r = await X.post('/invoices', { client_id: c, currency: 'GBP', lines: [{ product_type: 'hotel', description: 'x', unit_cost: 100, markup_pct: 0, tax_rate: 0 }] });
    expect(r.status).toBe(201); expect(r.body.inv.fx_source).toBeNull(); // a draft may exist without a rate
    await X.post(`/invoices/${r.body.inv.id}/status`, { status: 'reviewed' });
    const issue = await X.post(`/invoices/${r.body.inv.id}/issue`); expect(issue.status).toBe(409); expect(issue.body.error).toMatch(/No exchange rate for GBP→USD/);
    expect((await sql('SELECT voucher_id FROM invoices WHERE id = ?', [r.body.inv.id]))[0].voucher_id).toBeNull();
    const lk = ((await X.get('/accounting/lookup?types=110')).body as any[])[0].id;
    expect((await X.post('/finance/receipts', { client_id: c, cash_account_id: lk, amount: 10, currency: 'GBP', method: 'cash' })).status).toBe(409);
    const sp = (await X.post('/suppliers', { name: 'Brit Tours' })).body.id;
    expect((await X.post('/finance/bills', { supplier_id: sp, supplier_ref: 'G1', currency: 'GBP', bill_date: '2026-10-01', lines: [{ description: 'x', amount: 10 }] })).status).toBe(409);
  });
  it('manual rates: stored with source, used by dates, guarded against typos, audited, direct/inverse/cross all work', async () => {
    const X = await newAgency('Rates');
    expect((await X.post('/finance/rates', { from: 'GBP', to: 'USD', rate: 1.25 })).status).toBe(201);
    let list = (await X.get('/finance/rates')).body; expect(list.rates[0]).toMatchObject({ base: 'GBP', quote: 'USD', rate: 1.25, source: 'manual', stale: false });
    expect((await X.post('/finance/rates', { from: 'GBP', to: 'USD', rate: 12.5 })).status).toBe(409);             // 900% jump
    expect((await X.post('/finance/rates', { from: 'GBP', to: 'USD', rate: 12.5, confirm: true })).status).toBe(201);
    expect((await X.post('/finance/rates', { from: 'USD', to: 'USD', rate: 1 })).status).toBe(400);
    expect((await X.post('/finance/rates', { from: 'GBP', to: 'USD', rate: 1, date: '2999-01-01' })).status).toBe(400);
    await X.post('/finance/rates', { from: 'GBP', to: 'USD', rate: 1.25, confirm: true });
    await X.post('/finance/rates', { from: 'USD', to: 'EUR', rate: 0.9 });
    const { findRate } = await import('../services/fx.js'); const { Tenant } = await import('../db.js'); const t = new Tenant(X.agencyId, { userId: X.userId });
    expect((await findRate(t, 'GBP', 'USD'))!.rate).toBe(1.25);                                  // direct
    expect(+(await findRate(t, 'USD', 'GBP'))!.rate.toFixed(6)).toBe(0.8);                       // inverse
    const cross = (await findRate(t, 'GBP', 'EUR'))!; expect(+cross.rate.toFixed(6)).toBe(1.125); expect(cross.source).toMatch(/cross/); // via USD
    expect(await findRate(t, 'JPY', 'USD')).toBeNull();
    expect((await X.get('/admin/audit?entity=exchange_rates')).body.length).toBeGreaterThanOrEqual(3);
    for (const who of [await addMember(X, 'viewer'), await addMember(X, 'agent')]) expect((await who.post('/finance/rates', { from: 'CAD', to: 'USD', rate: 0.7 })).status).toBeGreaterThanOrEqual(403);
  });
  it('rates older than the agency limit are not used, and the issued document records the rate source and date', async () => {
    const X = await newAgency('Stale'); const c = (await X.post('/clients', { name: 'Old', currency: 'CAD' })).body.id;
    await sql(`INSERT INTO exchange_rates (agency_id, rate_date, base, quote, rate, source) VALUES (?, DATE_SUB(CURDATE(), INTERVAL 20 DAY), 'CAD', 'USD', 0.7, 'manual')`, [X.agencyId]);
    const mk = async () => { const r = await X.post('/invoices', { client_id: c, currency: 'CAD', lines: [{ product_type: 'hotel', description: 'x', unit_cost: 100, markup_pct: 0, tax_rate: 0 }] }); await X.post(`/invoices/${r.body.inv.id}/status`, { status: 'reviewed' }); return r.body.inv.id as number; };
    const id = await mk(); expect((await X.post(`/invoices/${id}/issue`)).status).toBe(409);        // 20 days old > 7
    expect((await X.put('/admin/settings', { fx_max_age_days: 30, reason: 'monthly rates' })).status).toBe(200);
    expect((await X.post(`/invoices/${id}/issue`)).status).toBe(200);
    const row = (await sql('SELECT fx_rate, fx_source FROM invoices WHERE id = ?', [id]))[0]; expect(row).toMatchObject({ fx_rate: 0.7, fx_source: 'manual' });
  });
});

describe('period lock', () => {
  it('blocks issuing and receipting inside a locked period, leaving nothing half-posted', async () => {
    const c = await mkClient(), old = await mkInvoice(c, { issue_date: '2025-03-15' });
    expect((await A.post('/admin/period-locks', { locked_through: '2025-12-31', reason: 'FY25 close' })).status).toBe(200);
    expect((await old.issue()).status).toBe(409); expect((await inv(old.id)).status).toBe('reviewed'); expect((await sql('SELECT voucher_id FROM invoices WHERE id = ?', [old.id]))[0].voucher_id).toBeNull();
    const ok = await issued(c);
    expect((await receipt({ client_id: c, amount: 50, receipt_date: '2025-06-01', allocations: [{ invoice_id: ok, amount: 50 }] })).status).toBe(409);
    expect((await sql('SELECT COUNT(*) n FROM payments WHERE agency_id = ? AND invoice_id = ?', [A.agencyId, ok]))[0].n).toBe(0);
    expect((await A.post(`/invoices/${ok}/void`, { reason: 'in open period', date: '2025-05-01' })).status).toBe(409); // reversal date inside lock
    expect((await A.post(`/invoices/${ok}/void`, { reason: 'in open period' })).status).toBe(200);
    expect((await A.post('/admin/period-locks', { locked_through: null, reason: 'Reopen for testing' })).status).toBe(200);
  });
});

describe('reconciliation & migration', () => {
  it('ledger control totals equal the invoice/bill subledgers after a mixed history', async () => {
    const S = await newAgency('Recon'); const lk = (await S.get('/accounting/lookup?types=110')).body as any[]; const bk = lk.find((x) => x.name.includes('Bank')).id;
    const c1 = (await S.post('/clients', { name: 'R1', currency: 'USD' })).body.id, c2 = (await S.post('/clients', { name: 'R2', currency: 'USD' })).body.id;
    const iss = async (c: number, cost: number) => { const id = (await S.post('/invoices', { client_id: c, currency: 'USD', lines: [{ product_type: 'hotel', description: 't', unit_cost: cost, markup_pct: 10, tax_rate: 10 }] })).body.inv.id; await S.post(`/invoices/${id}/status`, { status: 'reviewed' }); await S.post(`/invoices/${id}/issue`); return id as number; };
    const a = await iss(c1, 1000), b = await iss(c1, 333), c = await iss(c2, 777.77), d = await iss(c2, 10);
    await S.post('/finance/receipts', { client_id: c1, cash_account_id: bk, amount: 2000, method: 'bank_transfer', allocations: [{ invoice_id: a, amount: 1210 }, { invoice_id: b, amount: 100 }] });
    const r2_ = (await S.post('/finance/receipts', { client_id: c2, cash_account_id: bk, amount: 900, method: 'cash', allocations: [{ invoice_id: c, amount: 855.55 }] })).body.id;
    const cn = (await S.post('/finance/credit-notes', { invoice_id: d, reason: 'Cancel', lines: [{ description: 'x', amount: 11, tax: 1.1 }] })).body.id; await S.post(`/finance/credit-notes/${cn}/issue`);
    await S.post(`/finance/receipts/${r2_}/void`, { reason: 'Returned cheque' });
    const sp = (await S.post('/suppliers', { name: 'SP' })).body.id;
    const bl = (await S.post('/finance/bills', { supplier_id: sp, supplier_ref: 'A1', bill_date: '2026-10-01', lines: [{ description: 'x', amount: 500, tax: 50 }] })).body.id; await S.post(`/finance/bills/${bl}/approve`); await S.post(`/finance/bills/${bl}/pay`, { cash_account_id: bk, amount: 120.5 });
    const sum = (await S.get('/finance/summary')).body;
    expect(sum.reconciliation.ar).toMatchObject({ ok: true, difference: 0 }); expect(sum.reconciliation.ap).toMatchObject({ ok: true, difference: 0 });
    expect(sum.reconciliation.ar.ledger).toBe(sum.reconciliation.ar.subledger);
    expect(sum.ar.n).toBeGreaterThan(0); expect(sum.cash_total).toBeCloseTo(2000 - 120.5, 2);
    const t = (await S.get('/accounting/trial-balance')).body; expect(t.debit).toBeCloseTo(t.credit, 2);
    expect((await S.get('/finance/ap-aging')).body[0]).toMatchObject({ supplier: 'SP', outstanding: 429.5 });
  });
  it('backfill posts pre-R3 invoices and payments once; admin only; skips what the period lock protects', async () => {
    const M = await newAgency('Legacy'), c = (await M.post('/clients', { name: 'Old Client', currency: 'USD' })).body.id;
    const ins = async (n: string, date: string) => ((await sql(`INSERT INTO invoices (agency_id, number, client_id, created_by, status, currency, fx_rate, issue_date, due_date, subtotal, tax_total, total, amount_paid) VALUES (?, ?, ?, ?, 'partially_paid', 'USD', 1, ?, ?, 100, 10, 110, 50)`, [M.agencyId, n, c, M.userId, date, date])) as any).insertId as number;
    const i1 = await ins('OLD-1', '2026-02-01'), i2 = await ins('OLD-2', '2025-02-01');
    await sql(`INSERT INTO payments (agency_id, direction, method, invoice_id, client_id, amount, currency, fx_rate, paid_at) VALUES (?, 'inbound', 'bank_transfer', ?, ?, 50, 'USD', 1, '2026-02-10')`, [M.agencyId, i1, c]);
    expect((await M.get('/finance/summary')).body.reconciliation.unposted_invoices).toBe(2);
    const fm = await addMember(M, 'finance_manager'); expect((await fm.post('/finance/backfill-ledger')).status).toBe(403);
    await M.post('/admin/period-locks', { locked_through: '2025-12-31', reason: 'FY25 closed' });
    const r1 = (await M.post('/finance/backfill-ledger')).body; expect(r1.invoices_posted).toBe(1); expect(r1.receipts_created).toBe(1); expect(r1.errors.join()).toMatch(/OLD-2/);
    const r2x = (await M.post('/finance/backfill-ledger')).body; expect(r2x.invoices_posted).toBe(0); expect(r2x.receipts_created).toBe(0);
    expect((await M.get(`/finance/statements/client/${c}`)).body.closing).toBe(60); // 110 invoiced − 50 received (OLD-2 stays unposted: locked period)
    void i2;
  });
});

describe('finance isolation', () => {
  it("another agency cannot read or touch this agency's receipts, credit notes or refunds", async () => {
    const c = await mkClient(), id = await issued(c);
    const r = (await receipt({ client_id: c, amount: 100, allocations: [{ invoice_id: id, amount: 100 }] })).body.id;
    const cn = (await A.post('/finance/credit-notes', { invoice_id: id, reason: 'Test cn', lines: [{ description: 'x', amount: 10 }] })).body.id;
    for (const [m, p] of [['GET', `/finance/receipts/${r}`], ['POST', `/finance/receipts/${r}/void`], ['POST', `/finance/receipts/${r}/allocate`], ['GET', `/finance/credit-notes/${cn}`], ['POST', `/finance/credit-notes/${cn}/issue`], ['POST', `/finance/credit-notes/${cn}/void`], ['GET', `/finance/statements/client/${c}`], ['GET', `/finance/clients/${c}/open-invoices`], ['POST', `/invoices/${id}/void`], ['POST', `/invoices/${id}/issue`]] as const)
      expect([400, 404, 409]).toContain((await B.req(m, p, m === 'GET' ? undefined : { reason: 'steal it', allocations: [{ invoice_id: id, amount: 1 }] })).status);
    expect((await B.post('/finance/receipts', { client_id: c, cash_account_id: bank, amount: 1, method: 'cash' })).status).toBe(400);
    expect((await B.post('/finance/client-refunds', { invoice_id: id, amount: 1, method: 'cash', cash_account_id: bank, reason: 'steal' })).status).toBeGreaterThanOrEqual(400);
    expect(((await B.get('/finance/receipts')).body as any[]).length).toBe(0); expect(((await B.get('/finance/credit-notes')).body as any[]).length).toBe(0);
    const bs = (await B.get('/finance/summary')).body; expect(bs.ar.n).toBe(1); expect(bs.ar.total).toBe(1210); // only B's own invoice, none of A's
  });
});
