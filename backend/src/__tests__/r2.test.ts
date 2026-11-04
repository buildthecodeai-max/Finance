import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, addMember, apiBase, boot, newAgency, shutdown, sql } from './helpers.js';

let A: Api, B: Api, agent: Api, agent2: Api, finance: Api, viewer: Api; let clientId: number, supplierId: number;
let base = '';
const future = (days: number) => new Date(Date.now() + days * 864e5).toISOString().slice(0, 10);
const comp = (o: Record<string, unknown> = {}) => ({ product_type: 'hotel', description: 'Bali resort 5n', quantity: 1, unit_cost: 1000, markup_pct: 20, tax_rate: 10, supplier_id: supplierId, service_start: '2026-12-10', service_end: '2026-12-15', ...o });
const quoteBody = (extra: Record<string, unknown> = {}) => ({
  title: 'Bali family trip', client_id: clientId, currency: 'USD', cancellation_terms: '50% within 30 days', internal_notes: 'SECRET margin note', inclusions: 'Breakfast daily',
  components: [comp({ option_name: 'Standard' }), comp({ option_name: 'Premium', unit_cost: 1500, description: 'Premium villa' })], ...extra,
});
async function pub(token: string, path = '', method = 'GET', body?: unknown) {
  const r = await fetch(`${base}/public/quotes/${token}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let json: any; try { json = JSON.parse(text); } catch { json = text; } return { status: r.status, body: json, text };
}
const tokenOf = (link: string) => link.split('/q/')[1];

beforeAll(async () => {
  await boot(); base = apiBase(); A = await newAgency('R2A'); B = await newAgency('R2B');
  agent = await addMember(A, 'agent'); agent2 = await addMember(A, 'agent'); finance = await addMember(A, 'finance_manager'); viewer = await addMember(A, 'viewer');
  clientId = (await A.post('/clients', { name: 'Nguyen Family', email: 'ng@test.dev', currency: 'USD' })).body.id;
  supplierId = (await A.post('/suppliers', { name: 'Coral Resorts', supplier_type: 'hotel' })).body.id;
});
afterAll(shutdown);

describe('leads & CRM', () => {
  it('creates leads, warns on duplicates, takes an optional lost reason', async () => {
    const l1 = await A.post('/leads', { name: 'Amir Khan', email: 'amir@test.dev', phone: '555-1', destination: 'Dubai', party_size: 2 }); expect(l1.status).toBe(201);
    const l2 = await A.post('/leads', { name: 'A. Khan', email: 'amir@test.dev' }); expect(l2.body.duplicates.length).toBeGreaterThan(0);
    expect((await A.put(`/leads/${l1.body.id}`, { stage: 'lost', lost_reason: 'Too expensive' })).status).toBe(200);
    const d = (await A.get(`/leads/${l1.body.id}`)).body; expect(d.activities.some((a: any) => /Stage changed/.test(a.body))).toBe(true);
  });
  it('converts a lead to a client exactly once', async () => {
    const id = (await A.post('/leads', { name: 'Lina Perez', email: 'lina@test.dev' })).body.id;
    const a = await A.post(`/leads/${id}/convert-client`), b = await A.post(`/leads/${id}/convert-client`);
    expect(a.status).toBe(201); expect(b.status).toBe(200); expect(b.body.client_id).toBe(a.body.client_id); expect(b.body.existing).toBe(true);
    expect((await sql(`SELECT COUNT(*) n FROM clients WHERE agency_id = ? AND email = 'lina@test.dev'`, [A.agencyId]))[0].n).toBe(1);
  });
  it('agents see and edit only their own leads and cannot reassign', async () => {
    const mine = (await agent.post('/leads', { name: 'Agent lead' })).body.id;
    const other = (await agent2.post('/leads', { name: 'Other agent lead' })).body.id;
    expect(((await agent.get('/leads')).body as any[]).every((l) => l.owner_id === agent.userId)).toBe(true);
    expect((await agent.get(`/leads/${other}`)).status).toBe(404);
    expect((await agent.put(`/leads/${other}`, { stage: 'contacted' })).status).toBe(404);
    expect((await agent.put(`/leads/${mine}`, { owner_id: agent2.userId, next_action: 'call' })).status).toBe(200);
    expect((await sql('SELECT owner_id FROM leads WHERE id = ?', [mine]))[0].owner_id).toBe(agent.userId);
    expect(((await A.get('/leads')).body as any[]).length).toBeGreaterThan(2);
    expect((await viewer.post('/leads', { name: 'x' })).status).toBe(403);
  });
  it("other agencies can't see leads or reference this agency's users/clients", async () => {
    const id = (await A.post('/leads', { name: 'Private' })).body.id;
    expect((await B.get(`/leads/${id}`)).status).toBe(404); expect((await B.put(`/leads/${id}`, { stage: 'won' })).status).toBe(404);
    expect((await B.post('/leads', { name: 'x', owner_id: A.userId })).status).toBe(400);
    expect((await B.post('/leads', { name: 'x', client_id: clientId })).status).toBe(400);
    expect((await B.post('/crm/activities', { entity_type: 'lead', entity_id: id, body: 'hi' })).status).toBe(404);
    expect((await B.post('/crm/activities', { entity_type: 'client', entity_id: clientId, body: 'hi' })).status).toBe(400);
    expect((await B.get(`/crm/timeline/client/${clientId}`)).status).toBe(400);
  });
  it('timeline merges activity and quotes for a client', async () => {
    await A.post('/crm/activities', { entity_type: 'client', entity_id: clientId, kind: 'call', body: 'Called about Bali' });
    await A.post('/quotes', quoteBody());
    const tl = (await A.get(`/crm/timeline/client/${clientId}`)).body as any[];
    expect(tl.map((x) => x.type)).toEqual(expect.arrayContaining(['activity', 'quote']));
  });
});

describe('tasks & deadlines', () => {
  it('tasks complete once; deadlines surface overdue work and unconfirmed suppliers', async () => {
    const bk = (await A.post('/bookings', { client_id: clientId, destination: 'Bali', status: 'confirmed', travel_start: future(5) })).body.id;
    await A.post(`/bookings/${bk}/components`, comp({ service_start: future(4) }));
    const t1 = (await A.post('/crm/tasks', { title: 'Chase supplier', due_at: '2020-01-01', entity_type: 'booking', entity_id: bk, priority: 'urgent' })).body.id;
    const d = (await A.get('/ops/deadlines?days=30')).body as any[];
    expect(d.map((x) => x.kind)).toEqual(expect.arrayContaining(['overdue_task', 'unconfirmed_supplier', 'departure']));
    expect((await A.post(`/crm/tasks/${t1}/complete`, { notes: 'Done by phone' })).status).toBe(200);
    expect((await A.post(`/crm/tasks/${t1}/complete`)).status).toBe(409);
    expect(((await A.get('/ops/deadlines?days=30')).body as any[]).some((x) => x.kind === 'overdue_task')).toBe(false);
  });
  it('agents only get their own tasks', async () => {
    await agent.post('/crm/tasks', { title: 'mine' }); await agent2.post('/crm/tasks', { title: 'theirs' });
    expect(((await agent.get('/crm/tasks')).body as any[]).every((t) => t.owner_id === agent.userId)).toBe(true);
  });
});

describe('quotes: pricing, versions, guardrails', () => {
  let qid: number; let token = '';
  it('prices options independently with margin', async () => {
    qid = (await agent.post('/quotes', quoteBody())).body.id;
    const q = (await agent.get(`/quotes/${qid}`)).body;
    const std = q.options.find((o: any) => o.option === 'Standard');
    expect(std).toMatchObject({ net: 1200, tax: 120, total: 1320, cost: 1000 }); expect(std.margin_pct).toBeCloseTo(16.67, 1);
    expect(q.options).toHaveLength(2); expect(q.quote_no).toMatch(/^QT-\d{6}$/);
  });
  it('keeps options in the order the agent created them', async () => {
    const id = (await agent.post('/quotes', quoteBody({ components: [comp({ option_name: 'Zebra' }), comp({ option_name: 'Alpha' })] }))).body.id;
    expect((await agent.get(`/quotes/${id}`)).body.options.map((o: any) => o.option)).toEqual(['Zebra', 'Alpha']);
  });
  it('blocks sending below the minimum margin until finance approves', async () => {
    expect((await A.put('/admin/settings', { min_margin_pct: 20, reason: 'guardrail' })).status).toBe(200);
    const r = await agent.post(`/quotes/${qid}/send`, {}); expect(r.status).toBe(409); expect(r.body.error).toMatch(/below the agency minimum/);
    expect((await agent.post(`/quotes/${qid}/approve-margin`)).status).toBe(403);
    expect((await finance.post(`/quotes/${qid}/approve-margin`)).status).toBe(200);
    expect((await A.put('/admin/settings', { min_margin_pct: 0, reason: 'reset' })).status).toBe(200);
  });
  it('sends a secure link whose client view hides costs and internal notes', async () => {
    const r = await agent.post(`/quotes/${qid}/send`, { valid_until: future(10) });
    expect(r.status).toBe(200); token = tokenOf(r.body.link); expect(token.length).toBeGreaterThan(40);
    expect((await sql('SELECT public_token_hash FROM quotes WHERE id = ?', [qid]))[0].public_token_hash).not.toContain(token);
    const v = await pub(token); expect(v.status).toBe(200);
    expect(v.text).not.toMatch(/SECRET|unit_cost|cost_total|markup|supplier|Coral/i);
    expect(v.body.options[0].items[0]).toHaveProperty('unit_price');
  });
  it('rejects wrong and malformed tokens identically', async () => {
    for (const bad of ['x'.repeat(43), 'short', 'a'.repeat(200)]) expect((await pub(bad)).status).toBe(404);
  });
  it('editing a sent quote creates v2, returns to draft and revokes the old link; v1 stays immutable', async () => {
    const fresh = (await agent.post('/quotes', quoteBody())).body.id;
    const t1 = tokenOf((await agent.post(`/quotes/${fresh}/send`, {})).body.link);
    const v1Before = (await agent.get(`/quotes/${fresh}/versions/1`)).body.components.map((c: any) => c.net_total);
    const r = await agent.put(`/quotes/${fresh}`, quoteBody({ components: [comp({ option_name: 'Standard', unit_cost: 2000 })] }));
    expect(r.body.version).toBe(2);
    const q = (await agent.get(`/quotes/${fresh}`)).body; expect(q.status).toBe('draft'); expect(q.current_version).toBe(2); expect(q.versions).toHaveLength(2);
    expect((await agent.get(`/quotes/${fresh}/versions/1`)).body.components.map((c: any) => c.net_total)).toEqual(v1Before);
    expect((await pub(t1)).status).toBe(404); expect((await pub(t1, '/accept', 'POST', { name: 'Late Client' })).status).toBe(404);
  });
  it('an unsent draft is edited in place (no new version)', async () => {
    const d = (await agent.post('/quotes', quoteBody())).body.id;
    expect((await agent.put(`/quotes/${d}`, quoteBody({ title: 'Renamed' }))).body.version).toBe(1);
    expect((await agent.get(`/quotes/${d}`)).body.versions).toHaveLength(1);
  });
  it("another agent cannot touch the quote; other agencies can't see it", async () => {
    expect((await agent2.get(`/quotes/${qid}`)).status).toBe(404); expect((await agent2.put(`/quotes/${qid}`, quoteBody())).status).toBe(404);
    expect((await B.get(`/quotes/${qid}`)).status).toBe(404); expect((await B.post(`/quotes/${qid}/send`, {})).status).toBe(404);
    expect((await B.post('/quotes', quoteBody())).status).toBe(400);
  });
  it('client can request changes or decline; both are recorded', async () => {
    const a = (await A.post('/quotes', quoteBody())).body.id, tok = tokenOf((await A.post(`/quotes/${a}/send`, {})).body.link);
    expect((await pub(tok, '/changes', 'POST', { message: 'Can we add a transfer?' })).status).toBe(200);
    const q = (await A.get(`/quotes/${a}`)).body; expect(q.status).toBe('changes_requested'); expect(q.activities[0].body).toMatch(/transfer/);
    expect((await pub(tok, '/accept', 'POST', { name: 'Someone' })).status).toBe(409);
  });
});

describe('quote → booking conversion', () => {
  let qid: number, token: string;
  it('accept via public link records version, option, name and IP; only once', async () => {
    qid = (await agent.post('/quotes', quoteBody())).body.id;
    token = tokenOf((await agent.post(`/quotes/${qid}/send`, {})).body.link);
    expect((await pub(token, '/accept', 'POST', { name: 'Nguyen', option: 'Nope' })).status).toBe(400);
    expect((await pub(token, '/accept', 'POST', { name: 'Nguyen Van A', option: 'Premium' })).status).toBe(200);
    expect((await pub(token, '/accept', 'POST', { name: 'Nguyen Van A', option: 'Premium' })).status).toBe(409);
    const row = (await sql('SELECT status, accepted_version, accepted_option, accepted_by_name, accepted_ip, accepted_at FROM quotes WHERE id = ?', [qid]))[0];
    expect(row).toMatchObject({ status: 'accepted', accepted_version: 1, accepted_option: 'Premium', accepted_by_name: 'Nguyen Van A' }); expect(row.accepted_ip).toBeTruthy(); expect(row.accepted_at).toBeTruthy();
    expect((await agent.put(`/quotes/${qid}`, quoteBody())).status).toBe(409);
  });
  it('converts once, even under concurrent requests; preserves option, terms, prices', async () => {
    const results = await Promise.all([agent.post(`/quotes/${qid}/convert`), agent.post(`/quotes/${qid}/convert`), agent.post(`/quotes/${qid}/convert`)]);
    expect(results.every((r) => [200, 201].includes(r.status))).toBe(true);
    const ids = new Set(results.map((r) => r.body.booking_id)); expect(ids.size).toBe(1);
    expect((await sql('SELECT COUNT(*) n FROM bookings WHERE agency_id = ? AND quote_id = ?', [A.agencyId, qid]))[0].n).toBe(1);
    const bk = (await agent.get(`/bookings/${[...ids][0]}`)).body;
    expect(bk.status).toBe('confirmed'); expect(bk.quote_id).toBe(qid); expect(bk.agent_id).toBe(agent.userId);
    expect(bk.components).toHaveLength(1); expect(bk.components[0]).toMatchObject({ description: 'Premium villa', net_total: 1800, tax_total: 180, cost_total: 1500, cancellation_terms: '50% within 30 days' });
    expect(bk.travel_start).toBe('2026-12-10'); expect(bk.finance.margin_pct).toBeCloseTo(16.67, 1);
    const q = (await agent.get(`/quotes/${qid}`)).body; expect(q.status).toBe('converted'); expect(q.activities.some((a: any) => /Converted to booking/.test(a.body))).toBe(true);
  });
  it('cannot convert an unaccepted quote, or one without a client', async () => {
    const draft = (await agent.post('/quotes', quoteBody())).body.id;
    expect((await agent.post(`/quotes/${draft}/convert`)).status).toBe(409);
    const noClient = (await agent.post('/quotes', quoteBody({ client_id: null }))).body.id;
    await agent.post(`/quotes/${noClient}/send`, {}); expect((await agent.post(`/quotes/${noClient}/accept`, { name: 'Phone' })).status).toBe(200);
    expect((await agent.post(`/quotes/${noClient}/convert`)).status).toBe(409);
  });
  it('an expired quote cannot be accepted', async () => {
    const id = (await agent.post('/quotes', quoteBody())).body.id; const tok = tokenOf((await agent.post(`/quotes/${id}/send`, {})).body.link);
    await sql(`UPDATE quotes SET valid_until = '2020-01-01' WHERE id = ?`, [id]);
    expect((await pub(tok)).body.status).toBe('expired');
    expect((await pub(tok, '/accept', 'POST', { name: 'Too Late' })).status).toBe(410);
  });
  it('lead is marked won when its quote converts', async () => {
    const lid = (await agent.post('/leads', { name: 'Won Lead' })).body.id;
    const cid = (await agent.post(`/leads/${lid}/convert-client`)).body.client_id;
    const q = (await agent.post('/quotes', quoteBody({ client_id: cid, lead_id: lid }))).body.id;
    await agent.post(`/quotes/${q}/send`, {}); await agent.post(`/quotes/${q}/accept`, { name: 'Won' }); await agent.post(`/quotes/${q}/convert`);
    expect((await agent.get(`/leads/${lid}`)).body.stage).toBe('won');
  });
});

describe('booking workspace', () => {
  let bk: number;
  it('creates bookings with generated references and prices components', async () => {
    const r = await agent.post('/bookings', { client_id: clientId, destination: 'Maldives', status: 'quoted', travel_start: '2027-02-01', travel_end: '2027-02-08' }); expect(r.status).toBe(201); bk = r.body.id;
    expect((await agent.post(`/bookings/${bk}/components`, comp({ product_type: 'flight', description: 'KHI-MLE', unit_cost: 500, markup_pct: 10, quantity: 2, tax_rate: 0, discount_pct: 5 }))).status).toBe(201);
    const w = (await agent.get(`/bookings/${bk}`)).body; const k = w.components[0];
    expect(k).toMatchObject({ unit_price: 550, net_total: 1045, tax_total: 0, cost_total: 1000, ticketing_status: 'pending', confirmation_status: 'pending' });
    expect(w.finance).toMatchObject({ selling_net: 1045, supplier_cost: 1000, gross_margin: 45 }); expect(w.reference).toMatch(/^BK-\d+$/);
  });
  it('keeps booking, supplier-confirmation, ticketing and payment statuses separate', async () => {
    const cid = (await agent.get(`/bookings/${bk}`)).body.components[0].id;
    await agent.put(`/bookings/${bk}/components/${cid}`, { confirmation_status: 'confirmed', ticketing_status: 'ticketed', reason: 'Ticket issued' });
    expect((await agent.get(`/bookings/${bk}`)).body.statuses).toMatchObject({ booking: 'quoted', payment: 'not_invoiced', supplier_confirmation: { confirmed: 1 }, ticketing: { ticketed: 1 } });
  });
  it('logs changes with actor and reason; a reason is optional', async () => {
    expect((await agent.put(`/bookings/${bk}`, { status: 'confirmed', travel_start: '2027-02-03' })).status).toBe(200);
    expect((await agent.put(`/bookings/${bk}`, { status: 'cancelled', reason: 'Client illness' })).status).toBe(200);
    const ch = (await agent.get(`/bookings/${bk}`)).body.changes as any[];
    expect(ch.find((c) => c.field === 'status' && c.new_value === 'cancelled')).toMatchObject({ old_value: 'confirmed', reason: 'Client illness' });
    expect(ch.find((c) => c.field === 'travel_start')).toMatchObject({ old_value: '2027-02-01', new_value: '2027-02-03' });
    expect(ch.find((c) => c.field.includes('ticketing_status'))).toBeTruthy();
    await expect(sql('DELETE FROM booking_changes WHERE booking_id = ?', [bk])).rejects.toThrow(/append-only/);
  });
  it('a cancelled booking is frozen; only finance/admin can reopen', async () => {
    expect((await agent.post(`/bookings/${bk}/components`, comp())).status).toBe(409);
    expect((await agent.put(`/bookings/${bk}`, { status: 'confirmed', reason: 'oops' })).status).toBe(403);
    expect((await finance.put(`/bookings/${bk}`, { status: 'confirmed' })).status).toBe(200);   // no reason needed
  });
  it('removing a component is logged', async () => {
    const cid = (await agent.get(`/bookings/${bk}`)).body.components[0].id;
    expect((await agent.del(`/bookings/${bk}/components/${cid}`)).status).toBe(200);
    expect(((await agent.get(`/bookings/${bk}`)).body.changes as any[]).some((c) => /removed/.test(c.field))).toBe(true);
  });
  it('links to generic invoices; drafts are not receivables', async () => {
    expect((await A.post('/invoices', { client_id: clientId, booking_id: bk, currency: 'USD', lines: [{ product_type: 'hotel', description: 'x', unit_cost: 100, markup_pct: 10, tax_rate: 0 }] })).status).toBe(201);
    const w = (await A.get(`/bookings/${bk}`)).body; expect(w.invoices).toHaveLength(1); expect(w.finance.invoiced).toBe(0);
  });
  it('agents only see their own bookings; other agencies see none', async () => {
    expect(((await agent.get('/bookings')).body as any[]).every((b) => b.agent_id === agent.userId)).toBe(true);
    expect((await agent2.get(`/bookings/${bk}`)).status).toBe(404); expect((await B.get(`/bookings/${bk}`)).status).toBe(404);
    expect((await B.put(`/bookings/${bk}`, { destination: 'x' })).status).toBe(404);
    expect((await B.post('/bookings', { client_id: clientId, destination: 'x' })).status).toBe(400);
    expect((await B.post(`/bookings/${bk}/components`, comp())).status).toBe(404);
  });
  it('itinerary items validate component/supplier ownership', async () => {
    const b2 = (await agent.post('/bookings', { client_id: clientId, destination: 'Rome', status: 'confirmed' })).body.id;
    const c1 = (await agent.post(`/bookings/${b2}/components`, comp())).body.id;
    expect((await agent.post(`/bookings/${b2}/itinerary`, { day_no: 1, title: 'Arrive', start_time: '14:30', component_id: c1, confirmed: true })).status).toBe(201);
    expect((await agent.post(`/bookings/${b2}/itinerary`, { day_no: 1, title: 'bad', component_id: 99999 })).status).toBe(400);
    expect((await agent.post(`/bookings/${b2}/itinerary`, { title: 'bad', supplier_id: 99999 })).status).toBe(400);
    expect((await agent.get(`/bookings/${b2}`)).body.itinerary).toHaveLength(1);
  });
});

describe('travellers & passports', () => {
  let tid: number, bk: number;
  it('encrypts passport numbers at rest and masks them in responses', async () => {
    const r = await agent.post('/travellers', { first_name: 'Anh', last_name: 'Nguyen', passport_no: 'P1234567X', passport_expiry: '2027-01-10', client_id: clientId, notes: 'Vegetarian' });
    expect(r.status).toBe(201); tid = r.body.id;
    const row = (await sql('SELECT passport_enc, passport_last4 FROM travellers WHERE id = ?', [tid]))[0];
    expect(row.passport_enc).not.toContain('P1234567X'); expect(row.passport_last4).toBe('567X');
    const list = JSON.stringify((await agent.get('/travellers')).body); expect(list).not.toContain('P1234567X'); expect(list).toContain('••••567X');
    bk = (await agent.post('/bookings', { client_id: clientId, destination: 'Hanoi', status: 'confirmed', travel_start: future(10) })).body.id;
    expect((await agent.post(`/bookings/${bk}/travellers`, { traveller_id: tid, room_group: 'Room 1' })).status).toBe(201);
    expect((await agent.post(`/bookings/${bk}/travellers`, { traveller_id: tid })).status).toBe(409);
    expect(JSON.stringify((await agent.get(`/bookings/${bk}`)).body)).not.toContain('P1234567X');
  });
  it('only admin/finance can reveal a passport, and every reveal is logged', async () => {
    expect((await agent.get(`/travellers/${tid}/passport`)).status).toBe(403); expect((await viewer.get(`/travellers/${tid}/passport`)).status).toBe(403);
    expect((await B.get(`/travellers/${tid}/passport`)).status).toBe(404);
    expect((await finance.get(`/travellers/${tid}/passport`)).body.passport_no).toBe('P1234567X');
    expect((await sql(`SELECT id FROM security_events WHERE event = 'sensitive_view' AND user_id = ?`, [finance.userId])).length).toBe(1);
  });
  it('flags passports expiring within 6 months of travel', async () => {
    expect(((await A.get('/ops/deadlines?days=30')).body as any[]).some((x) => x.kind === 'passport_expiry')).toBe(true);
  });
  it("other agencies can't attach or read travellers", async () => {
    const bc = (await B.post('/clients', { name: 'BC' })).body.id, bbk = (await B.post('/bookings', { client_id: bc, destination: 'x' })).body.id;
    expect((await B.post(`/bookings/${bbk}/travellers`, { traveller_id: tid })).status).toBe(400);
    expect(((await B.get('/travellers')).body as any[]).length).toBe(0);
    expect((await B.post('/travellers', { first_name: 'a', last_name: 'b', client_id: clientId })).status).toBe(400);
  });
});
