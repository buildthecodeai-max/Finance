import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, addMember, boot, newAgency, seedBasics, shutdown, sql, ticketBody } from './helpers.js';

let admin: Api, finance: Api, agent: Api, viewer: Api; let s: Awaited<ReturnType<typeof seedBasics>>;
const tb = async (a: Api) => (await a.get('/accounting/trial-balance')).body as { debit: number; credit: number };

beforeAll(async () => {
  await boot(); admin = await newAgency('Controls'); s = await seedBasics(admin);
  finance = await addMember(admin, 'finance_manager'); agent = await addMember(admin, 'agent'); viewer = await addMember(admin, 'viewer');
});
afterAll(shutdown);

describe('role matrix (server-side)', () => {
  it('viewer is read-only', async () => {
    expect((await viewer.get('/accounting/trial-balance')).status).toBe(200);
    expect((await viewer.post('/tickets/invoices', ticketBody(s.client, s.airline))).status).toBe(403);
    expect((await viewer.post('/vouchers/receipts', { cash_account_id: s.cash, party_account_id: s.client, amount: 5 })).status).toBe(403);
    expect((await viewer.put('/admin/settings', { name: 'x y z' })).status).toBe(403);
  });
  it('agent can draft but not approve, post or see the ledger', async () => {
    const r = await agent.post('/tickets/invoices', ticketBody(s.client, s.airline)); expect(r.status).toBe(201);
    expect(r.body.status).toBe('tentative');
    expect((await agent.post(`/tickets/invoices/${r.body.id}/supervise`)).status).toBe(403);
    expect((await agent.get('/accounting/ledger?account_id=' + s.client)).status).toBe(403);
    expect((await agent.get('/admin/audit')).status).toBe(403);
    expect((await agent.post('/accounting/journal', { lines: [] })).status).toBe(403);
  });
  it("agents see only their own invoices; others' are not found", async () => {
    const mine = (await agent.get('/tickets/invoices')).body as any[];
    expect(mine.every((i) => i.created_by === agent.userId)).toBe(true);
    const other = (await admin.post('/tickets/invoices', ticketBody(s.client, s.airline))).body.id;
    expect((await agent.put(`/tickets/invoices/${other}`, ticketBody(s.client, s.airline))).status).toBe(403);
  });
  it('denied attempts are logged as security events', async () => {
    expect((await sql(`SELECT id FROM security_events WHERE event = 'role_denied' AND agency_id = ?`, [admin.agencyId])).length).toBeGreaterThan(0);
  });
});

describe('branch scope', () => {
  it('branch-scoped users only reach their own branch documents', async () => {
    const bx = (await admin.post('/accounting/branches', { name: 'Karachi' })).body.id, by = (await admin.post('/accounting/branches', { name: 'Lahore' })).body.id;
    const fx = await addMember(admin, 'finance_manager', { branch_id: bx }); const fy = await addMember(admin, 'finance_manager', { branch_id: by });
    const inv = (await fx.post('/tickets/invoices', ticketBody(s.client, s.airline, { branch_id: by }))).body; // tries to file under another branch
    expect(inv.branch_id).toBe(bx); // forced to own branch
    expect((await fy.get(`/tickets/invoices/${inv.id}`)).status).toBe(404);
    expect((await fy.post(`/tickets/invoices/${inv.id}/supervise`)).status).toBe(404);
    expect(((await fy.get('/tickets/invoices')).body as any[]).some((i) => i.id === inv.id)).toBe(false);
    expect((await fx.get(`/tickets/invoices/${inv.id}`)).status).toBe(200);
    expect(((await admin.get('/tickets/invoices')).body as any[]).some((i) => i.id === inv.id)).toBe(true); // unscoped admin sees all
  });
});

