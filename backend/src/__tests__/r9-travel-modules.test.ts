import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normalizeNumber, testSmsOutbox } from '../services/sms.js';
import { voucherHtml, voucherKind, voucherNo } from '../services/vouchers.js';
import { Api, addMember, boot, newAgency, seedBasics, shutdown, sql, ticketBody } from './helpers.js';

let A: Api, B: Api, agent: Api, agent2: Api, viewer: Api; let s: Awaited<ReturnType<typeof seedBasics>>; let clientId: number;

beforeAll(async () => {
  await boot(); A = await newAgency('Modules A'); B = await newAgency('Modules B'); s = await seedBasics(A);
  agent = await addMember(A, 'agent'); agent2 = await addMember(A, 'agent'); viewer = await addMember(A, 'viewer');
  clientId = (await A.post('/clients', { name: 'Visa Client', email: 'v@example.com' })).body.id;
});
afterAll(shutdown);

const visaBody = (over: Record<string, unknown> = {}) => ({ client_id: clientId, applicant_name: 'Sara Malik', country: 'Saudi Arabia', currency: 'USD', cost: 50, price: 120, ...over });

describe('visa processing', () => {
  it('opens a numbered file, moves it through the pipeline and keeps a history', async () => {
    const r = await A.post('/visas', visaBody()); expect(r.status).toBe(201);
    const id = r.body.id;
    expect((await A.get(`/visas/${id}`)).body.reference).toMatch(/^VS-\d{6}$/);
    expect((await A.put(`/visas/${id}`, { status: 'docs_received' })).status).toBe(200);
    expect((await A.put(`/visas/${id}`, { status: 'submitted' })).status).toBe(200);
    const v = (await A.get(`/visas/${id}`)).body;
    expect(v.status).toBe('submitted'); expect(String(v.submitted_on).slice(0, 10)).toMatch(/^\d{4}-\d{2}-\d{2}$/);        // submission date stamped automatically
    expect(v.events.map((e: any) => e.status)).toEqual(['submitted', 'docs_received', 'docs_pending']);
  });
  it('will not mark a visa approved without its number or validity dates', async () => {
    const id = (await A.post('/visas', visaBody())).body.id;
    const bad = await A.put(`/visas/${id}`, { status: 'approved' }); expect(bad.status).toBe(400); expect(bad.body.error).toMatch(/visa number/i);
    expect((await A.put(`/visas/${id}`, { status: 'approved', visa_number: 'SA-1' })).status).toBe(200);
    expect(String((await A.get(`/visas/${id}`)).body.decided_on).slice(0, 4)).toMatch(/^\d{4}$/);
  });
  it('only an unsubmitted or cancelled file can be deleted', async () => {
    const id = (await A.post('/visas', visaBody())).body.id;
    await A.put(`/visas/${id}`, { status: 'submitted' });
    expect((await A.del(`/visas/${id}`)).status).toBe(409);
    await A.put(`/visas/${id}`, { status: 'cancelled', note: 'client changed plans' });
    expect((await A.del(`/visas/${id}`)).status).toBe(200);
    expect((await A.get(`/visas/${id}`)).status).toBe(404);
  });
  it('is read-only for viewers, own-records-only for agents, and invisible to other agencies', async () => {
    expect((await viewer.post('/visas', visaBody())).status).toBe(403);
    const mine = (await agent.post('/visas', visaBody({ applicant_name: 'Agent One' }))).body.id;
    expect((await agent2.get(`/visas/${mine}`)).status).toBe(404);
    expect(((await agent2.get('/visas')).body as any[]).some((v) => v.id === mine)).toBe(false);
    expect((await agent2.put(`/visas/${mine}`, { notes: 'x' })).status).toBe(404);
    expect(((await A.get('/visas')).body as any[]).some((v) => v.id === mine)).toBe(true);
    expect((await B.get(`/visas/${mine}`)).status).toBe(404);
    const bClient = (await B.post('/clients', { name: 'B client' })).body.id;
    expect((await B.post('/visas', visaBody({ client_id: clientId }))).status).toBeGreaterThanOrEqual(400);                 // cannot attach another agency's client
    expect((await B.post('/visas', visaBody({ client_id: bClient }))).status).toBe(201);
  });
  it('blocks deleting a client that has a visa file', async () => {
    const c = (await A.post('/clients', { name: 'Has visa' })).body.id; await A.post('/visas', visaBody({ client_id: c }));
    expect((await A.get(`/clients/${c}/usage`)).body.can_delete).toBe(false);
  });
});

