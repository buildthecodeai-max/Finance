import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, addMember, boot, newAgency, shutdown, sql } from './helpers.js';

let A: Api, B: Api, fin: Api, agent: Api, viewer: Api; let bank: number;
const rnd = () => Math.random().toString(36).slice(2, 7);
const mkClient = async (a = A, o: Record<string, unknown> = {}) => (await a.post('/clients', { name: `Client ${rnd()}`, email: `${rnd()}@c.test`, currency: 'USD', ...o })).body.id as number;
const mkSupplier = async (a = A) => (await a.post('/suppliers', { name: `Supplier ${rnd()}`, supplier_type: 'hotel' })).body.id as number;
async function issued(client: number, a = A) { const r = await a.post('/invoices', { client_id: client, currency: 'USD', lines: [{ product_type: 'hotel', description: 'Trip', unit_cost: 100, markup_pct: 10, tax_rate: 0 }] }); const id = r.body.inv.id as number; await a.post(`/invoices/${id}/status`, { status: 'reviewed' }); await a.post(`/invoices/${id}/issue`); return id; }
const names = async (path: string, a = A) => ((await a.get(path)).body as any[]).map((x) => x.name);

beforeAll(async () => {
  await boot(); A = await newAgency('MgmtA'); B = await newAgency('MgmtB'); fin = await addMember(A, 'finance_manager'); agent = await addMember(A, 'agent'); viewer = await addMember(A, 'viewer');
  bank = ((await A.get('/accounting/lookup?types=110')).body as any[])[0].id;
});
afterAll(shutdown);

describe('clients: edit, archive, delete', () => {
  it('edits every field (agents too), validates, and never crosses agencies', async () => {
    const id = await mkClient(); const r = await agent.put(`/clients/${id}`, { name: 'Renamed Co', phone: '+1 555 0100', address: '1 Main St', payment_terms_days: 30, currency: 'EUR', notes: 'VIP' }); expect(r.status).toBe(200);
    const c = (await A.get(`/clients/${id}`)).body; expect(c).toMatchObject({ name: 'Renamed Co', phone: '+1 555 0100', payment_terms_days: 30, currency: 'EUR', notes: 'VIP' });
    expect((await A.put(`/clients/${id}`, { email: 'not-an-email' })).status).toBe(400); expect((await viewer.put(`/clients/${id}`, { name: 'x' })).status).toBe(403);
    expect((await B.put(`/clients/${id}`, { name: 'Hijack' })).status).toBe(404); expect((await B.del(`/clients/${id}`)).status).toBe(404); expect((await B.post(`/clients/${id}/archive`)).status).toBe(404);
    expect((await sql('SELECT name FROM clients WHERE id = ?', [id]))[0].name).toBe('Renamed Co');
  });
  it('deletes a client with no history, but explains exactly what blocks it otherwise — and archive/restore work', async () => {
    const clean = await mkClient(); expect((await A.get(`/clients/${clean}/usage`)).body.can_delete).toBe(true);
    expect((await agent.del(`/clients/${clean}`)).status).toBe(403); expect((await A.del(`/clients/${clean}`)).status).toBe(200); expect((await A.get(`/clients/${clean}`)).status).toBe(404);
    const busy = await mkClient(); await issued(busy); await A.post('/bookings', { client_id: busy, destination: 'Bali' });
    const u = (await A.get(`/clients/${busy}/usage`)).body; expect(u.can_delete).toBe(false); expect(u.deps.map((d: any) => d.table)).toEqual(expect.arrayContaining(['invoices', 'bookings']));
    const del = await fin.del(`/clients/${busy}`); expect(del.status).toBe(409); expect(del.body.code).toBe('has_dependents'); expect(del.body.error).toMatch(/1 invoices?, .*archive it instead/i);
    expect((await fin.post(`/clients/${busy}/archive`)).status).toBe(200);
    expect(await names('/clients')).not.toContain((await A.get(`/clients/${busy}`)).body.name); expect((await names('/clients?status=archived'))).toContain((await A.get(`/clients/${busy}`)).body.name);
    const blocked = await A.post('/bookings', { client_id: busy, destination: 'Fiji' }); expect(blocked.status).toBe(409); expect(blocked.body.code).toBe('archived');                // cannot start new work for an archived client
    expect((await A.post('/invoices', { client_id: busy, currency: 'USD', lines: [{ product_type: 'hotel', description: 'x', unit_cost: 1, markup_pct: 0, tax_rate: 0 }] })).status).toBe(409);
    expect((await fin.post(`/clients/${busy}/restore`)).status).toBe(200); expect((await A.post('/bookings', { client_id: busy, destination: 'Fiji' })).status).toBe(201);
  });
  it('removes a client\'s portal links and support requests together with the client', async () => {
    const c = await mkClient(); await A.post('/portal-admin/links', { client_id: c }); await sql("INSERT INTO support_requests (agency_id, client_id, subject, message) VALUES (?,?,'s','m')", [A.agencyId, c]);
    expect((await A.del(`/clients/${c}`)).status).toBe(200); expect((await sql('SELECT COUNT(*) n FROM portal_links WHERE client_id = ?', [c]))[0].n).toBe(0);
  });
});

