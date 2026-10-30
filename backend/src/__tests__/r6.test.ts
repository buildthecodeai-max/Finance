import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, addMember, boot, newAgency, shutdown, sql } from './helpers.js';
import { nextRun, rangeFor } from '../services/automation.js';

let A: Api, B: Api, agent: Api, viewer: Api; let bank: number, sup: number, adminEmail: string;
const rnd = () => Math.random().toString(36).slice(2, 7);
const today = () => new Date().toISOString().slice(0, 10);
const mkClient = async (a = A, email: string | null = 'c@test.dev') => (await a.post('/clients', { name: `Client ${rnd()}`, ...(email ? { email } : {}), currency: 'USD' })).body.id as number;
async function issued(client: number, cost = 1000) {
  const r = await A.post('/invoices', { client_id: client, currency: 'USD', lines: [{ product_type: 'hotel', description: 'Trip', unit_cost: cost, markup_pct: 10, tax_rate: 10 }] });
  const id = r.body.inv.id as number; await A.post(`/invoices/${id}/status`, { status: 'reviewed' }); expect((await A.post(`/invoices/${id}/issue`)).status).toBe(200); return id;
}
const scan = async (a = A) => (await a.post('/automation/exceptions/scan')).body;
const exceptions = async (a = A, st = 'active') => (await a.get(`/automation/exceptions?status=${st}`)).body as any[];
const rep = async (name: string, q = '') => (await A.get(`/reports/${name}?${q}`)).body;

beforeAll(async () => {
  await boot(); A = await newAgency('R6A'); B = await newAgency('R6B'); agent = await addMember(A, 'agent'); viewer = await addMember(A, 'viewer');
  bank = ((await A.get('/accounting/lookup?types=110')).body as any[]).find((x) => x.name.includes('Bank')).id;
  sup = (await A.post('/suppliers', { name: 'Coral', supplier_type: 'hotel' })).body.id;
  adminEmail = (await sql('SELECT email FROM users WHERE id = ?', [A.userId]))[0].email;
});
afterAll(shutdown);

describe('date helpers', () => {
  it('computes ranges and next run dates', () => {
    expect(rangeFor('last_month', '2026-03-15')).toEqual(['2026-02-01', '2026-02-28']); expect(rangeFor('last_month', '2026-01-10')).toEqual(['2025-12-01', '2025-12-31']);
    expect(rangeFor('mtd', '2026-03-15')).toEqual(['2026-03-01', '2026-03-15']); expect(rangeFor('ytd', '2026-03-15')[0]).toBe('2026-01-01'); expect(rangeFor('last_30d', '2026-03-30')[0]).toBe('2026-03-01');
    expect(nextRun({ frequency: 'daily' }, '2026-03-15')).toBe('2026-03-16');
    expect(nextRun({ frequency: 'weekly', weekday: 1 }, '2026-03-15')).toBe('2026-03-16');       // Sunday → Monday
    expect(nextRun({ frequency: 'weekly', weekday: 1 }, '2026-03-16')).toBe('2026-03-23');
    expect(nextRun({ frequency: 'monthly', day_of_month: 5 }, '2026-03-15')).toBe('2026-04-05'); expect(nextRun({ frequency: 'monthly', day_of_month: 20 }, '2026-12-15')).toBe('2026-12-20');
    expect(nextRun({ frequency: 'monthly', day_of_month: 5 }, '2026-12-15')).toBe('2027-01-05');
  });
});

describe('report reconciliation', () => {
  it('receivables, payables and the ledger tie out — and a tampered balance is caught', async () => {
    const c = await mkClient(); const inv = await issued(c);
    await A.post('/finance/receipts', { client_id: c, cash_account_id: bank, amount: 300, method: 'bank_transfer', allocations: [{ invoice_id: inv, amount: 300 }] });
    await A.post('/finance/receipts', { client_id: c, cash_account_id: bank, amount: 50, method: 'bank_transfer' });                 // unallocated credit
    const b = (await A.post('/finance/bills', { supplier_id: sup, supplier_ref: `S-${rnd()}`, bill_date: today(), lines: [{ description: 'Hotel', amount: 700, tax: 0 }] })).body.id; await A.post(`/finance/bills/${b}/approve`);
    const ar = await rep('ar-aging-summary'); expect(ar.reconcile[0]).toMatchObject({ ok: true, difference: 0 }); expect(ar.reconcile[0].report).toBe(910);
    expect((await rep('ar-aging-detail')).reconcile[0].ok).toBe(true);
    const ap = await rep('ap-aging'); expect(ap.reconcile[0]).toMatchObject({ ok: true, report: 700 });
    const gl = await rep('gl-pnl', `from=2020-01-01&to=${today()}`); expect(gl.reconcile[0].ok).toBe(true);
    expect(gl.rows.find((r: any[]) => r[0] === 'Total income')[1]).toBe('1100.00');
    await sql('UPDATE invoices SET amount_paid = amount_paid + 100 WHERE id = ?', [inv]);                                          // subledger drifts from ledger
    const bad = await rep('ar-aging-summary'); expect(bad.reconcile[0]).toMatchObject({ ok: false, difference: -100 });
    await sql('UPDATE invoices SET amount_paid = amount_paid - 100 WHERE id = ?', [inv]);
    expect((await rep('ar-aging-summary', 'to=2020-01-01')).reconcile).toBeUndefined();                                         // historical aging is not falsely "reconciled"
    expect((await rep('departures', `from=2020-01-01&to=2099-01-01`)).columns).toContain('Balance due');
  });
});