describe('service vouchers', () => {
  it('names each voucher for what it covers, and shows no prices', () => {
    expect(voucherKind('hotel').title).toBe('Hotel Voucher'); expect(voucherKind('car').title).toBe('Car Rental Voucher'); expect(voucherKind('visa').title).toBe('Service Voucher');
    expect(voucherNo('hotel', 'BK-1', 7)).toBe('HV-BK-1-7');
    const html = voucherHtml({ name: 'Horizon' }, { reference: 'BK-1', destination: 'Bali' },
      { id: 7, product_type: 'hotel', description: 'Sea view <b>room</b>', service_start: '2027-03-10', service_end: '2027-03-12', quantity: 1, supplier_ref: 'ABC123', confirmation_status: 'confirmed', unit_cost: 987.65, net_total: 1234.56, cost_total: 987.65 },
      { name: 'Coral Resorts' }, [{ first_name: 'Sara', last_name: 'Malik' }], { name: 'Sara Malik' }, null);
    expect(html).toContain('HOTEL VOUCHER'); expect(html).toContain('Sara Malik'); expect(html).toContain('ABC123'); expect(html).toContain('2 nights'); expect(html).toContain('Confirmed');
    expect(html).not.toContain('987.65'); expect(html).not.toContain('1234.56'); expect(html).not.toMatch(/1,234/);                    // cost and selling price never appear
    expect(html).toContain('Sea view &lt;b&gt;room'); expect(html).not.toContain('<b>room');   // guest-supplied text is escaped
    expect(voucherHtml({ name: 'H' }, { reference: 'BK-1' }, { id: 1, product_type: 'car', description: 'x', quantity: 1, confirmation_status: 'pending' }, null, [], { name: 'C' }, null)).toContain('Provisional');
  });
  it('refuses a voucher for a cancelled item and for another agency', async () => {
    const bk = (await A.post('/bookings', { client_id: clientId, destination: 'Bali', status: 'confirmed' })).body.id;
    const comp = (await A.post(`/bookings/${bk}/components`, { product_type: 'hotel', description: 'Room', unit_cost: 100, markup_pct: 10, quantity: 1 })).body.id;
    await A.put(`/bookings/${bk}/components/${comp}`, { product_type: 'hotel', description: 'Room', unit_cost: 100, markup_pct: 10, quantity: 1, confirmation_status: 'cancelled' });
    expect((await A.get(`/bookings/${bk}/components/${comp}/voucher-url`)).status).toBe(409);
    expect((await B.get(`/bookings/${bk}/components/${comp}/voucher-url`)).status).toBe(404);
    expect((await A.get(`/bookings/${bk}/components/999999/voucher-url`)).status).toBe(404);
  });
});

