// Demo data: `npm run seed`  -> login demo@agency.test / DemoPass#2026
import bcrypt from 'bcryptjs';
import { pool, Tenant } from './db.js';
import { encrypt } from './crypto.js';
import { priceLines, addDays, today } from './services/money.js';
import { syncInvoicePaid } from './services/invoicing.js';
import { recalcBooking } from './routes/commissions.js';
import { createAccount, seedChart } from './services/accounting.js';

const [a]: any = await pool.query('INSERT INTO agencies (name, base_currency, tax_label, address) VALUES (?,?,?,?)', ['Horizon Travel Co.', 'USD', 'GST', '12 Harbour St\nSydney NSW']);
const agencyId = a.insertId;
const [u]: any = await pool.query('INSERT INTO users (email, name, password_hash) VALUES (?,?,?)', ['demo@agency.test', 'Demo Admin', await bcrypt.hash('DemoPass#2026', 12)]);
await pool.query('INSERT INTO memberships (agency_id, user_id, role, default_commission_pct) VALUES (?,?,?,?)', [agencyId, u.insertId, 'admin', 40]);
const t = new Tenant(agencyId, { userId: u.insertId, ip: 'seed' });

const clients = [] as number[];
for (const [n, e] of [['Acme Corp', 'ap@acme.test'], ['Nguyen Family', 'nguyen@mail.test'], ['Blue Sky Events', 'fin@bluesky.test']])
  clients.push(await t.insert('clients', { name: n, email: e, currency: 'USD', payment_terms_days: 14 }));
const sup: Record<string, number> = {};
for (const [n, ty, ovr] of [['SkyHigh Airlines', 'airline', 25], ['Coral Resorts', 'hotel', null], ['Oceanic Cruises', 'cruise', 30]] as const)
  sup[n] = await t.insert('suppliers', { name: n, supplier_type: ty, commission_override_pct: ovr, bank_details_enc: encrypt(JSON.stringify({ account_name: n, bsb: '062-000', account_number: '12345678', routing: '021000021' })) });

const dests = ['Bali', 'Paris', 'Tokyo', 'Maui'];
const types = ['flight', 'hotel', 'package', 'cruise', 'transfer'] as const;
for (let i = 0; i < 18; i++) {
  const issue = addDays(today(), -i * 12);
  const b = await t.insert('bookings', { client_id: clients[i % 3], agent_id: u.insertId, reference: `BK-${1000 + i}`, destination: dests[i % 4], overhead: 20 });
  const p = priceLines([
    { product_type: types[i % 5], supplier_id: Object.values(sup)[i % 3], description: `Booking ${1000 + i} main`, quantity: 1 + (i % 3), unit_cost: 800 + i * 40, markup_pct: 12, tax_rate: 10 },
    { product_type: 'transfer', supplier_id: null, description: 'Airport transfers', quantity: 2, unit_cost: 45, markup_pct: 20, tax_rate: 10 },
  ]);
  const status = i < 3 ? 'sent' : i % 4 === 0 ? 'paid' : i % 4 === 1 ? 'partially_paid' : 'sent';
  const id = await t.insert('invoices', {
    number: await t.takeInvoiceNumber(), booking_id: b, client_id: clients[i % 3], created_by: u.insertId, status: 'sent', currency: 'USD', fx_rate: 1,
    issue_date: issue, due_date: addDays(issue, 14), subtotal: p.subtotal, tax_total: p.tax_total, total: p.total,
  });
  for (const l of p.lines) await t.insert('invoice_lines', { invoice_id: id, ...l });
  if (status === 'paid' || status === 'partially_paid') {
    await t.insert('payments', { direction: 'inbound', method: 'bank_transfer', invoice_id: id, client_id: clients[i % 3], amount: status === 'paid' ? p.total : Math.round(p.total / 2), currency: 'USD', paid_at: addDays(issue, 5) });
  }
  await syncInvoicePaid(t, id);
  await recalcBooking(t, b);
}
for (const [c, amt] of [['Rent', 3200], ['Software', 640], ['Marketing', 1500], ['Payroll', 9000], ['Utilities', 380]] as const)
  await t.insert('expenses', { category: c, amount: amt, currency: 'USD', incurred_on: addDays(today(), -10) });

await seedChart(t);
const AIRLINES: [string, string, string][] = [['001','AMERICAN AIRLINES','AA'],['055','CONTINENTAL AIRLINES','CO'],['065','SAUDI ARABIAN AIRLINES','SV'],['066','DELTA AIRLINES','DL'],['105','FINNAIR','AY'],
  ['106','CARIBBEAN AIRLINES','BW'],['108','ICELANDAIR','FI'],['111','BAHAMASAIR','UP'],['114','EL AL ISRAEL AIRLINES','LY'],['115','JAT AIRWAYS','JU'],['117','SCANDINAVIAN AIRLINES','SK'],
  ['118','TAAG ANGOLA AIRLINES','DT'],['124','AIR ALGERIE','AH'],['125','BRITISH AIRWAYS','BA'],['126','GARUDA','GA'],['128','HONG KONG EXPRESS','UO'],['131',"JAPAN AIRLINES INT'L CO., LTD.",'JL'],
  ['132','MEXICANA','MX'],['134','AVIANCA COLOMBIAN A/LS','AV'],['135','AIR TAHITI','VT'],['136','CUBANA AIRLINES','CU'],['139','AEROMEXICO','AM'],['140','AIR CANADA','AC'],
  ['147','ROYAL AIR MAROC','AT'],['148','LIBYAN ARAB AIRLINES','LN'],['149','LUXAIR','LG'],['152','AEROPOSTAL DE VENEZUELA','VH'],['157','QATAR','QR'],['160','CATHAY PACIFIC','CX'],
  ['162','UNITED AIRLINES','UA'],['165','ADRIA AIRWAYS','JP'],['167','AIR MALAWI','QM'],['176','EMIRATES','EK'],['214','PAKISTAN INTERNATIONAL AIRLINES','PK'],['235','TURKISH AIRLINES','TK']];
for (const [code, name, iata] of AIRLINES) {
  const account_id = await createAccount(t, { type_code: 211, name });
  await t.insert('airlines', { code, name, iata_code: iata, commission_pct: 0, show_flag: 1, account_id });
}
for (const n of ['Acme Corp', 'Nguyen Family', 'Blue Sky Events']) await createAccount(t, { type_code: 120, name: n });
await createAccount(t, { type_code: 211 + 0, name: 'Walk-in Agent Payable' });
await createAccount(t, { type_code: 124, name: 'Agent Commission Payable' });
await createAccount(t, { type_code: 230, name: 'Owner Capital', opening_cr: 50000 });
await t.query("UPDATE accounts SET opening_dr = 50000 WHERE agency_id = ? AND sys_key = 'bank'", [agencyId]);
console.log('Seeded. Login: demo@agency.test / DemoPass#2026  agency id', agencyId);
await pool.end();
