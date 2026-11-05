/**
 * Demo agency for showing the product to a prospective client.
 *
 *   npm run seed:demo                       (server must be running; defaults to http://localhost:4000/api)
 *   API_URL=https://your-host/api npm run seed:demo
 *
 * Everything is created through the public API, so numbering, the ledger, permissions and audit all behave exactly as they do for a real agency.
 * Dates are relative to today, so the dashboard always looks current. Re-running refuses to create a second copy.
 *
 * Logins (all use the same password):
 *   demo@sunrise-travel.test      admin            — sees everything
 *   finance@sunrise-travel.test   finance manager  — money screens
 *   agent@sunrise-travel.test     agent            — sales screens, own records only
 *   Password: SunriseDemo#2026
 */
import { pool } from '../src/db.js';
import { deleteAgency } from '../src/services/platform.js';

const BASE = process.env.API_URL ?? 'http://localhost:4000/api';
const PASSWORD = 'SunriseDemo#2026';
const ADMIN = 'demo@sunrise-travel.test';
const AGENCY = 'Sunrise Travel & Tours';

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const day = (n: number) => iso(new Date(Date.now() + n * 864e5));
const ymd = (n: number, yearsBack = 0) => { const d = new Date(Date.now() + n * 864e5); d.setFullYear(d.getFullYear() - yearsBack); return iso(d); };