describe('airline remittance and BSP reconciliation', () => {
  const issue = async (ticket_no: string, fare: number, passenger: string) => {
    const body = ticketBody(s.client, s.airline); body.lines = [{ ...body.lines[0], ticket_no, fare, fare_inc: fare, passenger_name: passenger }];
    const id = (await A.post('/tickets/invoices', body)).body.id; expect((await A.post(`/tickets/invoices/${id}/supervise`)).status).toBe(200); return id;
  };
  let payable: Record<string, number> = {};
  beforeAll(async () => {
    await issue('2141111111', 1000, 'ONE'); await issue('2142222222', 2000, 'TWO'); await issue('2143333333', 3000, 'THREE');
    for (const r of await sql(`SELECT l.ticket_no, l.payable FROM ticket_lines l WHERE l.agency_id = ? AND l.ticket_no IN ('2141111111','2142222222','2143333333')`, [A.agencyId])) payable[r.ticket_no] = Number(r.payable);
  });
  const rec = (lines: { ticket_no: string; amount: number }[], over: Record<string, unknown> = {}) => A.post('/tickets/bsp-reconcile', { from: '2000-01-01', to: '2099-12-31', airline_id: s.airline, lines, ...over });

  it('totals what is owed to each airline for the period', async () => {
    const r = (await A.get(`/tickets/reports/airline-remittance?from=2000-01-01&to=2099-12-31&airline_id=${s.airline}`)).body;
    expect(r.airlines).toHaveLength(1); expect(r.airlines[0].tickets).toBe(3);
    expect(r.airlines[0].net).toBeCloseTo(Object.values(payable).reduce((a, b) => a + b, 0), 2);
    expect(r.lines).toHaveLength(3);
  });
  it('matches by ticket number whatever the formatting, and flags differences, missing tickets and duplicates', async () => {
    const r = (await rec([
      { ticket_no: '214-1111111', amount: payable['2141111111'] },          // dashes and a prefix-free number still match
      { ticket_no: '065-2142222222', amount: payable['2142222222'] + 5 }, // airline-prefixed 13-digit form of the same ticket, wrong amount
      { ticket_no: '9999999999', amount: 40 },                              // not in our books
      { ticket_no: '2141111111', amount: 1 },                               // duplicate line on the statement
    ])).body;
    expect(r.totals).toMatchObject({ matched: 1, different: 1, missing_in_bsp: 1, missing_in_system: 1, duplicates: 1, bsp_lines: 3 });
    expect(r.different[0]).toMatchObject({ passenger: 'TWO', diff: 5 });
    expect(r.missing_in_bsp[0].passenger).toBe('THREE');
    expect(r.missing_in_system[0]).toMatchObject({ ticket_no: '9999999999', in_other_period: false });
  });
  it('can compare against gross ticket value and tells you when a ticket sits in another period', async () => {
    const gross = (await rec([{ ticket_no: '2141111111', amount: 1070 }], { basis: 'gross' })).body;
    expect(gross.totals.matched + gross.totals.different).toBe(1);
    const other = (await rec([{ ticket_no: '2141111111', amount: 1 }], { from: '1990-01-01', to: '1990-01-31' })).body;
    expect(other.missing_in_system[0].in_other_period).toBe(true);
  });
  it('validates input, is finance-only to run, and never sees another agency', async () => {
    expect((await rec([])).status).toBe(400);
    expect((await rec([{ ticket_no: '2141111111', amount: 1 }], { from: '2030-01-02', to: '2030-01-01' })).status).toBe(400);
    expect((await agent.post('/tickets/bsp-reconcile', { from: '2000-01-01', to: '2099-12-31', lines: [{ ticket_no: '2141111111', amount: 1 }] })).status).toBe(403);
    expect((await agent.get('/tickets/reports/airline-remittance')).status).toBe(403);
    const b = (await B.post('/tickets/bsp-reconcile', { from: '2000-01-01', to: '2099-12-31', lines: [{ ticket_no: '2141111111', amount: 1 }] })).body;
    expect(b.totals.matched + b.totals.different).toBe(0); expect(b.totals.missing_in_system).toBe(1);
    expect((await B.get('/tickets/reports/airline-remittance?from=2000-01-01&to=2099-12-31')).body.airlines).toHaveLength(0);
  });
});

