import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, addMember, boot, newAgency, shutdown, sql } from './helpers.js';

let A: Api, B: Api, approver: Api, agent: Api, viewer: Api; let bank: number, supOk: number, supNoBank: number;
const rnd = () => Math.random().toString(36).slice(2, 7);
const GOOD = { account_name: 'Coral', routing: '021000021', account_number: '123456789' };

async function mkBill(o: { supplier?: number; amount?: number; a?: Api; approve?: boolean } = {}) {
  const a = o.a ?? A;
  const r = await a.post('/finance/bills', { supplier_id: o.supplier ?? supOk, supplier_ref: `S-${rnd()}${rnd()}`, bill_date: '2026-10-01', lines: [{ description: 'Hotel', amount: o.amount ?? 500, tax: 0 }] });
  expect(r.status).toBe(201);
  if (o.approve !== false) expect((await a.post(`/finance/bills/${r.body.id}/approve`)).status).toBe(200);
  return r.body.id as number;
}
const mkRun = (bills: number[], o: Record<string, unknown> = {}, a = A) => a.post('/finance/payment-runs', { currency: 'USD', bank_account_id: bank, items: bills.map((bill_id) => ({ bill_id })), ...o });
const detail = async (id: number, a = A) => (await a.get(`/finance/payment-runs/${id}`)).body;
const billRow = async (id: number) => (await sql('SELECT status, amount_paid FROM supplier_bills WHERE id = ?', [id]))[0];
/** draft → validated → submitted (by A) → approved (by the second person). */
async function approved(bills: number[]) {
  const id = (await mkRun(bills)).body.id as number;
  expect((await A.post(`/finance/payment-runs/${id}/validate`)).status).toBe(200);
  expect((await A.post(`/finance/payment-runs/${id}/submit`)).status).toBe(200);
  expect((await approver.post(`/finance/payment-runs/${id}/approve`)).status).toBe(200);
  return id;
}

beforeAll(async () => {
  await boot(); A = await newAgency('R4RunsA'); B = await newAgency('R4RunsB');
  approver = await addMember(A, 'finance_manager'); agent = await addMember(A, 'agent'); viewer = await addMember(A, 'viewer');
  bank = ((await A.get('/accounting/lookup?types=110')).body as any[]).find((x) => x.name.includes('Bank')).id;
  supOk = (await A.post('/suppliers', { name: 'Coral Resorts', supplier_type: 'hotel', bank_details: GOOD })).body.id;
  supNoBank = (await A.post('/suppliers', { name: 'Cash Only Tours', supplier_type: 'tour_operator' })).body.id; expect(supNoBank).toBeTruthy(); expect(supOk).toBeTruthy();
});
afterAll(shutdown);