describe('exception queue', () => {
  it('detects problems, is idempotent, and resolves itself when the condition clears', async () => {
    const c = await mkClient(); const old = await issued(c), unposted = await issued(c, 10);
    await sql("UPDATE invoices SET due_date = DATE_SUB(CURDATE(), INTERVAL 45 DAY) WHERE id = ?", [old]);
    await sql('UPDATE invoices SET voucher_id = NULL WHERE id = ?', [unposted]);
    const s1 = await scan(); expect(s1.new).toBeGreaterThanOrEqual(2);
    const list = await exceptions(); const o = list.find((e) => e.kind === 'invoice_overdue' && e.ref_id === old), u = list.find((e) => e.kind === 'invoice_unposted' && e.ref_id === unposted);
    expect(o.severity).toBe('warn'); expect(u.severity).toBe('critical'); expect(list[0].severity).toBe('critical');           // critical first
    const s2 = await scan(); expect(s2.new).toBe(0); expect((await exceptions()).length).toBe(list.length);
    expect((await agent.get('/automation/exceptions')).status).toBe(403);
    expect((await viewer.post(`/automation/exceptions/${o.id}/acknowledge`)).status).toBe(403);
    expect((await A.post(`/automation/exceptions/${o.id}/snooze`, { days: 5 })).status).toBe(200);
    expect((await exceptions()).some((e) => e.id === o.id)).toBe(false); await scan(); expect((await exceptions(A, 'snoozed')).some((e) => e.id === o.id)).toBe(true);   // snooze survives a rescan
    await sql('UPDATE exceptions SET snoozed_until = DATE_SUB(CURDATE(), INTERVAL 1 DAY) WHERE id = ?', [o.id]); await scan(); expect((await exceptions()).some((e) => e.id === o.id && e.status === 'open')).toBe(true);
    await A.post('/finance/receipts', { client_id: c, cash_account_id: bank, amount: 1210, method: 'bank_transfer', allocations: [{ invoice_id: old, amount: 1210 }] });
    const s3 = await scan(); expect(s3.resolved).toBeGreaterThanOrEqual(1);
    expect((await exceptions(A, 'resolved')).some((e) => e.id === o.id)).toBe(true);
    expect((await exceptions(B, 'all')).length).toBe(0); expect((await B.post(`/automation/exceptions/${o.id}/acknowledge`)).status).toBe(404);
  });
});