describe('umrah groups', () => {
  const future = (days: number) => new Date(Date.now() + days * 864e5).toISOString().slice(0, 10);
  const group = (over: Record<string, unknown> = {}) => ({ name: 'Group A', departure_date: future(60), return_date: future(74), currency: 'USD', capacity: 2, cost_per_pax: 1000, price_per_pax: 1300, ...over });
  const pilgrim = (over: Record<string, unknown> = {}) => ({ client_id: clientId, name: 'Ahmed Khan', ...over });

  it('creates numbered groups and rejects a return before departure', async () => {
    const g = await A.post('/umrah/groups', group()); expect(g.status).toBe(201);
    expect((await A.get(`/umrah/groups/${g.body.id}`)).body.reference).toMatch(/^UM-\d{6}$/);
    expect((await A.post('/umrah/groups', group({ return_date: future(10) }))).status).toBe(400);
  });
  it('never sells more seats than the group has, even for a batch', async () => {
    const id = (await A.post('/umrah/groups', group())).body.id;
    expect((await A.post(`/umrah/groups/${id}/pilgrims`, [pilgrim({ name: 'One' }), pilgrim({ name: 'Two' })])).status).toBe(201);
    const full = await A.post(`/umrah/groups/${id}/pilgrims`, pilgrim({ name: 'Three' })); expect(full.status).toBe(409); expect(full.body.error).toMatch(/seats/i);
    const two = (await A.get(`/umrah/groups/${id}`)).body.pilgrims[0].id;
    await A.put(`/umrah/pilgrims/${two}`, { status: 'cancelled' });                       // a cancelled pilgrim frees the seat
    expect((await A.post(`/umrah/groups/${id}/pilgrims`, pilgrim({ name: 'Three' }))).status).toBe(201);
    expect((await A.put(`/umrah/groups/${id}`, { capacity: 1 })).status).toBe(409);       // cannot shrink below who is registered
  });
  it('judges readiness from the passport (6 months after return) and the visa', async () => {
    const id = (await A.post('/umrah/groups', group({ capacity: 0 }))).body.id;
    const ok = future(400), short = future(100), expired = '2020-01-01';
    await A.post(`/umrah/groups/${id}/pilgrims`, [pilgrim({ name: 'Good', passport_expiry: ok }), pilgrim({ name: 'Short', passport_expiry: short }), pilgrim({ name: 'Old', passport_expiry: expired }), pilgrim({ name: 'None' })]);
    const byName = (g: any) => Object.fromEntries(g.pilgrims.map((p: any) => [p.name, p]));
    let g = (await A.get(`/umrah/groups/${id}`)).body, p = byName(g);
    expect([p.Good.passport_state, p.Short.passport_state, p.Old.passport_state, p.None.passport_state]).toEqual(['ok', 'short', 'expired', 'missing']);
    expect(g.summary.ready).toBe(0);                                                       // a good passport alone is not enough
    const made = await A.post(`/umrah/groups/${id}/visas`); expect(made.body.created).toBe(4);
    expect((await A.post(`/umrah/groups/${id}/visas`)).body.created).toBe(0);               // idempotent: nobody gets a second file
    g = (await A.get(`/umrah/groups/${id}`)).body; p = byName(g);
    expect(p.Good.visa_status).toBe('docs_pending');
    expect((await A.put(`/visas/${(await sql('SELECT visa_id FROM umrah_pilgrims WHERE id = ?', [p.Good.id]))[0].visa_id}`, { status: 'approved', visa_number: 'V1' })).status).toBe(200);
    g = (await A.get(`/umrah/groups/${id}`)).body; expect(byName(g).Good.ready).toBe(true); expect(g.summary.ready).toBe(1);
    expect(g.summary.revenue).toBe(5200);
  });
  it('scopes agents to their own groups and keeps other agencies out', async () => {
    const mine = (await agent.post('/umrah/groups', group({ name: 'Agent group' }))).body.id;
    expect((await agent2.get(`/umrah/groups/${mine}`)).status).toBe(404);
    expect((await agent2.post(`/umrah/groups/${mine}/pilgrims`, pilgrim())).status).toBe(404);
    expect((await viewer.post('/umrah/groups', group())).status).toBe(403);
    expect((await B.get(`/umrah/groups/${mine}`)).status).toBe(404);
    expect(((await B.get('/umrah/groups')).body as any[]).some((g) => g.id === mine)).toBe(false);
    const pid = (await agent.post(`/umrah/groups/${mine}/pilgrims`, pilgrim())).body.ids[0];
    expect((await agent2.put(`/umrah/pilgrims/${pid}`, { notes: 'x' })).status).toBe(404);
    expect((await B.del(`/umrah/pilgrims/${pid}`)).status).toBe(404);
  });
  it('only an empty group can be deleted', async () => {
    const id = (await A.post('/umrah/groups', group())).body.id; await A.post(`/umrah/groups/${id}/pilgrims`, pilgrim());
    expect((await A.del(`/umrah/groups/${id}`)).status).toBe(409);
  });
});

describe('operations reminders', () => {
  it('lists upcoming birthdays of travellers on live bookings', async () => {
    const soon = new Date(Date.now() + 3 * 864e5), dob = `${soon.getUTCFullYear() - 30}-${String(soon.getUTCMonth() + 1).padStart(2, '0')}-${String(soon.getUTCDate()).padStart(2, '0')}`;
    const tr = (await A.post('/travellers', { client_id: clientId, first_name: 'Birthday', last_name: 'Person', dob })).body.id;
    const bk = (await A.post('/bookings', { client_id: clientId, destination: 'Rome', status: 'confirmed' })).body.id;
    await A.post(`/bookings/${bk}/travellers`, { traveller_id: tr });
    const rows = (await A.get('/ops/deadlines?days=14')).body as any[];
    const b = rows.find((r) => r.kind === 'birthday' && /Birthday Person/.test(r.title)); expect(b).toBeTruthy(); expect(b.title).toMatch(/turns 30/); expect(b.ref_id).toBe(bk);
    expect(((await B.get('/ops/deadlines?days=14')).body as any[]).some((r) => /Birthday Person/.test(r.title))).toBe(false);
  });
});