describe('ledger integrity', () => {
  it('rejects unbalanced and empty vouchers', async () => {
    expect((await admin.post('/accounting/journal', { lines: [{ account_id: s.cash, debit: 10 }, { account_id: s.client, credit: 9 }] })).status).toBe(400);
    expect((await admin.post('/accounting/journal', { lines: [{ account_id: s.cash, debit: 0 }, { account_id: s.client, credit: 0 }] })).status).toBe(400);
  });
  it('ticket invoice → receipt → payment → refund keeps the trial balance balanced', async () => {
    const inv = (await admin.post('/tickets/invoices', ticketBody(s.client, s.airline))).body.id;
    expect((await admin.post(`/tickets/invoices/${inv}/supervise`)).status).toBe(200);
    expect((await admin.post('/vouchers/receipts', { cash_account_id: s.cash, party_account_id: s.client, amount: 400, mode: 'cash' })).status).toBe(201);
    expect((await admin.post('/vouchers/payments', { cash_account_id: s.cash, party_account_id: s.airlineAcc, amount: 250, mode: 'bank' })).status).toBe(201);
    const line = (await admin.get(`/tickets/invoices/${inv}`)).body.lines[0].id;
    expect((await admin.post('/tickets/refunds', { ticket_line_id: line, invoice_id: inv, client_account_id: s.client, payable_account_id: s.airlineAcc, amount: 1100, rec_from_vendor: 1000, cancelation: 50, service: 20 })).status).toBe(201);
    const t = await tb(admin); expect(t.debit).toBeCloseTo(t.credit, 2); expect(t.debit).toBeGreaterThan(0);
  });
  it('a ticket cannot be refunded twice', async () => {
    const inv = (await admin.post('/tickets/invoices', ticketBody(s.client, s.airline))).body; const line = inv.lines[0].id;
    const body = { ticket_line_id: line, invoice_id: inv.id, client_account_id: s.client, payable_account_id: s.airlineAcc, amount: 10, rec_from_vendor: 5 };
    expect((await admin.post('/tickets/refunds', body)).status).toBe(201);
    expect((await admin.post('/tickets/refunds', body)).status).toBe(409);
  });
  it('re-posting an edited invoice replaces (not duplicates) its entries', async () => {
    const inv = (await admin.post('/tickets/invoices', ticketBody(s.client, s.airline))).body.id;
    await admin.post(`/tickets/invoices/${inv}/supervise`);
    const before = (await sql('SELECT COUNT(*) n FROM gl_entries WHERE agency_id = ?', [admin.agencyId]))[0].n;
    expect((await admin.post(`/tickets/invoices/${inv}/repost`)).status).toBe(200);
    expect((await sql('SELECT COUNT(*) n FROM gl_entries WHERE agency_id = ?', [admin.agencyId]))[0].n).toBe(before);
    const t = await tb(admin); expect(t.debit).toBeCloseTo(t.credit, 2);
  });
  it('document numbers stay unique after a delete', async () => {
    const mk = async () => (await admin.post('/vouchers/receipts', { cash_account_id: s.cash, party_account_id: s.client, amount: 1 })).body.id;
    const a1 = await mk(), a2 = await mk(), a3 = await mk(); void a2;
    expect((await admin.del(`/vouchers/${a1}`)).status).toBe(200);
    const a4 = await mk(); expect(a4).toBeGreaterThan(a3);
    const nos = (await sql(`SELECT voucher_no FROM cash_vouchers WHERE agency_id = ? AND kind = 'receipt'`, [admin.agencyId])).map((r) => r.voucher_no);
    expect(new Set(nos).size).toBe(nos.length);
  });
});

describe('period lock', () => {
  it('blocks posting and reversal inside a locked period; reopen needs admin + reason', async () => {
    const rcp = (await admin.post('/vouchers/receipts', { voucher_date: '2026-01-15', cash_account_id: s.cash, party_account_id: s.client, amount: 77 })).body.id;
    expect((await finance.post('/admin/period-locks', { locked_through: '2026-03-31', reason: '' })).status).toBe(400); // reason required
    expect((await finance.post('/admin/period-locks', { locked_through: '2026-03-31', reason: 'Q1 close' })).status).toBe(200);
    expect((await admin.post('/vouchers/receipts', { voucher_date: '2026-02-01', cash_account_id: s.cash, party_account_id: s.client, amount: 5 })).status).toBe(409);
    expect((await admin.post('/accounting/journal', { date: '2026-03-31', lines: [{ account_id: s.cash, debit: 1 }, { account_id: s.client, credit: 1 }] })).status).toBe(409);
    expect((await admin.del(`/vouchers/${rcp}`)).status).toBe(409);
    expect((await admin.post('/vouchers/receipts', { voucher_date: '2026-04-01', cash_account_id: s.cash, party_account_id: s.client, amount: 5 })).status).toBe(201);
    expect((await finance.post('/admin/period-locks', { locked_through: null, reason: 'need to fix' })).status).toBe(403); // finance can't reopen
    expect((await admin.post('/admin/period-locks', { locked_through: null, reason: 'Correcting a posting error' })).status).toBe(200);
    expect((await admin.del(`/vouchers/${rcp}`)).status).toBe(200);
    const hist = (await admin.get('/admin/period-locks')).body as any[];
    expect(hist.map((h) => h.action)).toEqual(['reopen', 'lock']);
    expect((await sql(`SELECT reason FROM audit_log WHERE agency_id = ? AND entity = 'agencies.locked_through' ORDER BY id DESC LIMIT 1`, [admin.agencyId]))[0].reason).toBe('Correcting a posting error');
  });
});

