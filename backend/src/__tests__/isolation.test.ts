import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, boot, newAgency, seedBasics, shutdown, sql, ticketBody } from './helpers.js';

let A: Api, B: Api; let a: Awaited<ReturnType<typeof seedBasics>>, b: Awaited<ReturnType<typeof seedBasics>>;
let aInvoice: number;

beforeAll(async () => {
  await boot(); A = await newAgency('A'); B = await newAgency('B');
  a = await seedBasics(A); b = await seedBasics(B);
  aInvoice = (await A.post('/tickets/invoices', ticketBody(a.client, a.airline))).body.id;
  await A.post(`/tickets/invoices/${aInvoice}/supervise`);
});
afterAll(shutdown);

describe('tenant isolation — direct object access', () => {
  it('seed data exists for A', () => expect(aInvoice).toBeGreaterThan(0));
  it.each([
    ['GET', () => `/tickets/invoices/${aInvoice}`], ['PUT', () => `/tickets/invoices/${aInvoice}`], ['POST', () => `/tickets/invoices/${aInvoice}/supervise`],
    ['POST', () => `/tickets/invoices/${aInvoice}/repost`], ['DELETE', () => `/tickets/invoices/${aInvoice}`],
  ])('B cannot %s A\'s ticket invoice', async (m, path) => {
    const r = await B.req(m as string, path(), ['PUT', 'POST'].includes(m as string) ? ticketBody(b.client, b.airline) : undefined);
    expect([404, 409]).toContain(r.status); expect(JSON.stringify(r.body)).not.toContain('Customer');
  });
  it("B cannot read A's ledger or account", async () => {
    expect((await B.get(`/accounting/ledger?account_id=${a.client}`)).status).toBe(404);
    expect((await B.put(`/accounting/accounts/${a.client}`, { name: 'pwned' })).status).toBe(404);
    const row = (await sql('SELECT name FROM accounts WHERE id = ?', [a.client]))[0];
    expect(row.name).not.toBe('pwned');
  });
  it("lists never include A's rows for B", async () => {
    for (const p of ['/tickets/invoices', '/accounting/accounts', '/accounting/lookup', '/airlines', '/vouchers/receipts', '/tickets/refunds', '/invoices', '/clients', '/suppliers']) {
      const r = await B.get(p); expect(r.status).toBe(200);
      expect(JSON.stringify(r.body)).not.toContain(`"agency_id":${A.agencyId},`);
    }
  });
  it("B's token with A's agency id is rejected and recorded", async () => {
    const r = await B.req('GET', '/tickets/invoices', undefined, A.agencyId);
    expect(r.status).toBe(403);
    expect((await sql(`SELECT id FROM security_events WHERE event = 'agency_access_denied' AND user_id = ?`, [B.userId])).length).toBeGreaterThan(0);
  });
});

describe('tenant isolation — foreign keys in request bodies', () => {
  it("B cannot create a ticket invoice for A's customer account (no name leak either)", async () => {
    const r = await B.post('/tickets/invoices', ticketBody(a.client, b.airline));
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).not.toMatch(/Customer/);
  });
  it("B cannot point lines at A's airline, payable or agent accounts", async () => {
    for (const patch of [{ airline_id: a.airline }, { payable_account_id: a.airlineAcc }, { agent_account_id: a.airlineAcc }]) {
      const body = ticketBody(b.client, b.airline); (body.lines[0] as any) = { ...body.lines[0], ...patch };
      expect((await B.post('/tickets/invoices', body)).status).toBe(400);
    }
  });
  it("B cannot reference A's branch/department or user", async () => {
    const br = (await A.get('/accounting/branches')).body[0].id;
    expect((await B.post('/tickets/invoices', ticketBody(b.client, b.airline, { branch_id: br }))).status).toBe(400);
    expect((await B.post('/tickets/invoices', ticketBody(b.client, b.airline, { employee_id: A.userId }))).status).toBe(400);
  });
  it('receipts, payments and refunds reject foreign accounts', async () => {
    expect((await B.post('/vouchers/receipts', { cash_account_id: a.cash, party_account_id: b.client, amount: 10, mode: 'cash' })).status).toBe(400);
    expect((await B.post('/vouchers/payments', { cash_account_id: b.cash, party_account_id: a.airlineAcc, amount: 10, mode: 'cash' })).status).toBe(400);
    expect((await B.post('/vouchers/receipts', { cash_account_id: b.cash, party_account_id: b.client, amount: 10, mode: 'cheque', cheque_no: '1' })).status).toBe(201); // control: own accounts work
    expect((await B.post('/tickets/refunds', { client_account_id: a.client, payable_account_id: b.airlineAcc, amount: 10, rec_from_vendor: 5, pending: true })).status).toBe(400);
    expect((await B.post('/tickets/refunds', { ticket_line_id: 1, client_account_id: b.client, payable_account_id: b.airlineAcc, amount: 10, rec_from_vendor: 5 })).status).toBe(400);
  });
  it('journal vouchers reject foreign accounts', async () => {
    const r = await B.post('/accounting/journal', { lines: [{ account_id: a.cash, debit: 5 }, { account_id: b.cash, credit: 5 }] });
    expect(r.status).toBe(400);
  });
  it('refusals are recorded as security events', async () => {
    expect((await sql(`SELECT id FROM security_events WHERE event = 'foreign_reference_denied' AND agency_id = ?`, [B.agencyId])).length).toBeGreaterThan(0);
  });
  it("A's data was never changed by B's attempts", async () => {
    expect((await sql('SELECT COUNT(*) n FROM ticket_invoices WHERE agency_id = ?', [A.agencyId]))[0].n).toBe(1);
    expect((await sql('SELECT COUNT(*) n FROM gl_entries WHERE agency_id = ? AND voucher_id IN (SELECT id FROM vouchers WHERE agency_id = ? AND voucher_type = "journal")', [A.agencyId, A.agencyId]))[0].n).toBe(0);
  });
});