describe('suppliers: edit, archive, delete', () => {
  it('edits including bank details, archives when used, deletes when unused', async () => {
    const s = await mkSupplier(); expect((await A.put(`/suppliers/${s}`, { name: 'Coral Resorts', payment_terms_days: 45, bank_details: { account_name: 'Coral', routing: '021000021', account_number: '987654321' } })).status).toBe(200);
    const d = (await A.get(`/suppliers/${s}`)).body; expect(d).toMatchObject({ name: 'Coral Resorts', payment_terms_days: 45, has_bank_details: true, account_last4: '4321' }); expect(JSON.stringify(d)).not.toContain('bank_details_enc');
    expect((await agent.put(`/suppliers/${s}`, { name: 'x' })).status).toBe(403); expect((await B.put(`/suppliers/${s}`, { name: 'x' })).status).toBe(404);
    const used = await mkSupplier(); await A.post('/finance/bills', { supplier_id: used, supplier_ref: `S-${rnd()}`, bill_date: '2026-10-01', lines: [{ description: 'Hotel', amount: 100, tax: 0 }] });
    const del = await A.del(`/suppliers/${used}`); expect(del.status).toBe(409); expect(del.body.error).toMatch(/supplier bills?/);
    expect((await A.post(`/suppliers/${used}/archive`)).status).toBe(200); expect((await A.get('/suppliers')).body.some((x: any) => x.id === used)).toBe(false); expect((await A.get('/suppliers?status=archived')).body.some((x: any) => x.id === used)).toBe(true);
    expect((await A.post('/finance/bills', { supplier_id: used, supplier_ref: `S-${rnd()}`, bill_date: '2026-10-01', lines: [{ description: 'x', amount: 1, tax: 0 }] })).status).toBe(409);
    expect((await A.post(`/suppliers/${used}/restore`)).status).toBe(200); expect((await A.del(`/suppliers/${s}`)).status).toBe(200);
  });
});

describe('bookings: edit and delete (archive)', () => {
  it('edits details with a change-log entry; archive is blocked by live invoices; restore works; agents limited', async () => {
    const c = await mkClient(), id = (await A.post('/bookings', { client_id: c, destination: 'Rome', status: 'enquiry' })).body.id;
    expect((await A.put(`/bookings/${id}`, { destination: 'Venice', travel_start: '2027-05-01', travel_end: '2027-05-09', notes: 'Honeymoon', reason: 'Client changed plans' })).status).toBe(200);
    const w = (await A.get(`/bookings/${id}`)).body; expect(w.booking?.destination ?? w.destination).toBe('Venice'); expect(JSON.stringify(w)).toMatch(/Client changed plans/);
    const res = await fetch(`${(await import('./helpers.js')).apiBase()}/bookings/${id}`, { method: 'DELETE', headers: { 'content-type': 'application/json', authorization: `Bearer ${A.token}`, 'x-agency-id': String(A.agencyId) }, body: JSON.stringify({ reason: 'Duplicate entry' }) });
    expect(res.status).toBe(200); expect((await A.get('/bookings')).body.some((b: any) => b.id === id)).toBe(false); expect((await A.get('/bookings?archived=1')).body.some((b: any) => b.id === id)).toBe(true);
    expect((await A.put(`/bookings/${id}`, { destination: 'x' })).status).toBe(409);                                                                    // archived: read-only until restored
    expect((await agent.post(`/bookings/${id}/restore`, { reason: 'oops' })).status).toBe(403); expect((await B.post(`/bookings/${id}/restore`, { reason: 'x'.repeat(5) })).status).toBe(404);
    expect((await fin.post(`/bookings/${id}/restore`, { reason: 'Deleted by mistake' })).status).toBe(200); expect((await A.get('/bookings')).body.some((b: any) => b.id === id)).toBe(true);
    const log = (await sql("SELECT field, old_value, new_value, reason FROM booking_changes WHERE booking_id = ? AND field = 'archived' ORDER BY id", [id])); expect(log).toHaveLength(2); expect(log[0].reason).toBe('Duplicate entry');
  });
  it('refuses to delete a booking that has live invoices or bills, and limits what an agent may delete', async () => {
    const c = await mkClient(), b1 = (await A.post('/bookings', { client_id: c, destination: 'Oslo', status: 'confirmed' })).body.id;
    const inv = (await A.post('/invoices', { client_id: c, booking_id: b1, currency: 'USD', lines: [{ product_type: 'hotel', description: 'Trip', unit_cost: 100, markup_pct: 0, tax_rate: 0 }] })).body.inv.id;
    const blocked = await A.req('DELETE', `/bookings/${b1}`, { reason: 'Cleaning up' }); expect(blocked.status).toBe(409); expect(blocked.body.error).toMatch(/invoice/);
    expect((await A.get(`/bookings/${b1}/usage`)).body.live.map((d: any) => d.table)).toContain('invoices');
    await A.post(`/invoices/${inv}/void`, { reason: 'Created by mistake' }).catch(() => null); await A.post(`/invoices/${inv}/status`, { status: 'void' });
    expect((await A.req('DELETE', `/bookings/${b1}`, { reason: 'Cleaning up' })).status).toBe(200);                                                      // voided invoice no longer blocks
    const mine = (await agent.post('/bookings', { client_id: c, destination: 'Lima', status: 'enquiry' })).body.id; expect((await agent.req('DELETE', `/bookings/${mine}`, { reason: 'Test enquiry' })).status).toBe(200);
    const conf = (await agent.post('/bookings', { client_id: c, destination: 'Lima', status: 'confirmed' })).body.id; expect((await agent.req('DELETE', `/bookings/${conf}`, { reason: 'Test confirmed' })).status).toBe(403);
    expect((await viewer.req('DELETE', `/bookings/${conf}`, { reason: 'Test viewer' })).status).toBe(403);
  });
});

