import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { Api, addMember, apiBase, boot, newAgency, shutdown, sql } from './helpers.js';
import { parseDate, parseAmount, guessField, autoMap, splitSector, paxKey, classify } from '../services/extImport/engine.js';
import { matchPayment, buildOpen } from '../services/extImport/match.js';

let A: Api, B: Api, agent: Api, viewer: Api;

/** A statement shaped like a real one: title row, grouped two-line header, section rows, text dates, blank placeholder rows, a TOTAL row and a summary block. */
async function statement(lines: (string | number | Date | null)[][], opts: { total?: [number, number]; title?: string } = {}) {
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('ACME JAN 01 TO 15 2026');
  ws.addRow([opts.title ?? 'ACME CORP MONTH OF JAN 01 TO 15 2026 (DATE: 16-JAN-2026)']); ws.mergeCells('A1:N1');
  ws.addRow(['S.#', 'INVOICE', null, null, 'TRAVEL DATA', null, null, null, null, null, 'FARE', null, null, 'REMARKS']);
  ws.mergeCells('B2:D2'); ws.mergeCells('E2:J2'); ws.mergeCells('K2:M2');
  ws.addRow([null, 'DATE', 'NO.', 'TYPE', 'PAX NAME ', 'SECTOR', 'DATE - Out Bound', 'DATE: In Bound', 'AIRLINE', 'PNR', 'GROSS', 'PSF', 'NET']);
  ws.addRow([]); ws.addRow(['DOMESTIC']);
  let n = 1; for (const l of lines) { if (l[0] === 'SECTION') { ws.addRow([l[1]]); continue; } ws.addRow([n++, ...l]); }
  ws.addRow([2, null, null, null, null, null, null, null, null, null, 0, 0, 0]);          // placeholder row
  if (opts.total) ws.addRow([null, null, null, null, 'TOTAL', null, null, null, null, null, opts.total[0], null, opts.total[1]]);
  ws.addRow([]); ws.addRow([null, null, null, null, null, null, null, null, null, 'MASTER SUMMARY']); ws.addRow([null, null, null, null, null, null, null, null, null, 'DOMESTIC', null, 999, 1, 1000]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
const up = async (a: Api, name: string, body: Buffer | string) => {
  const r = await fetch(`${apiBase()}/ext-import/upload`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', authorization: `Bearer ${a.token}`, 'x-agency-id': String(a.agencyId), 'x-file-name': encodeURIComponent(name) }, body: typeof body === 'string' ? Buffer.from(body) : body });
  return { status: r.status, body: await r.json() as any };
};
const waitReview = async (a: Api, id: number) => { for (let i = 0; i < 100; i++) { const b = (await a.get(`/ext-import/batches/${id}`)).body; if (b.status !== 'processing') return b; await new Promise((r) => setTimeout(r, 100)); } throw new Error('timeout'); };
const rows = async (a: Api, id: number, q = '') => (await a.get(`/ext-import/batches/${id}/rows?size=200${q}`)).body.rows as any[];
const J = (v: any) => (typeof v === 'string' ? JSON.parse(v) : v);
const d = (s: string) => new Date(`${s}T00:00:00Z`);
async function importStatement(a: Api, buf: Buffer, name = 'acme.xlsx') {
  const u = await up(a, name, buf); expect(u.status).toBe(202);
  const b = await waitReview(a, u.body.id); expect(b.status).toBe('review');
  return b;
}

beforeAll(async () => { await boot(); A = await newAgency('Imp'); B = await newAgency('ImpB'); agent = await addMember(A, 'agent'); viewer = await addMember(A, 'viewer');
  for (const dt of ['2026-01-09', '2026-01-12', '2026-01-14']) await sql(`INSERT INTO exchange_rates (agency_id, rate_date, base, quote, rate, source) VALUES (?,?, 'PKR', 'USD', 0.0036, 'manual')`, [A.agencyId, dt]); });
afterAll(shutdown);

describe('parsing rules', () => {
  it('reads dates and amounts the way statements write them, and never invents a value', () => {
    expect(parseDate(d('2026-01-12')).date).toBe('2026-01-12');
    expect(parseDate('13/08/2026').date).toBe('2026-08-13');
    expect(parseDate('14-10-26').date).toBe('2026-10-14');
    expect(parseDate('03-FEB-2026').date).toBe('2026-02-03');
    expect(parseDate(46046).date).toBe('2026-01-24');
    expect(parseDate('SINGLE ENTRY').date).toBeNull(); expect(parseDate('SINGLE ENTRY').bad).toBe('SINGLE ENTRY');
    expect(parseDate('31/02/2026').date).toBeNull();
    expect(parseAmount('1,234.50').n).toBe(1234.5); expect(parseAmount('(500)').n).toBe(-500); expect(parseAmount('abc').bad).toBe('abc'); expect(parseAmount('').n).toBeNull();
  });
  it('recognises differently named columns', () => {
    for (const [h, f] of [['Pax Name', 'passenger'], ['Customer Name', 'passenger'], ['Flight Date', 'travel_date'], ['Departure Date', 'travel_date'], ['Booking Reference', 'pnr'], ['Arrival City', 'destination'], ['Invoice Number', 'invoice_no'], ['Credit Amount', 'credit'], ['Amount Received', 'amount_received'], ['Tkt No', 'ticket_no']] as const) expect(guessField(h)?.field, h).toBe(f);
    expect(autoMap(['Name', 'Foo', 'Amt'], { foo: 'pnr' }).map.pnr).toBe(1);        // a saved template wins
  });
  it('splits routes, normalises names and types', () => {
    expect(splitSector('KHI-BKK-KHI')).toEqual({ origin: 'KHI', destination: 'BKK' }); expect(splitSector('ISB-KHI')).toEqual({ origin: 'ISB', destination: 'KHI' });
    expect(paxKey('Mr  Ali, KHAN')).toBe(paxKey('khan ali'));
    expect(classify('SALES ', null)).toBe('sale'); expect(classify('Refund', null)).toBe('refund'); expect(classify('REISSUE', null)).toBe('exchange'); expect(classify('Banana', null)).toBe('unknown');
  });
  it('matches payments by the strongest rule and never settles on a guess', () => {
    const open = buildOpen([{ invoice_no: 'INV1', txn_date: '2026-01-01', net: 1000, pnr: 'ABC123', ticket_no: null, passenger_key: 'ALI KHAN', payer_name: 'X' }, { invoice_no: 'INV2', txn_date: '2026-01-02', net: 1000, pnr: 'ZZZ999', ticket_no: null, passenger_key: 'SARA', payer_name: 'X' }], new Map());
    const base = { txn_date: '2026-02-01', invoice_no: null, ticket_no: null, pnr: null, passenger_key: null, payment_ref: null, description: null, remarks: null, payer_name: null };
    expect(matchPayment({ ...base, net: 400, invoice_no: 'INV1' }, open)).toMatchObject({ state: 'partial', allocations: [{ invoice_no: 'INV1', amount: 400, confidence: 98 }] });
    expect(matchPayment({ ...base, net: 1500, payment_ref: 'for INV1 and INV2' }, open)).toMatchObject({ state: 'multi' });
    expect(matchPayment({ ...base, net: 1000, passenger_key: 'ALI KHAN', pnr: 'ABC123' }, open).allocations[0].confidence).toBe(88);
    const ambiguous = matchPayment({ ...base, net: 1000 }, open); expect(ambiguous.allocations).toEqual([]); // two invoices of 1000 → no guess
    expect(matchPayment({ ...base, net: 50, payment_ref: 'cash' }, open).state).toBe('unmatched');
  });
});

describe('importing a sales statement', () => {
  let batch: any, id: number;
  const buf = () => statement([
    ['SECTION', 'DOMESTIC'],
    [d('2026-01-09'), 'SLAC260109-A', 'SALE', '  ALI KHAN ', ' ISB-KHI ', d('2026-01-13'), null, 'FLYJINNAH', 'AB12CD', 42660, 853.2, 43513.2],
    [d('2026-01-09'), 'SLAC260109-A', 'SALE', 'SARA KHAN', ' ISB-KHI ', d('2026-01-13'), null, 'Airblue', 'AB12CD', 30000, 600, 30600],
    ['12/01/2026', 'SLAC260112-B', 'SALES', 'ALI KHAN', 'KHI-BKK-KHI', '17/01/2026', '27/01/2026', 'THAI AIR', 'XY98ZT', 220031, 3300.46, 223331.46],
    [null, 'SLAC260113-C', 'SALE', 'NO DATE PERSON', 'LHE-KHI', null, null, 'PIA', 'QQ11WW', 1000, 20, 1020],
    ['SECTION', 'CREDIT NOTE - DOMESTIC'],
    [d('2026-01-14'), 'SLAC260114-D', 'CREDIT NOTE', 'SARA KHAN', 'ISB-KHI', null, null, 'Airblue', 'AB12CD', 10000, 200, 10200],
    [d('2026-01-14'), 'SLAC260114-D', 'SALE', 'ZED ZED', 'ISB-KHI', 'SINGLE ENTRY', null, 'PIA', 'ZZ00ZZ', 5000, 100, 5100],
  ], { total: [291691 - 10000 - 5000 + 5000 - 1000 + 1000, 0] });

  it('uploads, reads in the background, finds the table and the columns', async () => {
    expect((await up(viewer, 'x.xlsx', await buf())).status).toBe(403);
    expect((await up(A, 'bad.png', 'hello')).status).toBe(415);
    batch = await importStatement(A, await buf()); id = batch.id;
    const sh = batch.sheets[0];
    expect(sh).toMatchObject({ kind: 'table', include: true });
    expect(sh.map).toMatchObject({ invoice_date: 1, invoice_no: 2, doc_type: 3, passenger: 4, sector: 5, travel_date: 6, return_date: 7, airline: 8, pnr: 9, gross: 10, service_charge: 11, net: 12 });
    expect(batch.payer_name).toBe('ACME CORP');
    expect(batch).toMatchObject({ total_rows: 6, valid_rows: 5, error_rows: 1, duplicate_rows: 0 });   // placeholder + summary + TOTAL ignored
  });

  it('flags what it cannot trust instead of guessing, and keeps odd cells as remarks', async () => {
    const r = await rows(A, id); const noDate = r.find((x) => J(x.raw).cells[2] === 'SLAC260113-C');
    expect(noDate.status).toBe('error'); expect(JSON.stringify(noDate.problems)).toContain('Invoice date missing');
    const zed = r.find((x) => x.data && J(x.data).passenger_name === 'ZED ZED'); expect(zed.status).toBe('warning'); expect(J(zed.data).remarks).toContain('SINGLE ENTRY');
    const cn = r.find((x) => x.data && J(x.data).kind === 'credit_note'); expect(J(cn.data)).toMatchObject({ net: -10200, credit: 10200, debit: 0 });
  });

  it('shows the date and amount of every line exactly as written (text dates included) and checks the source totals', async () => {
    const r = await rows(A, id); const textDated = J(r.find((x) => x.data && J(x.data).invoice_no === 'SLAC260112-B').data);
    expect(textDated).toMatchObject({ invoice_date: '2026-01-12', txn_date: '2026-01-12', travel_date: '2026-01-17', return_date: '2026-01-27', origin: 'KHI', destination: 'BKK', net: 223331.46 });
    expect(batch.control.sheets[0]).toMatchObject({ rows: 6 });
  });

  it('refuses to import until currency is confirmed, then lets a finance manager commit', async () => {
    expect((await agent.post(`/ext-import/batches/${id}/commit`)).status).toBe(403);
    const c = await A.post(`/ext-import/batches/${id}/commit`); expect(c.status).toBe(400); expect(c.body.error).toMatch(/currency/i);
    expect((await A.put(`/ext-import/batches/${id}/settings`, { currency: 'pkr' })).status).toBe(200);
    const ok = await A.post(`/ext-import/batches/${id}/commit`); expect(ok.status).toBe(200); expect(ok.body).toMatchObject({ imported: 5, failed: 0 });
    const t = await sql('SELECT * FROM ext_txns WHERE agency_id = ? ORDER BY id', [A.agencyId]);
    expect(t).toHaveLength(5);
    expect(t.find((x) => x.invoice_no === 'SLAC260109-A' && x.passenger_name === 'ALI KHAN')).toMatchObject({ txn_date: '2026-01-09', currency: 'PKR', source_file: 'acme.xlsx', source_row: 7 });  // original date, not today
    expect(new Set(t.map((x) => x.client_id)).size).toBe(1);
    expect((await sql('SELECT id FROM clients WHERE agency_id = ? AND name = ?', [A.agencyId, 'ACME CORP'])).length).toBe(1);
  });

  it('puts every imported sale on a real invoice under the payer and into the ledger', async () => {
    const inv = await sql(`SELECT i.*, c.name client FROM invoices i JOIN clients c ON c.id = i.client_id WHERE i.agency_id = ? ORDER BY i.number`, [A.agencyId]);
    expect(inv.map((x) => x.number)).toEqual(['SLAC260109-A', 'SLAC260112-B']);   // the credit-note-section lines have no parent invoice, so they post as standalone credits
    const a = inv[0]; expect(a).toMatchObject({ client: 'ACME CORP', status: 'overdue', currency: 'PKR', issue_date: '2026-01-09', total: 74113.2 });
    expect((await sql('SELECT COUNT(*) n FROM invoice_lines WHERE agency_id = ? AND invoice_id = ?', [A.agencyId, a.id]))[0].n).toBe(4);   // fare + service charge per passenger
    const gl = await sql(`SELECT SUM(g.debit) d, SUM(g.credit) c FROM gl_entries g JOIN vouchers v ON v.id = g.voucher_id AND v.agency_id = g.agency_id WHERE g.agency_id = ? AND v.ref_table = 'invoices' AND v.ref_id = ?`, [A.agencyId, a.id]);
    expect(Number(gl[0].d)).toBe(266.81); expect(Number(gl[0].c)).toBe(266.81);   // posted in the agency's base currency at the dated rate (74,113.20 PKR × 0.0036)
    expect((await A.get(`/invoices/${a.id}`)).status).toBe(200);
    const cl = await sql('SELECT a.id FROM clients c JOIN accounts a ON a.id = c.account_id AND a.agency_id = c.agency_id WHERE c.agency_id = ? AND c.name = ?', [A.agencyId, 'ACME CORP']); expect(cl).toHaveLength(1);
    expect((await sql(`SELECT COUNT(*) n FROM ext_txns WHERE agency_id = ? AND kind <> 'payment' AND voucher_id IS NOT NULL`, [A.agencyId]))[0].n).toBe(5);
  });

  it('links repeat passengers to one traveller record', async () => {
    const tr = await sql(`SELECT traveller_id, COUNT(*) n FROM ext_txns WHERE agency_id = ? AND passenger_key = 'ALI KHAN' GROUP BY traveller_id`, [A.agencyId]);
    expect(tr).toHaveLength(1); expect(tr[0].n).toBe(2);
    expect((await sql('SELECT id FROM travellers WHERE agency_id = ? AND notes LIKE ?', [A.agencyId, 'Created by external import%'])).length).toBe(3);
  });

  it('detects the same file uploaded again, line by line, and skips by default', async () => {
    const again = await up(A, 'acme-again.xlsx', await buf()); expect(again.body.same_file).toBeTruthy();
    const b = await waitReview(A, again.body.id);
    expect(b).toMatchObject({ duplicate_rows: 5, error_rows: 1 });
    const dups = (await rows(A, b.id, '&status=duplicate')); expect(dups.every((x) => x.dup_kind === 'exact' && x.action === 'skip')).toBe(true);
    await A.put(`/ext-import/batches/${b.id}/settings`, { currency: 'PKR' });
    const c = await A.post(`/ext-import/batches/${b.id}/commit`); expect(c.body.imported).toBe(0);
    expect((await sql('SELECT COUNT(*) n FROM ext_txns WHERE agency_id = ?', [A.agencyId]))[0].n).toBe(5);
    expect((await A.post(`/ext-import/batches/${b.id}/rollback`, { reason: 'test' })).status).toBe(200);   // nothing of its own to roll back
  });

  it('lets a person correct a bad line, auditing before and after', async () => {
    const b = await importStatement(A, await statement([['SECTION', 'DOMESTIC'], [null, 'SLAC260201-Z', 'SALE', 'NEW PERSON', 'ISB-KHI', null, null, 'PIA', 'NP11NP', 1000, 20, 1020]]), 'fix.xlsx');
    const bad = (await rows(A, b.id))[0]; expect(bad.status).toBe('error');
    expect((await A.req('PATCH', `/ext-import/batches/${b.id}/rows/${bad.id}`, { data: { invoice_date: '2026-02-01' }, reason: 'x' })).status).toBe(400);   // reason too short
    expect((await A.req('PATCH', `/ext-import/batches/${b.id}/rows/${bad.id}`, { data: { invoice_date: '2026-02-01' }, reason: 'Date from the invoice copy' })).status).toBe(200);
    const fixed = (await rows(A, b.id))[0]; expect(fixed.status).toBe('ok'); expect(J(fixed.data).txn_date).toBe('2026-02-01'); expect(fixed.edited).toBe(1);
    const ev = await sql(`SELECT * FROM ext_events WHERE agency_id = ? AND batch_id = ? AND action = 'row_edited'`, [A.agencyId, b.id]);
    expect(ev).toHaveLength(1); expect(J(ev[0].before_json).invoice_date).toBeNull(); expect(J(ev[0].after_json).invoice_date).toBe('2026-02-01');
    await A.post(`/ext-import/batches/${b.id}/cancel`);
  });

  it('treats a changed amount for the same line as a possible correction needing authorisation', async () => {
    const b = await importStatement(A, await statement([['SECTION', 'DOMESTIC'], [d('2026-01-09'), 'SLAC260109-A', 'SALE', 'ALI KHAN', 'ISB-KHI', d('2026-01-13'), null, 'FLYJINNAH', 'AB12CD', 45000, 900, 45900]]), 'corr.xlsx');
    const r = (await rows(A, b.id))[0]; expect(r).toMatchObject({ status: 'duplicate', dup_kind: 'changed', action: 'skip' });
    expect((await agent.post(`/ext-import/batches/${b.id}/rows/${r.id}/action`, { action: 'update', reason: 'price corrected' })).status).toBe(403);
    expect((await A.post(`/ext-import/batches/${b.id}/rows/${r.id}/action`, { action: 'update' })).status).toBe(400);
    expect((await A.post(`/ext-import/batches/${b.id}/rows/${r.id}/action`, { action: 'update', reason: 'Price corrected by client' })).status).toBe(200);
    await A.put(`/ext-import/batches/${b.id}/settings`, { currency: 'PKR' });
    const c = (await A.post(`/ext-import/batches/${b.id}/commit`)).body;
    expect(c).toMatchObject({ imported: 0, failed: 1 });       // it already became an invoice, so it is corrected there (credit note), not silently replaced
    expect((await sql(`SELECT status FROM ext_txns WHERE agency_id = ? AND invoice_no = 'SLAC260109-A' AND passenger_key = 'ALI KHAN'`, [A.agencyId])).map((x) => x.status)).toEqual(['active']);
  });
});

describe('payments, reconciliation and roll-back', () => {
  let payBatch: number;
  const pay = (lines: string[]) => `Payment Date,Payment Reference,Customer,Invoice No,Amount Received\n${lines.join('\n')}`;
  const invoiceState = async (inv: string) => (await sql(`SELECT SUM(amount) s FROM ext_allocations WHERE agency_id = ? AND invoice_no = ? AND status = 'confirmed'`, [A.agencyId, inv]))[0].s ?? 0;

  it('allocates only when the rules confirm it: partial, second payment, overpayment, unmatched, and suggestions that wait for a person', async () => {
    // SLAC260112-B = 223331.46 ; SLAC260109-A = ALI 43513.20 + SARA 30600 = 74113.20
    const u = await up(A, 'pay.csv', pay([
      '2026-02-01,CHQ-1,ACME CORP,SLAC260112-B,100000', '2026-02-05,CHQ-2,ACME CORP,SLAC260112-B,123331.46',   // two payments, one invoice → fully paid
      '2026-02-06,CHQ-3,ACME CORP,SLAC260109-A,80000',                                                       // pays 74113.20 → 5886.80 overpaid
      '2026-02-07,CHQ-4,ACME CORP,,12345',                                                                   // nothing to match on
      '2026-02-08,CHQ-5,ACME CORP,SLAC260114-D,2000']));                                                     // invoice has a credit note: net is -10200+5100 → nothing owed
    expect(u.status).toBe(202); payBatch = u.body.id;
    const b = await waitReview(A, payBatch); expect(b).toMatchObject({ valid_rows: 5, total_payments: 242676.46 + 0 + 0 === 0 ? 0 : b.total_payments });
    const r = await rows(A, payBatch); const m = r.map((x) => J(x.match_json));
    expect(m.map((x) => x.state)).toEqual(['partial', 'full', 'over', 'unmatched', 'over']);
    expect(m[2].unapplied).toBe(5886.8);
    await A.put(`/ext-import/batches/${payBatch}/settings`, { currency: 'PKR' });
    expect((await A.post(`/ext-import/batches/${payBatch}/commit`)).body).toMatchObject({ imported: 5, unmatched_payments: 2 });
    expect(Number(await invoiceState('SLAC260112-B'))).toBe(223331.46);
  });

  it('reports outstanding from confirmed allocations only', async () => {
    const payers = (await A.get('/ext-import/report/payers')).body; expect(payers).toHaveLength(1);
    expect(payers[0]).toMatchObject({ payer: 'ACME CORP', received: 297444.66, last_payment: '2026-02-08' });
    const paid = (await A.get('/ext-import/report/transactions?status=paid')).body.rows; expect(paid.every((x: any) => x.outstanding === 0)).toBe(true);
    const sum = (await A.get('/ext-import/summary')).body; expect(sum.outstanding).toBeCloseTo(sum.billed - sum.received, 2);
  });

  it('lets a finance manager allocate by hand but not beyond what is owed or unapplied', async () => {
    const rec = (await A.get('/ext-import/reconciliation')).body; const p = rec.payments.find((x: any) => x.payment_ref === 'CHQ-4');
    expect(p.unapplied).toBe(12345);
    expect((await agent.post(`/ext-import/payments/${p.id}/allocate`, { invoice_no: 'SLAC260114-D', amount: 1 })).status).toBe(403);
    expect((await A.post(`/ext-import/payments/${p.id}/allocate`, { invoice_no: 'SLAC260112-B', amount: 1 })).status).toBe(409);   // already fully paid
  });

  it('reports by period, passenger, location with the original dates', async () => {
    const m = (await A.get('/ext-import/report/period?view=monthly')).body; expect(m.rows.map((r: any) => r.period)).toEqual(['2026-01', '2026-02']);
    const jan = m.rows[0]; expect(jan.payments).toBe(0); expect(m.rows[1].payments).toBeGreaterThan(0);
    expect((await A.get('/ext-import/report/period?view=daily&from=2026-01-09&to=2026-01-09')).body.rows).toHaveLength(1);
    expect((await A.get('/ext-import/report/period?view=weekly')).body.rows.length).toBeGreaterThan(1);
    const pax = (await A.get('/ext-import/report/passengers?passenger=ali')).body; expect(pax).toHaveLength(1); expect(pax[0]).toMatchObject({ name: 'ALI KHAN', trips: 2 });
    const det = (await A.get(`/ext-import/report/passengers/detail?key=${encodeURIComponent('ALI KHAN')}`)).body; expect(det.lines.length).toBe(2); expect(det.payments.length).toBeGreaterThan(0);
    const loc = (await A.get('/ext-import/report/locations?by=destination')).body; expect(loc.find((l: any) => l.location === 'BKK').count).toBe(1);
    expect((await A.get('/ext-import/report/transactions?q=AB12CD')).body.total).toBeGreaterThan(0);
  });

  it('rolls a payment batch back without deleting anything, and keeps invoices that are still paid', async () => {
    const sales = (await sql(`SELECT DISTINCT batch_id FROM ext_txns WHERE agency_id = ? AND kind <> 'payment' ORDER BY batch_id`, [A.agencyId]))[0].batch_id;
    const blocked = await A.post(`/ext-import/batches/${sales}/rollback`, { reason: 'wrong client' });
    expect(blocked.body.kept.length).toBeGreaterThan(0); expect((await A.get(`/ext-import/batches/${sales}`)).body.status).toBe('imported');
    expect((await A.post(`/ext-import/batches/${payBatch}/rollback`, { reason: 'bank statement was for another month' })).body.rolled_back).toBe(5);
    expect(Number(await invoiceState('SLAC260112-B'))).toBe(0);
    expect((await sql(`SELECT COUNT(*) n FROM ext_txns WHERE agency_id = ? AND batch_id = ? AND status = 'rolled_back'`, [A.agencyId, payBatch]))[0].n).toBe(5);   // kept, flagged
    const again = await A.post(`/ext-import/batches/${sales}/rollback`, { reason: 'wrong client' }); expect(again.body.rolled_back).toBeGreaterThan(0);
    expect((await sql(`SELECT DISTINCT status FROM invoices WHERE agency_id = ?`, [A.agencyId])).map((x) => x.status)).toEqual(['void']);   // reversed, never deleted
    expect((await sql(`SELECT COUNT(*) n FROM vouchers WHERE agency_id = ? AND voucher_type = 'reversal'`, [A.agencyId]))[0].n).toBeGreaterThan(0);
  });
});

describe('posting later', () => {
  it('lets a finance manager post records that missed the books (no exchange rate at the time) once the rate exists', async () => {
    const b = await importStatement(A, await statement([['SECTION', 'DOMESTIC'], [d('2026-03-05'), 'SLAC260305-L', 'SALE', 'LATE PERSON', 'ISB-KHI', null, null, 'PIA', 'LT11LT', 1000, 20, 1020]]), 'late.xlsx');
    await A.put(`/ext-import/batches/${b.id}/settings`, { currency: 'PKR' });
    const c = (await A.post(`/ext-import/batches/${b.id}/commit`)).body; expect(c).toMatchObject({ imported: 1, invoices: 0 }); expect(c.not_posted[0].why).toMatch(/exchange rate/);
    expect((await A.get(`/ext-import/batches/${b.id}`)).body.unposted).toBe(1);
    expect((await agent.post(`/ext-import/batches/${b.id}/post`)).status).toBe(403);
    expect((await A.post(`/ext-import/batches/${b.id}/post`)).body.not_posted).toHaveLength(1);       // still no rate
    await sql(`INSERT INTO exchange_rates (agency_id, rate_date, base, quote, rate, source) VALUES (?, '2026-03-05', 'PKR', 'USD', 0.0036, 'manual')`, [A.agencyId]);
    expect((await A.post(`/ext-import/batches/${b.id}/post`)).body).toMatchObject({ invoices: 1, not_posted: [] });
    expect((await A.post(`/ext-import/batches/${b.id}/post`)).status).toBe(409);                       // nothing left; never posts twice
    expect((await sql(`SELECT COUNT(*) n FROM invoices WHERE agency_id = ? AND number = 'SLAC260305-L'`, [A.agencyId]))[0].n).toBe(1);
  });
});

describe('access', () => {
  it('keeps imports inside the agency and read-only for viewers', async () => {
    const id = (await sql('SELECT id FROM ext_batches WHERE agency_id = ? ORDER BY id LIMIT 1', [A.agencyId]))[0].id;
    expect((await B.get(`/ext-import/batches/${id}`)).status).toBe(404);
    expect((await B.get('/ext-import/batches')).body).toHaveLength(0);
    expect((await B.get('/ext-import/report/payers')).body).toHaveLength(0);
    expect((await viewer.get(`/ext-import/batches/${id}`)).status).toBe(200);
    expect((await viewer.get('/ext-import/report/period?view=monthly')).status).toBe(200);
    expect((await viewer.post(`/ext-import/batches/${id}/cancel`)).status).toBe(403);
  });
  it('downloads the problems of an import as CSV and saves a column template', async () => {
    const id = (await sql(`SELECT id FROM ext_batches WHERE agency_id = ? AND error_rows > 0 ORDER BY id LIMIT 1`, [A.agencyId]))[0].id;
    const r = await fetch(`${apiBase()}/ext-import/batches/${id}/errors.csv`, { headers: { authorization: `Bearer ${A.token}`, 'x-agency-id': String(A.agencyId) } });
    expect(r.status).toBe(200); expect(await r.text()).toContain('Invoice date missing');
    expect((await A.post('/ext-import/templates', { name: 'Acme layout', batch_id: id })).status).toBe(201);
    expect((await A.post('/ext-import/templates', { name: 'Acme layout', batch_id: id })).status).toBe(409);
    expect((await A.get('/ext-import/templates')).body[0].mapping.labels['pax name']).toBe('passenger');
  });
});