describe('payment run lifecycle', () => {
  it('goes draft → validated → submitted → approved → exported without paying anything, then settles through the ledger', async () => {
    const [b1, b2] = [await mkBill({ amount: 500 }), await mkBill({ amount: 250 })];
    const id = (await mkRun([b1, b2])).body.id;
    expect((await detail(id)).run.status).toBe('draft'); expect((await detail(id)).run.total).toBe(750);
    expect((await A.get(`/finance/payment-runs/${id}/bank-file?format=csv`)).status).toBe(409);          // not approved
    expect((await A.post(`/finance/payment-runs/${id}/submit`)).status).toBe(409);                        // not validated
    expect((await A.post(`/finance/payment-runs/${id}/validate`)).status).toBe(200);
    expect((await A.post(`/finance/payment-runs/${id}/submit`)).status).toBe(200);
    expect((await A.post(`/finance/payment-runs/${id}/approve`)).status).toBe(403);                       // creator/submitter cannot self-approve
    expect((await approver.post(`/finance/payment-runs/${id}/approve`)).status).toBe(200);
    expect((await A.post(`/finance/payment-runs/${id}/settle`, { results: [{ item_id: 1, outcome: 'paid', settlement_ref: 'X' }] })).status).toBe(409); // approved ≠ exported

    const glBefore = (await sql('SELECT COUNT(*) n FROM gl_entries WHERE agency_id = ?', [A.agencyId]))[0].n;
    const f = await A.get(`/finance/payment-runs/${id}/bank-file?format=ach`);
    expect(f.status).toBe(200); expect(String(f.body)).toContain('0000075000');
    const d = await detail(id);
    expect(d.run.status).toBe('exported'); expect(d.run.export_checksum).toMatch(/^[0-9a-f]{64}$/);
    expect((await billRow(b1)).status).toBe('approved');                                                  // export did NOT pay
    expect((await sql('SELECT COUNT(*) n FROM gl_entries WHERE agency_id = ?', [A.agencyId]))[0].n).toBe(glBefore);
    expect((await sql('SELECT COUNT(*) n FROM payments WHERE run_id = ?', [id]))[0].n).toBe(0);

    expect((await approver.post(`/finance/payment-runs/${id}/processing`)).status).toBe(200);
    const [i1, i2] = d.items.map((i: any) => i.id);
    expect((await A.post(`/finance/payment-runs/${id}/settle`, { results: [{ item_id: i1, outcome: 'paid' }] })).status).toBe(400);   // no evidence
    expect((await A.post(`/finance/payment-runs/${id}/settle`, { results: [{ item_id: i1, outcome: 'paid', manual_reason: 'ok' }] })).status).toBe(400);
    const s = await A.post(`/finance/payment-runs/${id}/settle`, { results: [{ item_id: i1, outcome: 'paid', settlement_ref: 'BANK-991' }] });
    expect(s.body).toMatchObject({ status: 'partially_paid', paid: 1, pending: 1 });
    expect((await billRow(b1)).status).toBe('paid');
    expect((await sql('SELECT run_id, voucher_id FROM payments WHERE bill_id = ?', [b1]))[0].run_id).toBe(id);
    expect((await A.post(`/finance/payment-runs/${id}/settle`, { results: [{ item_id: i1, outcome: 'paid', settlement_ref: 'BANK-991' }] })).status).toBe(409);   // no double pay
    const s2 = await A.post(`/finance/payment-runs/${id}/settle`, { results: [{ item_id: i2, outcome: 'paid', manual_reason: 'Confirmed by phone with Westpac, advice #4471' }] });
    expect(s2.body.status).toBe('paid'); expect((await billRow(b2)).amount_paid).toBe(250);
    expect((await sql('SELECT manual_reason FROM payment_run_items WHERE id = ?', [i2]))[0].manual_reason).toMatch(/Westpac/);
    const tb = (await A.get('/accounting/trial-balance')).body; expect(tb.debit).toBeCloseTo(tb.credit, 2);
    expect((await A.post(`/finance/payment-runs/${id}/remittance`)).status).toBe(200);
  }, 60000);

  it('failed items leave their bill payable and can be put in a new run', async () => {
    const [b1, b2] = [await mkBill(), await mkBill()];
    const id = await approved([b1, b2]); await A.get(`/finance/payment-runs/${id}/bank-file?format=csv`);
    const [i1, i2] = (await detail(id)).items.map((i: any) => i.id);
    expect((await A.post(`/finance/payment-runs/${id}/settle`, { results: [{ item_id: i2, outcome: 'failed' }] })).status).toBe(400);
    const s = await A.post(`/finance/payment-runs/${id}/settle`, { results: [{ item_id: i1, outcome: 'paid', settlement_ref: 'R1' }, { item_id: i2, outcome: 'failed', failure_reason: 'Account closed' }] });
    expect(s.body).toMatchObject({ status: 'partially_paid', pending: 0, failed: 1 });
    expect((await billRow(b2)).status).toBe('approved');
    expect((await mkRun([b2])).status).toBe(201);
    const all = await mkBill(); const onlyFail = await approved([all]); await A.get(`/finance/payment-runs/${onlyFail}/bank-file?format=csv`);
    const it = (await detail(onlyFail)).items[0].id;
    expect((await A.post(`/finance/payment-runs/${onlyFail}/settle`, { results: [{ item_id: it, outcome: 'failed', failure_reason: 'Bank rejected file' }] })).body.status).toBe('failed');
  }, 60000);
});