describe('team and branches', () => {
  it('edits roles, protects the last admin, removes members (optionally reassigning work), and frees the seat', async () => {
    const team = (await A.get('/team')).body as any[]; const me = team.find((m) => m.role === 'admin'), ag = team.find((m) => m.role === 'agent');
    expect((await A.put(`/team/${ag.id}`, { role: 'finance_manager', default_commission_pct: 12.5 })).status).toBe(200); expect(((await A.get('/team')).body as any[]).find((m) => m.id === ag.id)).toMatchObject({ role: 'finance_manager', default_commission_pct: 12.5 });
    await A.put(`/team/${ag.id}`, { role: 'agent' });
    expect((await A.put(`/team/${me.id}`, { role: 'viewer' })).body.error).toMatch(/only admin/); expect((await A.del(`/team/${me.id}`)).status).toBe(409);                  // sole admin cannot be demoted or removed
    expect((await fin.put(`/team/${ag.id}`, { role: 'admin' })).status).toBe(403); expect((await fin.del(`/team/${ag.id}`)).status).toBe(403);
    const lead = (await agent.post('/leads', { name: 'Agent Lead', email: `${rnd()}@l.test` })).body.id; const w = (await A.get(`/team/${ag.id}/workload`)).body; expect(w.leads).toBeGreaterThanOrEqual(1);
    const before = (await A.get('/billing/subscription')).body.usage.seats;
    const rm = await A.req('DELETE', `/team/${ag.id}`, { reassign_to: me.user_id }); expect(rm.status).toBe(200); expect(rm.body.reassigned.leads).toBeGreaterThanOrEqual(1);
    expect((await sql('SELECT owner_id FROM leads WHERE id = ?', [lead]))[0].owner_id).toBe(me.user_id); expect((await A.get('/billing/subscription')).body.usage.seats).toBe(before - 1);
    expect((await agent.get('/clients')).status).toBe(403);                                                                                               // access ended immediately
    expect((await A.del(`/team/${ag.id}`)).status).toBe(404); expect((await B.del(`/team/${me.id}`)).status).toBe(404);
    expect((await sql('SELECT COUNT(*) n FROM users WHERE id = ?', [ag.user_id]))[0].n).toBe(1);                                                          // the account itself survives (it may belong to other agencies)
    const two = await addMember(A, 'admin'); const adm2 = ((await A.get('/team')).body as any[]).find((m) => m.user_id === two.userId); expect((await A.put(`/team/${adm2.id}`, { role: 'agent' })).status).toBe(200);   // not the last admin any more
  });
  it('renames and deletes branches, refusing while they are in use', async () => {
    const br = (await A.post('/accounting/branches', { name: 'Sydney' })).body.id; if (!br) return;
    expect((await A.put(`/accounting/branches/${br}`, { name: 'Sydney CBD' })).status).toBe(200); expect((await A.get('/accounting/branches')).body.some((b: any) => b.name === 'Sydney CBD')).toBe(true);
    await sql('UPDATE memberships SET branch_id = ? WHERE agency_id = ? AND role = ?', [br, A.agencyId, 'viewer']);
    const used = await A.del(`/accounting/branches/${br}`); expect(used.status).toBe(409); expect(used.body.error).toMatch(/team members?/);
    await sql('UPDATE memberships SET branch_id = NULL WHERE agency_id = ?', [A.agencyId]); expect((await A.del(`/accounting/branches/${br}`)).status).toBe(200);
    expect((await B.put(`/accounting/branches/${br}`, { name: 'x' })).status).toBe(404); expect((await agent.del(`/accounting/branches/${br}`)).status).toBe(403);
  });
});