describe('audit trail', () => {
  it('is append-only at the database level', async () => {
    await expect(sql('UPDATE audit_log SET action = "create" WHERE agency_id = ?', [admin.agencyId])).rejects.toThrow(/append-only/);
    await expect(sql('DELETE FROM audit_log WHERE agency_id = ?', [admin.agencyId])).rejects.toThrow(/append-only/);
    await expect(sql('DELETE FROM security_events WHERE agency_id = ?', [admin.agencyId])).rejects.toThrow(/append-only/);
    await expect(sql('DELETE FROM period_locks WHERE agency_id = ?', [admin.agencyId])).rejects.toThrow(/append-only/);
  });
  it('records financial changes with actor, and settings changes with a reason', async () => {
    const r = await admin.put('/admin/settings', { tax_label: 'VAT', reason: 'Switch to VAT' }); expect(r.status).toBe(200);
    const rows = (await admin.get('/admin/audit?entity=agencies')).body as any[];
    expect(rows[0]).toMatchObject({ action: 'update', reason: 'Switch to VAT', user_name: 'Admin' });
    expect((await admin.get('/admin/audit?entity=vouchers')).body.length).toBeGreaterThan(0);
  });
  it('base currency is frozen once transactions exist; invalid time zones rejected', async () => {
    expect((await admin.put('/admin/settings', { base_currency: 'EUR' })).status).toBe(409);
    expect((await admin.put('/admin/settings', { timezone: 'Mars/Olympus' })).status).toBe(400);
  });
});

describe('agency billing details', () => {
  it('admin can save tax/bank details; blanks clear; audited; others cannot change them', async () => {
    const r = await admin.put('/admin/settings', { tax_number: '99-ABC', bank_name: 'HBL', bank_account_number: '0012345', bank_swift: 'HABBPKKA', reason: 'Add banking' });
    expect(r.status).toBe(200); expect(r.body).toMatchObject({ tax_number: '99-ABC', bank_name: 'HBL', bank_account_number: '0012345' });
    expect((await viewer.get('/admin/settings')).body.bank_name).toBe('HBL'); // readable (needed to render invoices)
    for (const who of [viewer, finance, agent]) expect((await who.put('/admin/settings', { bank_name: 'EVIL' })).status).toBe(403);
    expect((await admin.get('/admin/settings')).body.bank_name).toBe('HBL');
    expect((await admin.put('/admin/settings', { bank_swift: '   ' })).body.bank_swift).toBeNull();
    const a = (await admin.get('/admin/audit?entity=agencies')).body as any[];
    expect(a.some((x) => x.reason === 'Add banking' && JSON.stringify(x.after_json).includes('HBL'))).toBe(true);
    expect((await admin.put('/admin/settings', { bank_name: 'x'.repeat(101) })).status).toBe(400);
  });
});

describe('global search', () => {
  it('finds records by role and never crosses tenants', async () => {
    const other = await newAgency('Other'); const o = await seedBasics(other); void o;
    const name = ((await admin.get('/accounting/lookup?types=120')).body as any[])[0].name as string;
    const r = (await admin.get(`/admin/search?q=${encodeURIComponent(name.slice(0, 8))}`)).body as any[];
    expect(r.some((x) => x.type === 'Account' && x.label === name)).toBe(true);
    expect(((await agent.get(`/admin/search?q=${encodeURIComponent(name.slice(0, 8))}`)).body as any[]).some((x) => x.type === 'Account')).toBe(false); // agents don't search the chart
    const leak = (await other.get(`/admin/search?q=${encodeURIComponent(name.slice(0, 8))}`)).body as any[];
    expect(leak.some((x) => x.label === name)).toBe(false);
    expect((await admin.get('/admin/search?q=%25')).body).toEqual([]); // wildcard is escaped / too short
  });
});