describe('validation and controls', () => {
  it('refuses suppliers without bank details, unapproved bills and foreign-currency bills', async () => {
    const noBank = await mkBill({ supplier: supNoBank });
    const id = (await mkRun([noBank])).body.id;
    const v = await A.post(`/finance/payment-runs/${id}/validate`);
    expect(v.status).toBe(409); expect(v.body.problems[0].message).toMatch(/bank details/); expect((await detail(id)).run.status).toBe('draft');
    expect((await mkRun([await mkBill({ approve: false })])).status).toBe(409);
    expect((await mkRun([await mkBill()], { currency: 'EUR' })).status).toBe(409);
  });
  it('a bill cannot sit in two open runs, even created at the same instant', async () => {
    const b = await mkBill();
    const rs = await Promise.all([mkRun([b]), mkRun([b]), mkRun([b])]);
    expect(rs.map((r) => r.status).sort()).toEqual([201, 409, 409]);
  });
  it('re-checks at approval: a bill voided after submission blocks the run', async () => {
    const b = await mkBill(); const id = (await mkRun([b])).body.id;
    await A.post(`/finance/payment-runs/${id}/validate`); await A.post(`/finance/payment-runs/${id}/submit`);
    expect((await A.post(`/finance/bills/${b}/void`, { reason: 'Supplier credit note received' })).status).toBe(200);
    const r = await approver.post(`/finance/payment-runs/${id}/approve`);
    expect(r.status).toBe(409); expect(r.body.problems[0].message).toMatch(/void/);
  });
  it('rejecting sends it back to draft with approvals cleared; cancelling frees the bills; export locks cancellation', async () => {
    const b = await mkBill(); const id = (await mkRun([b])).body.id;
    await A.post(`/finance/payment-runs/${id}/validate`); await A.post(`/finance/payment-runs/${id}/submit`);
    expect((await approver.post(`/finance/payment-runs/${id}/return`, {})).status).toBe(400);
    expect((await approver.post(`/finance/payment-runs/${id}/return`, { reason: 'Amount looks wrong' })).status).toBe(200);
    expect((await detail(id)).run).toMatchObject({ status: 'draft', submitted_by: null });
    expect((await A.post(`/finance/payment-runs/${id}/cancel`, { reason: 'Not needed' })).status).toBe(200);
    expect((await mkRun([b])).status).toBe(201);
    const x = await approved([await mkBill()]); await A.get(`/finance/payment-runs/${x}/bank-file?format=csv`);
    expect((await A.post(`/finance/payment-runs/${x}/cancel`, { reason: 'Changed my mind' })).status).toBe(409);
  });
  it('file formats are checked against currency and payee data', async () => {
    const id = await approved([await mkBill()]);
    expect((await A.get(`/finance/payment-runs/${id}/bank-file?format=aba`)).status).toBe(409);            // ABA is AUD only
    const bad = (await A.post('/suppliers', { name: 'Bad Routing', supplier_type: 'hotel', bank_details: { ...GOOD, routing: '123456789' } })).body.id;
    const r = (await mkRun([await mkBill({ supplier: bad })])).body.id;
    expect((await A.post(`/finance/payment-runs/${r}/validate`)).body.problems[0].message).toMatch(/checksum/);
  });
  it('settlement inside a locked period fails whole and leaves everything pending', async () => {
    const b = await mkBill(); const id = await approved([b]); await A.get(`/finance/payment-runs/${id}/bank-file?format=csv`);
    const it = (await detail(id)).items[0].id;
    await sql('UPDATE agencies SET locked_through = ? WHERE id = ?', ['2026-12-31', A.agencyId]);
    try {
      expect((await A.post(`/finance/payment-runs/${id}/settle`, { results: [{ item_id: it, outcome: 'paid', settlement_ref: 'L1', date: '2026-11-15' }] })).status).toBe(409);
      expect((await billRow(b)).status).toBe('approved'); expect((await detail(id)).items[0].status).toBe('pending');
    } finally { await sql('UPDATE agencies SET locked_through = NULL WHERE id = ?', [A.agencyId]); }
  });
});

describe('access', () => {
  it('only finance roles can create/approve/export; agents are shut out; other agencies see nothing', async () => {
    const b = await mkBill(); const id = (await mkRun([b])).body.id;
    expect((await viewer.get(`/finance/payment-runs/${id}`)).status).toBe(200);
    expect((await viewer.post('/finance/payment-runs', { currency: 'USD', bank_account_id: bank, items: [{ bill_id: b }] })).status).toBe(403);
    expect((await viewer.post(`/finance/payment-runs/${id}/approve`)).status).toBe(403);
    expect((await viewer.get(`/finance/payment-runs/${id}/bank-file?format=csv`)).status).toBe(403);
    expect((await agent.get('/finance/payment-runs')).status).toBe(403);
    expect((await B.get(`/finance/payment-runs/${id}`)).status).toBe(404);
    expect((await B.post(`/finance/payment-runs/${id}/cancel`, { reason: 'sabotage' })).status).toBe(404);
    const bBank = ((await B.get('/accounting/lookup?types=110')).body as any[])[0].id;
    expect((await B.post('/finance/payment-runs', { currency: 'USD', bank_account_id: bBank, items: [{ bill_id: b }] })).status).toBe(400);   // A's bill
    expect((await B.post('/finance/payment-runs', { currency: 'USD', bank_account_id: bank, items: [{ bill_id: await mkBill({ a: B, supplier: (await B.post('/suppliers', { name: 'S', supplier_type: 'hotel' })).body.id }) }] })).status).toBe(400); // A's bank
    expect((await B.get('/finance/payment-runs')).body).toEqual([]);
  });
  it('the legacy run endpoint no longer creates unapproved outbound payments', async () => {
    expect((await A.post('/payments/runs', { currency: 'USD', items: [{ supplier_id: supOk, amount: 5 }] })).status).toBe(409);
    const id = (await mkRun([await mkBill()])).body.id;
    expect((await A.post(`/payments/runs/${id}/approve`)).status).toBe(404);
  });
});