describe('text messages (SMS)', () => {
  const SID = `AC${'a'.repeat(32)}`, TOKEN = 'secret-token-0123456789';
  it('reads local and international numbers the way people write them', () => {
    expect(normalizeNumber('+92 300 1234567')).toBe('+923001234567'); expect(normalizeNumber('0300-1234567', '+92')).toBe('+923001234567'); expect(normalizeNumber('00971 50 123 4567')).toBe('+971501234567');
    expect(normalizeNumber('0300 1234567')).toBeNull();            // no country code to apply
    expect(normalizeNumber('12345')).toBeNull(); expect(normalizeNumber('hello')).toBeNull();
  });
  it('cannot send until an admin connects it, and only an admin can connect it', async () => {
    expect((await A.get('/sms/status')).body.configured).toBe(false);
    const early = await A.post('/sms/send', { to: '+923001234567', body: 'Hi' }); expect(early.status).toBe(409); expect(early.body.error).toMatch(/not set up/i);
    expect((await agent.put('/sms/settings', { account_sid: SID, auth_token: TOKEN, from: '+14155550100' })).status).toBe(403);
    expect((await A.put('/sms/settings', { account_sid: 'nope', auth_token: TOKEN, from: '+14155550100' })).status).toBe(400);
    expect((await A.put('/sms/settings', { account_sid: SID, from: '+14155550100' })).status).toBe(400);              // first save needs the token
    expect((await A.put('/sms/settings', { account_sid: SID, auth_token: TOKEN, from: '+14155550100', default_cc: '+92' })).status).toBe(200);
  });
  it('never gives the auth token back, and stores it encrypted', async () => {
    const s = (await A.get('/sms/settings')).body; expect(s.configured).toBe(true); expect(JSON.stringify(s)).not.toContain(TOKEN); expect(s.account_sid).toMatch(/…/);
    expect((await agent.get('/sms/settings')).status).toBe(403);
    expect((await sql('SELECT config_enc FROM sms_settings WHERE agency_id = ?', [A.agencyId]))[0].config_enc).not.toContain(TOKEN);
    expect((await agent.get('/sms/status')).body.configured).toBe(true);
    expect((await A.put('/sms/settings', { account_sid: SID, from: '+14155550100', default_cc: '+92' })).status).toBe(200);   // later saves keep the saved token
  });
  it('texts a client at their saved number, logs it, and explains missing numbers', async () => {
    const c = (await A.post('/clients', { name: 'Texty', phone: '0300-1112223' })).body.id, none = (await A.post('/clients', { name: 'No Phone' })).body.id;
    testSmsOutbox.length = 0;
    expect((await agent.post('/sms/send', { client_id: c, body: 'Your trip is confirmed', entity_type: 'booking', entity_id: 1 })).status).toBe(200);
    expect(testSmsOutbox).toEqual([{ to: '+923001112223', body: 'Your trip is confirmed', from: '+14155550100' }]);
    const noPhone = await A.post('/sms/send', { client_id: none, body: 'Hi' }); expect(noPhone.status).toBe(409); expect(noPhone.body.error).toMatch(/no phone number/i);
    expect((await A.post('/sms/send', { to: '12345', body: 'Hi' })).status).toBe(400);
    expect((await viewer.post('/sms/send', { client_id: c, body: 'Hi' })).status).toBe(403);
    expect((await A.post('/sms/send', { client_id: c, body: 'x'.repeat(481) })).status).toBe(400);
    const log = (await A.get('/sms/log')).body as any[]; expect(log[0]).toMatchObject({ to_number: '+923001112223', status: 'sent', client_name: 'Texty', entity_type: 'booking' });
    expect((await agent.get('/sms/log')).status).toBe(403);
  });
  it('is invisible to other agencies', async () => {
    expect((await B.get('/sms/status')).body.configured).toBe(false);
    expect((await B.post('/sms/send', { to: '+923001234567', body: 'Hi' })).status).toBe(409);
    expect((await B.get('/sms/log')).body).toEqual([]);
    const other = (await A.post('/clients', { name: 'Mine', phone: '+923001234567' })).body.id;
    expect((await B.post('/sms/send', { client_id: other, body: 'Hi' })).status).toBeGreaterThanOrEqual(404);
  });
  it('disconnecting removes the credentials', async () => {
    expect((await A.del('/sms/settings')).status).toBe(200); expect((await A.get('/sms/status')).body.configured).toBe(false);
    expect((await sql('SELECT id FROM sms_settings WHERE agency_id = ?', [A.agencyId]))).toHaveLength(0);
  });
});