class Api {
  constructor(public token = '', public agencyId = 0) {}
  async req(method: string, path: string, body?: unknown) {
    const r = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(this.token ? { authorization: `Bearer ${this.token}`, 'x-agency-id': String(this.agencyId) } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text(); let json: any; try { json = JSON.parse(text); } catch { json = text; }
    if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${typeof json === 'string' ? json : JSON.stringify(json)}`);
    return json;
  }
  get = (p: string) => this.req('GET', p); post = (p: string, b: unknown = {}) => this.req('POST', p, b); put = (p: string, b: unknown) => this.req('PUT', p, b);
}

async function main() {
  const probe = await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: ADMIN, password: PASSWORD }) }).catch(() => null);
  if (!probe) throw new Error(`Cannot reach the API at ${BASE}. Start the server first.`);
  if (process.argv.includes('--reset')) {                       // wipe the demo agency (and only it) so it can be rebuilt fresh
    const [rows]: any = await pool.query('SELECT a.id FROM agencies a WHERE a.name = ?', [AGENCY]);
    for (const r of rows) console.log(`Removed the old demo agency (${(await deleteAgency(r.id)).rows} rows)`);
    const [u]: any = await pool.query('SELECT id FROM users WHERE email IN (?,?,?)', [ADMIN, 'finance@sunrise-travel.test', 'agent@sunrise-travel.test']);
    for (const x of u) { await pool.query('DELETE FROM memberships WHERE user_id = ?', [x.id]).catch(() => {}); await pool.query('DELETE FROM users WHERE id = ?', [x.id]).catch(() => {}); }
  } else if (probe.status === 200) { console.log(`The demo agency already exists. Log in as ${ADMIN}, or run with --reset to rebuild it.`); return; }

  const reg = await fetch(`${BASE}/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agencyName: AGENCY, name: 'Amina Raza', email: ADMIN, password: PASSWORD, baseCurrency: 'USD' }) });
  const regBody: any = await reg.json();
  if (reg.status === 403) throw new Error('Sign-up is switched off on this server. Set ALLOW_SIGNUP=true while seeding, then switch it off again.');
  if (reg.status !== 201) throw new Error(`Could not create the agency: ${JSON.stringify(regBody)}`);
  const admin = new Api(regBody.accessToken, regBody.agencies[0].id);
  console.log(`Created agency ${AGENCY} (#${admin.agencyId})`);

  // Letterhead so invoices and vouchers look finished.
  await admin.put('/admin/settings', { name: AGENCY, tax_label: 'GST', address: '21 Marine Drive\nKarachi 75600\nPakistan', timezone: 'Asia/Karachi', invoice_prefix: 'SUN', min_margin_pct: 8,
    bank_name: 'Meridian Bank', bank_account_name: AGENCY, bank_account_number: '0123-4567-8901', bank_iban: 'PK36MERI0000012345678901', bank_swift: 'MERIPKKA' }).catch(() => {});

  // Team
  const addMember = (email: string, name: string, role: string) => admin.post('/team', { email, name, role, password: PASSWORD });
  const login = async (email: string) => { const r = await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }) }); const j: any = await r.json(); return new Api(j.accessToken, admin.agencyId); };
  await addMember('finance@sunrise-travel.test', 'Farhan Siddiqui', 'finance_manager'); await addMember('agent@sunrise-travel.test', 'Sana Malik', 'agent');
  const agent = await login('agent@sunrise-travel.test');

  // Clients
  const cl = async (name: string, email: string, phone: string, terms = 14) => (await admin.post('/clients', { name, email, phone, currency: 'USD', payment_terms_days: terms })).id as number;
  const khan = await cl('Khan Family', 'khan.family@example.com', '+92 300 1112233'), orion = await cl('Orion Textiles Ltd', 'travel@oriontextiles.example', '+92 21 3456 7890', 30), ahmed = await cl('Dr. Imran Ahmed', 'imran.ahmed@example.com', '+92 301 4445566');
  const bright = await cl('Brightpath Schools', 'admin@brightpath.example', '+92 42 3567 8901', 30), noor = await cl('Noor & Hassan', 'noor.hassan@example.com', '+92 333 7778899'), summit = await cl('Summit Outdoors Club', 'trips@summitoutdoors.example', '+92 51 2223344');

  // Suppliers
  const bank = (n: string) => ({ account_name: n, account_number: String(10000000 + Math.floor(Math.random() * 8999999)), bank_name: 'Meridian Bank' });
  const sup = async (name: string, supplier_type: string, terms = 30) => (await admin.post('/suppliers', { name, supplier_type, currency: 'USD', payment_terms_days: terms, email: `accounts@${name.toLowerCase().replace(/[^a-z]+/g, '')}.example`, bank_details: bank(name) })).id as number;
  const bosphorus = await sup('Bosphorus Grand Hotel', 'hotel'), pearl = await sup('Pearl Continental Makkah', 'hotel'), maldives = await sup('Coral Bay Resort Maldives', 'hotel'), drive = await sup('Anatolia Drive & Transfers', 'transfer', 14), alpine = await sup('Alpine Tours Switzerland', 'tour_operator');

  // Airlines (for ticket sales and the BSP / remittance report)
  const turkish = (await admin.post('/airlines', { code: '235', name: 'TURKISH AIRLINES', iata_code: 'TK', commission_pct: 7 })).id as number;
  const emirates = (await admin.post('/airlines', { code: '176', name: 'EMIRATES', iata_code: 'EK', commission_pct: 6 })).id as number;

  // Travellers (one with a birthday this week, one with a passport that is too close to expiry)
  const trav = async (client_id: number, first_name: string, last_name: string, dob: string, passport_expiry: string, nationality = 'Pakistani') =>
    (await admin.post('/travellers', { client_id, first_name, last_name, dob, nationality, passport_no: `AB${Math.floor(1000000 + Math.random() * 8999999)}`, passport_expiry })).id as number;
  const t1 = await trav(khan, 'Tariq', 'Khan', ymd(-130, 44), day(1500)), t2 = await trav(khan, 'Saira', 'Khan', ymd(95, 41), day(1400)), t3 = await trav(khan, 'Zain', 'Khan', ymd(3, 12), day(900));
  const t4 = await trav(ahmed, 'Imran', 'Ahmed', ymd(-80, 52), day(110)), t5 = await trav(noor, 'Noor', 'Fatima', ymd(-200, 29), day(1800)), t6 = await trav(noor, 'Hassan', 'Raza', ymd(-20, 31), day(1700));

  // Bookings with priced items
  const booking = async (api: Api, client_id: number, destination: string, start: number, nights: number, status: string, travellers: number[], items: any[]) => {
    const id = (await api.post('/bookings', { client_id, destination, travel_start: day(start), travel_end: day(start + nights), status, channel: 'phone', trip_purpose: 'leisure' })).id as number;
    for (const t of travellers) await api.post(`/bookings/${id}/travellers`, { traveller_id: t });
    for (const c of items) await api.post(`/bookings/${id}/components`, { quantity: 1, markup_pct: 15, ...c });
    return id;
  };
  const istanbul = await booking(agent, khan, 'Istanbul, Turkey', 21, 7, 'confirmed', [t1, t2, t3], [
    { product_type: 'flight', description: 'KHI–IST return, Turkish Airlines', quantity: 3, unit_cost: 520, markup_pct: 9, supplier_ref: 'TK-9XQ2LM', service_start: day(21), service_end: day(28) },
    { product_type: 'hotel', description: 'Bosphorus Grand Hotel, family suite, 7 nights', unit_cost: 1260, supplier_id: bosphorus, supplier_ref: 'BGH-55120', confirmation_status: 'confirmed', service_start: day(21), service_end: day(28), tax_rate: 8, cancellation_terms: 'Free cancellation until 14 days before arrival.' },
    { product_type: 'transfer', description: 'Airport transfers, private van', quantity: 2, unit_cost: 35, supplier_id: drive, markup_pct: 25, service_start: day(21) }]);
  const maldivesTrip = await booking(admin, noor, 'Maldives', 55, 5, 'confirmed', [t5, t6], [
    { product_type: 'hotel', description: 'Coral Bay Resort, water villa, 5 nights', unit_cost: 2400, supplier_id: maldives, supplier_ref: 'CBR-7781', confirmation_status: 'confirmed', service_start: day(55), service_end: day(60), tax_rate: 8, markup_pct: 18 },
    { product_type: 'flight', description: 'KHI–MLE return, Emirates', quantity: 2, unit_cost: 610, markup_pct: 8, service_start: day(55), service_end: day(60) }]);
  const swiss = await booking(admin, orion, 'Zurich & Interlaken, Switzerland', 12, 8, 'confirmed', [], [
    { product_type: 'tour', description: 'Executive retreat programme, 12 guests', quantity: 12, unit_cost: 840, supplier_id: alpine, supplier_ref: 'ALP-2231', service_start: day(12), service_end: day(20), markup_pct: 14, tax_rate: 0 }]);
  const dubai = await booking(agent, ahmed, 'Dubai, UAE', -40, 4, 'travel_completed', [t4], [
    { product_type: 'hotel', description: 'City Tower Hotel, 4 nights', unit_cost: 780, supplier_ref: 'CTH-901', confirmation_status: 'confirmed', service_start: day(-40), service_end: day(-36), tax_rate: 8 },
    { product_type: 'flight', description: 'KHI–DXB return, Emirates', unit_cost: 430, markup_pct: 8, service_start: day(-40), service_end: day(-36) }]);
  await booking(agent, bright, 'Lahore → Hunza (school trip)', 70, 6, 'enquiry', [], [{ product_type: 'package', description: 'School excursion package, 40 students', quantity: 40, unit_cost: 190, markup_pct: 12 }]);
  await admin.post('/crm/tasks', { title: 'Send final itinerary to the Khan family', entity_type: 'booking', entity_id: istanbul, due_at: day(5), priority: 'high' });
  await admin.post('/crm/tasks', { title: 'Confirm villa upgrade with Coral Bay', entity_type: 'booking', entity_id: maldivesTrip, due_at: day(-1) });

  // Quotes in every state
  const quote = async (api: Api, title: string, client_id: number, options: { name: string; items: any[] }[]) =>
    (await api.post('/quotes', { title, client_id, currency: 'USD', valid_until: day(14), inclusions: 'Return flights, hotel, daily breakfast and airport transfers', payment_terms: '30% deposit to confirm, balance 30 days before travel', cancellation_terms: 'Non-refundable within 14 days of departure',
      components: options.flatMap((o) => o.items.map((c) => ({ option_name: o.name, quantity: 1, markup_pct: 15, ...c }))) })).id as number;
  const items = (h: number, f: number) => [{ product_type: 'hotel', description: 'Hotel, 6 nights', unit_cost: h }, { product_type: 'flight', description: 'Return flights', unit_cost: f, quantity: 2, markup_pct: 9 }];
  await quote(agent, 'Anniversary in Antalya', noor, [{ name: 'Comfort', items: items(900, 480) }, { name: 'Luxury', items: items(1500, 480) }]);
  const sent = await quote(agent, 'Hunza school trip', bright, [{ name: 'Standard', items: [{ product_type: 'package', description: 'Excursion package, 40 students', quantity: 40, unit_cost: 190 }] }]); await agent.post(`/quotes/${sent}/send`, {});
  const accepted = await quote(admin, 'Executive retreat — Salzburg', orion, [{ name: 'Retreat', items: [{ product_type: 'tour', description: 'Programme, 10 guests', quantity: 10, unit_cost: 900 }] }]); await admin.post(`/quotes/${accepted}/send`, {}); await admin.post(`/quotes/${accepted}/accept`, { name: 'Orion Textiles Ltd' });
  const changes = await quote(agent, 'Summit club — Northern lights', summit, [{ name: 'Group', items: [{ product_type: 'tour', description: 'Group tour, 8 guests', quantity: 8, unit_cost: 1400 }] }]); await agent.post(`/quotes/${changes}/send`, {});

  // Invoices: paid, part-paid, overdue, sent, draft
  const cash = ((await admin.get('/accounting/lookup?types=110')) as any[])[0].id as number;
  const invoice = async (client_id: number, booking_id: number | null, description: string, cost: number, markup: number, issue: number, status: 'draft' | 'sent') => {
    const r = await admin.post('/invoices', { client_id, booking_id, currency: 'USD', issue_date: day(issue), due_date: day(issue + 14), lines: [{ product_type: 'package', description, quantity: 1, unit_cost: cost, markup_pct: markup, tax_rate: 0 }] });
    const id = r.inv.id as number; if (status === 'sent') { await admin.post(`/invoices/${id}/status`, { status: 'reviewed' }); await admin.post(`/invoices/${id}/issue`, {}); } return id;
  };
  const pay = async (client_id: number, invoice_id: number, amount: number, daysAgo: number) => admin.post('/finance/receipts', { client_id, cash_account_id: cash, amount, method: 'bank_transfer', receipt_date: day(-daysAgo), allocations: [{ invoice_id, amount }] });
  const getTotal = async (id: number) => (await admin.get(`/invoices/${id}`)).inv.total as number;
  const i1 = await invoice(ahmed, dubai, 'Dubai city break — hotel and flights', 1210, 11, -38, 'sent'); await pay(ahmed, i1, await getTotal(i1), 30);
  const i2 = await invoice(noor, maldivesTrip, 'Maldives honeymoon — deposit invoice', 2800, 14, -20, 'sent'); await pay(noor, i2, Math.round((await getTotal(i2)) / 2), 12);
  await invoice(orion, swiss, 'Swiss executive retreat — programme fee', 10080, 14, -45, 'sent');          // overdue
  await invoice(bright, null, 'Hunza school trip — registration deposit', 3000, 12, -35, 'sent');          // overdue
  const i5 = await invoice(khan, istanbul, 'Istanbul family holiday — full package', 2900, 12, -3, 'sent'); await pay(khan, i5, 1000, 2);
  await invoice(summit, null, 'Northern lights tour — deposit', 4000, 12, 0, 'draft');

  // Airline tickets (feeds the airline remittance report and BSP reconciliation)
  const ticket = async (airline_id: number, ticket_no: string, passenger: string, fare: number, daysAgo: number) => {
    const clients = (await admin.get('/clients')) as any[]; const acc = clients.find((c) => c.name === 'Khan Family')!.account_id as number;
    const inv = await admin.post('/tickets/invoices', { client_account_id: acc, invoice_date: day(-daysAgo), lines: [{ airline_id, passenger_name: passenger, ticket_no, fare, fare_inc: fare, taxes_inc: Math.round(fare * 0.12), yq: Math.round(fare * 0.08), sp_yi: Math.round(fare * 0.04), com_rec_pct: airline_id === turkish ? 7 : 6, sector: 'KHI-IST', route: 'KHI-IST-KHI', pnr: ticket_no.slice(-6) }] });
    await admin.post(`/tickets/invoices/${inv.id}/supervise`);
  };
  await ticket(turkish, '2352148801234', 'KHAN/TARIQ MR', 520, 6); await ticket(turkish, '2352148801235', 'KHAN/SAIRA MRS', 520, 6); await ticket(emirates, '1762290045671', 'AHMED/IMRAN DR', 430, 40); await ticket(emirates, '1762290045672', 'FATIMA/NOOR MS', 610, 4);

  // Visas
  const visa = async (api: Api, client_id: number, applicant_name: string, country: string, visa_type: string, status: string, extra: Record<string, unknown> = {}) => {
    const id = (await api.post('/visas', { client_id, applicant_name, country, visa_type, currency: 'USD', cost: 60, price: 140, ...extra })).id as number;
    for (const s of ['docs_received', 'submitted', 'in_process', 'approved']) { const order = ['docs_pending', 'docs_received', 'submitted', 'in_process', 'approved']; if (order.indexOf(s) <= order.indexOf(status)) await api.put(`/visas/${id}`, { status: s, ...(s === 'submitted' ? { expected_on: day(status === 'in_process' ? -3 : 6) } : {}), ...(s === 'approved' ? { visa_number: 'TR-2026-88412', valid_from: day(10), valid_until: day(100) } : {}) }); }
    return id;
  };
  await visa(agent, khan, 'Tariq Khan', 'Türkiye', 'tourist', 'approved'); await visa(agent, khan, 'Saira Khan', 'Türkiye', 'tourist', 'in_process'); await visa(admin, orion, 'Bilal Sheikh', 'Switzerland', 'business', 'submitted'); await visa(admin, bright, 'Mr. Adeel (chaperone)', 'China', 'business', 'docs_pending');

  // Umrah group
  const g = (await admin.post('/umrah/groups', { name: 'Ramadan Umrah — Group A', departure_date: day(75), return_date: day(89), nights_makkah: 8, nights_madinah: 6, hotel_makkah: 'Pearl Continental Makkah', hotel_madinah: 'Madinah Oasis Hotel', airline: 'Saudi Arabian Airlines', flight_info: 'SV 705 KHI–JED 03:10', capacity: 12, currency: 'USD', cost_per_pax: 1650, price_per_pax: 1950 })).id as number;
  await admin.post(`/umrah/groups/${g}/pilgrims`, [
    { client_id: khan, name: 'Tariq Khan', passport_no: 'AB1234567', passport_expiry: day(1500), gender: 'male', room_type: 'double' }, { client_id: khan, name: 'Saira Khan', passport_no: 'AB1234568', passport_expiry: day(1400), gender: 'female', room_type: 'double' },
    { client_id: ahmed, name: 'Imran Ahmed', passport_no: 'AB7654321', passport_expiry: day(100), gender: 'male', room_type: 'single' }, { client_id: noor, name: 'Fatima Raza', gender: 'female', room_type: 'quad' }]);
  await admin.post(`/umrah/groups/${g}/visas`);

  // Leads and expenses so the funnel and charts have something to show
  for (const [name, stage, dest] of [['Hira Baig', 'new', 'Maldives'], ['Kamran Elahi', 'contacted', 'Dubai'], ['Zoya Karim', 'negotiating', 'Bali']] as const)
    await agent.post('/leads', { name, stage, destination: dest, email: `${name.split(' ')[0].toLowerCase()}@example.com`, party_size: 2, source: 'website' });
  for (const [cat, amt, ago] of [['Rent', 2400, 25], ['Payroll', 7800, 24], ['Software', 480, 18], ['Marketing', 1200, 12], ['Utilities', 320, 9], ['Rent', 2400, 55], ['Payroll', 7800, 54], ['Marketing', 900, 40]] as const)
    await pool.query('INSERT INTO expenses (agency_id, category, amount, currency, fx_rate, incurred_on) VALUES (?,?,?,?,1,?)', [admin.agencyId, cat, amt, 'USD', day(-ago)]).catch(() => {});

  console.log(`\nDemo agency ready — ${AGENCY}\n  admin    ${ADMIN}\n  finance  finance@sunrise-travel.test\n  agent    agent@sunrise-travel.test\n  password ${PASSWORD}\n`);
}

main().catch((e) => { console.error(`\nSeeding stopped: ${e.message}\n`); process.exitCode = 1; }).finally(() => pool.end());
