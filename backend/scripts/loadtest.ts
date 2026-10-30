/**
 * Seeds a scratch agency with realistic volume and times the heaviest read endpoints.
 *   npx tsx scripts/loadtest.ts [invoices=20000]
 * Uses the dev database (DATABASE_URL) and a NEW agency, so existing data is untouched.
 */
import 'dotenv/config';
import { pool } from '../src/db.js';
import { app } from '../src/app.js';
import { AddressInfo } from 'node:net';

const N = Number(process.argv[2] ?? 20000), pw = 'LoadTest#2026x';
const server = app.listen(0); const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
const post = async (p: string, b: unknown, h: Record<string, string> = {}) => (await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify(b) })).json() as any;
const reg = await post('/auth/register', { agencyName: `LoadTest ${Date.now()}`, name: 'Load', email: `load-${Date.now()}@test.dev`, password: pw });
const aid = reg.agencies[0].id as number, H = { authorization: `Bearer ${reg.accessToken}`, 'x-agency-id': String(aid) };
console.log(`agency ${aid}: seeding ${N} invoices…`);
const [[u]]: any = await pool.query('SELECT id FROM users WHERE email = ?', [reg.user.email]);
const clients = 500; const cv: any[] = [];
for (let i = 0; i < clients; i++) cv.push([aid, `Client ${i}`, `c${i}@lt.test`, 'USD']);
await pool.query('INSERT INTO clients (agency_id, name, email, currency) VALUES ?', [cv]);
const [cl]: any = await pool.query('SELECT id FROM clients WHERE agency_id = ?', [aid]);
for (let off = 0; off < N; off += 2000) {
  const rows: any[] = [];
  for (let i = off; i < Math.min(N, off + 2000); i++) {
    const total = 500 + (i % 90) * 25, paid = i % 3 === 0 ? total : i % 3 === 1 ? total / 2 : 0, st = paid >= total ? 'paid' : paid > 0 ? 'partially_paid' : 'sent', day = 1 + (i % 28), mon = 1 + (i % 12);
    rows.push([aid, `LT-${i}`, cl[i % clients].id, u.id, st, 'USD', `2026-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}`, `2026-${String(mon).padStart(2, '0')}-${String(Math.min(28, day + 14)).padStart(2, '0')}`, total / 1.1, total - total / 1.1, total, paid]);
  }
  await pool.query('INSERT INTO invoices (agency_id, number, client_id, created_by, status, currency, issue_date, due_date, subtotal, tax_total, total, amount_paid) VALUES ?', [rows]);
}
const [inv]: any = await pool.query('SELECT id FROM invoices WHERE agency_id = ? LIMIT 3000', [aid]);
const pay: any[] = inv.map((r: any, i: number) => [aid, r.id, 'inbound', 'bank_transfer', 'USD', 1, 100 + (i % 50), `2026-0${1 + (i % 9)}-10`]);
await pool.query('INSERT INTO payments (agency_id, invoice_id, direction, method, currency, fx_rate, amount, paid_at) VALUES ?', [pay]);

const targets = ['/invoices', '/dashboard', '/clients', '/payments?direction=inbound', '/reports/ar-aging-summary', '/reports/invoice-register?from=2026-01-01&to=2026-12-31', '/reports/pnl?from=2026-01-01&to=2026-12-31', '/accounting/trial-balance', '/finance/summary', '/automation/exceptions/scan', '/search?q=Client%201'];
console.log('\nendpoint'.padEnd(62), 'ms'.padStart(7), 'KB'.padStart(8));
let slow = 0;
for (const p of targets) {
  const t0 = performance.now(); const r = await fetch(base + p, { method: p.includes('scan') ? 'POST' : 'GET', headers: { ...H, 'content-type': 'application/json' }, body: p.includes('scan') ? '{}' : undefined }); const body = await r.text(); const ms = performance.now() - t0;
  if (ms > 800) slow++;
  console.log(p.padEnd(60), r.status, Math.round(ms).toString().padStart(7), (body.length / 1024).toFixed(0).padStart(8), ms > 800 ? '  ← SLOW' : '');
}
console.log(slow ? `\n${slow} slow endpoint(s)` : '\nall under 800 ms');
server.close(); await pool.end();