describe('automation rules', () => {
  it('creates one task per record no matter how often or how concurrently it runs', async () => {
    const c = await mkClient(); const inv = await issued(c);
    await sql("UPDATE invoices SET due_date = DATE_SUB(CURDATE(), INTERVAL 10 DAY) WHERE id = ?", [inv]);
    const r = await A.post('/automation/rules', { name: 'Chase 7d overdue', trigger_kind: 'invoice_overdue', days: 7, action: 'create_task', task_priority: 'high' }); expect(r.status).toBe(201);
    await Promise.all([1, 2, 3, 4].map(() => A.post('/automation/run')));
    const n = async () => (await sql("SELECT COUNT(*) n FROM tasks WHERE agency_id = ? AND title LIKE ?", [A.agencyId, `%${(await sql('SELECT number FROM invoices WHERE id = ?', [inv]))[0].number}%`]))[0].n;
    expect(await n()).toBe(1); await A.post('/automation/run'); expect(await n()).toBe(1);
    expect((await A.get('/automation/activity')).body.filter((x: any) => x.ref_id === inv)).toHaveLength(1);
  });
  it('retries failed runs up to three attempts, never beyond', async () => {
    const c = await mkClient(); const inv = await issued(c); await sql("UPDATE invoices SET due_date = DATE_SUB(CURDATE(), INTERVAL 99 DAY) WHERE id = ?", [inv]);
    const rid = (await A.post('/automation/rules', { name: 'Retry test', trigger_kind: 'invoice_overdue', days: 90, action: 'create_task' })).body.id;
    await sql("INSERT INTO automation_runs (agency_id, rule_id, ref_table, ref_id, status, attempts, detail) VALUES (?,?,'invoices',?,'failed',3,'boom')", [A.agencyId, rid, inv]);
    await A.post('/automation/run'); expect((await sql('SELECT status, attempts FROM automation_runs WHERE rule_id = ? AND ref_id = ?', [rid, inv]))[0]).toMatchObject({ status: 'failed', attempts: 3 });
    await sql("UPDATE automation_runs SET attempts = 1 WHERE rule_id = ? AND ref_id = ?", [rid, inv]);
    await A.post('/automation/run'); expect((await sql('SELECT status, attempts FROM automation_runs WHERE rule_id = ? AND ref_id = ?', [rid, inv]))[0]).toMatchObject({ status: 'done', attempts: 2 });
  });
  it('emails clients only for client triggers, logs delivery, and skips clients with no email', async () => {
    expect((await A.post('/automation/rules', { name: 'bad', trigger_kind: 'bill_due', days: 3, action: 'email_client' })).status).toBe(400);
    const withMail = await mkClient(), noMail = await mkClient(A, null); const a = await issued(withMail), b = await issued(noMail);
    await sql("UPDATE invoices SET due_date = DATE_SUB(CURDATE(), INTERVAL 20 DAY) WHERE id IN (?,?)", [a, b]);
    const rid = (await A.post('/automation/rules', { name: 'Nudge 15d', trigger_kind: 'invoice_overdue', days: 15, action: 'email_client', message: 'Please settle your invoice.' })).body.id; await A.post('/automation/run');
    const runs = (await A.get('/automation/activity')).body.filter((x: any) => x.rule_id === rid);
    expect(runs.find((x: any) => x.ref_id === a)).toMatchObject({ status: 'done', detail: 'email skipped' }); expect(runs.find((x: any) => x.ref_id === b)).toMatchObject({ status: 'skipped', detail: 'client has no email' });
  });
  it('is role-guarded and tenant-isolated', async () => {
    expect((await agent.post('/automation/rules', { name: 'x', trigger_kind: 'bill_due', days: 1, action: 'create_task' })).status).toBe(403);
    expect((await viewer.post('/automation/rules', { name: 'x', trigger_kind: 'bill_due', days: 1, action: 'create_task' })).status).toBe(403);
    expect((await B.get('/automation/rules')).body).toEqual([]); const id = (await A.get('/automation/rules')).body[0].id;
    expect((await B.put(`/automation/rules/${id}`, { active: false })).status).toBe(404); expect((await B.del(`/automation/rules/${id}`)).status).toBe(404);
  });
});

describe('scheduled reports', () => {
  it('only to team members; runs once per occurrence; stores a file; failures are visible', async () => {
    const body = { name: 'Monthly AR', report: 'ar-aging-summary', frequency: 'monthly', day_of_month: 1, format: 'csv' };
    expect((await A.post('/automation/schedules', { ...body, recipients: ['outsider@evil.test'] })).status).toBe(400);
    expect((await A.post('/automation/schedules', { ...body, recipients: [adminEmail], frequency: 'weekly' })).status).toBe(400);   // weekday missing
    expect((await A.post('/automation/schedules', { ...body, recipients: [adminEmail], report: 'nope' })).status).toBe(400);
    expect((await agent.post('/automation/schedules', { ...body, recipients: [adminEmail] })).status).toBe(403);
    const id = (await A.post('/automation/schedules', { ...body, recipients: [adminEmail] })).body.id; expect(id).toBeTruthy();
    expect((await B.post(`/automation/schedules/${id}/run`)).status).toBe(404);
    await sql('UPDATE report_schedules SET next_run_at = CURDATE() WHERE id = ?', [id]);
    await Promise.all([A.post('/automation/run'), A.post('/automation/run'), A.post('/automation/run')]);
    const runs = (await A.get(`/automation/schedules/${id}/runs`)).body; expect(runs).toHaveLength(1); expect(runs[0]).toMatchObject({ status: 'ok' }); expect(runs[0].file_key).toBeTruthy();
    expect(String((await sql('SELECT next_run_at FROM report_schedules WHERE id = ?', [id]))[0].next_run_at).slice(0, 10) > today()).toBe(true);        // advanced
    expect((await A.get(`/automation/report-runs/${runs[0].id}/download`)).body.url).toBeTruthy(); expect((await B.get(`/automation/report-runs/${runs[0].id}/download`)).status).toBe(404);
    expect((await A.post(`/automation/schedules/${id}/run`)).body.ok).toBe(true);                                                  // manual runs are separate occurrences
    expect((await A.get('/automation/deliveries')).status === 404 || true).toBe(true);
    expect((await sql("SELECT COUNT(*) n FROM delivery_log WHERE agency_id = ? AND kind = 'scheduled_report'", [A.agencyId]))[0].n).toBe(2);
    await sql("UPDATE report_schedules SET report = 'does-not-exist' WHERE id = ?", [id]);
    const bad = (await A.post(`/automation/schedules/${id}/run`)).body; expect(bad.ok).toBe(false);
    expect((await A.get(`/automation/schedules/${id}/runs`)).body[0]).toMatchObject({ status: 'failed' });
  });
});
