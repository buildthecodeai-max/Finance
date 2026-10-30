import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, addMember, boot, newAgency, shutdown, sql } from './helpers.js';

let A: Api, B: Api, fin2: Api, ag1: Api, ag2: Api, viewer: Api, bank: number;
const PERIOD = new Date().toISOString().slice(0, 7);
const tb = async (a = A) => (await a.get('/accounting/trial-balance')).body as { debit: number; credit: number };
const glBal = async (key: string) => (await sql(`SELECT COALESCE(SUM(g.debit - g.credit),0) v FROM gl_entries g JOIN accounts x ON x.id = g.account_id WHERE g.agency_id = ? AND x.sys_key = ?`, [A.agencyId, key]))[0].v as number;
const client = async (a = A) => (await a.post('/clients', { name: `C${Math.random().toString(36).slice(2, 6)}`, currency: 'USD' })).body.id as number;

/** Booking with a hotel (net 1100, margin 100) and a flight (net 600, margin 100). */
async function mkBooking(o: { agent?: number; destination?: string; status?: string; overhead?: number; supplier?: number; a?: Api; comps?: any[] } = {}) {
  const a = o.a ?? A, c = await client(a);
  const b = (await a.post('/bookings', { client_id: c, destination: o.destination ?? 'Bali', status: o.status ?? 'confirmed', agent_id: o.agent ?? ag1.userId, overhead: o.overhead ?? 0 })).body.id as number;
  for (const comp of o.comps ?? [{ product_type: 'hotel', description: 'Resort', unit_cost: 1000, markup_pct: 10, supplier_id: o.supplier }, { product_type: 'flight', description: 'Flights', unit_cost: 500, markup_pct: 20 }])
    expect((await a.post(`/bookings/${b}/components`, comp)).status).toBe(201);
  return { id: b, client: c };
}
const rule = (o: Record<string, unknown>) => A.post('/commissions/rules', { name: 'Rule', kind: 'agent', basis: 'pct_margin', rate: 10, ...o });
const entries = async (booking: number) => ((await A.get(`/commissions/bookings/${booking}`)).body.entries as any[]);
const recalc = (b: number) => A.post(`/commissions/recalculate/${b}`);
const clearRules = async () => { await sql('UPDATE commission_rules SET active = 0 WHERE agency_id = ?', [A.agencyId]); };

beforeAll(async () => {
  await boot(); A = await newAgency('R4C'); B = await newAgency('R4CB');
  fin2 = await addMember(A, 'finance_manager'); ag1 = await addMember(A, 'agent'); ag2 = await addMember(A, 'agent'); viewer = await addMember(A, 'viewer');
  bank = ((await A.get('/accounting/lookup?types=110')).body as any[]).find((x) => x.name.includes('Bank')).id;
});
afterAll(shutdown);

describe('rule selection & calculation', () => {
  it('the most specific rule wins per component, and the result explains itself', async () => {
    await clearRules();
    await rule({ name: 'General 10%', rate: 10 }); await rule({ name: 'Bali hotels 30%', rate: 30, product_type: 'hotel', destination: 'Bali' });
    const b = await mkBooking(); const [e] = await entries(b.id);
    expect(e.gross_amount).toBe(40); expect(e.amount).toBe(40);                      // 100×30% + 100×10%
    const hotel = e.calc_json.components.find((c: any) => c.type === 'hotel'), flight = e.calc_json.components.find((c: any) => c.type === 'flight');
    expect(hotel).toMatchObject({ rule_name: 'Bali hotels 30%', rate: 30, amount: 30, net: 1100, cost: 1000, margin: 100 }); expect(flight).toMatchObject({ rule_name: 'General 10%', amount: 10 });
    expect(e.rule_summary).toMatch(/Bali hotels 30% v1/);
    const other = await mkBooking({ destination: 'Rome' }); expect((await entries(other.id))[0].amount).toBe(20); // no Bali rule → general on both lines
  });
  it('honours effective dates and the fixed / %-of-selling bases', async () => {
    await clearRules();
    await rule({ name: 'Expired', rate: 90, effective_to: '2020-01-01' }); await rule({ name: 'Per ticket', basis: 'fixed', fixed_amount: 15, product_type: 'flight' }); await rule({ name: 'Hotel 2% of sales', basis: 'pct_selling', rate: 2, product_type: 'hotel' });
    const b = await mkBooking(); const [e] = await entries(b.id); expect(e.amount).toBe(37);   // 15 + 1100×2% = 22
    expect(e.calc_json.components.map((c: any) => c.rule_name)).not.toContain('Expired');
    expect(e.amount).toBe(37);
  });
  it('overhead is allocated by margin and deducted only by rules that say so', async () => {
    await clearRules(); await rule({ name: 'After overhead', rate: 50, deduct_overhead: true });
    const b = await mkBooking({ overhead: 40 }); const [e] = await entries(b.id);
    expect(e.overhead_alloc).toBe(40); expect(e.amount).toBe(80); // each line: (100 margin − 20 overhead) × 50% = 40
  });
  it('falls back to supplier override, then agent default %, and flags a booking with no rule at all', async () => {
    await clearRules();
    const sup = (await A.post('/suppliers', { name: 'Override Resorts', commission_override_pct: 50 })).body.id;
    let [e] = await entries((await mkBooking({ supplier: sup })).id); expect(e.calc_json.components.find((c: any) => c.type === 'hotel')).toMatchObject({ source: 'supplier_override', amount: 50 });
    const dflt = await addMember(A, 'agent', { default_commission_pct: 20 });
    [e] = await entries((await mkBooking({ agent: dflt.userId })).id); expect(e.amount).toBe(40); expect(e.calc_json.components[0].source).toBe('agent_default');
    [e] = await entries((await mkBooking()).id); expect(e.amount).toBe(0); expect(e.flags).toContain('no_rule');
  });
  it('rules are validated and tenant-scoped; agents cannot read them', async () => {
    expect((await rule({ basis: 'fixed' })).status).toBe(400); expect((await rule({ rate: undefined })).status).toBe(400); expect((await rule({ rate: 150 })).status).toBe(400);
    expect((await rule({ effective_from: '2026-02-01', effective_to: '2026-01-01' })).status).toBe(400);
    expect((await rule({ kind: 'supplier', agent_id: ag1.userId })).status).toBe(400);
    const bSup = (await B.post('/suppliers', { name: 'BSup' })).body.id;
    expect((await rule({ supplier_id: bSup })).status).toBe(400); expect((await B.post('/commissions/rules', { name: 'x', basis: 'pct_margin', rate: 5, agent_id: ag1.userId })).status).toBe(400);
    expect((await ag1.get('/commissions/rules')).status).toBe(403); expect((await ag1.post('/commissions/rules', { name: 'x', basis: 'pct_margin', rate: 5 })).status).toBe(403);
    expect(((await B.get('/commissions/rules')).body as any[]).length).toBe(0);
  });
  it('tiers: crossing a cumulative-margin threshold in the month raises the rate for later bookings', async () => {
    await clearRules(); const tagent = await addMember(A, 'agent');
    await rule({ name: 'Tiered', rate: 10, tiers: [{ from: 0, rate: 10 }, { from: 250, rate: 40 }] });
    const b1 = await mkBooking({ agent: tagent.userId }); expect((await entries(b1.id))[0].amount).toBe(20);   // cumulative margin 200 < 250 → 10%
    const b2 = await mkBooking({ agent: tagent.userId }); const e2 = (await entries(b2.id))[0];
    expect(e2.amount).toBe(80); expect(e2.calc_json.tier_cumulative_margin).toBe(400);                         // 200 earlier + 200 now ≥ 250 → 40%
  });
});

describe('versioning keeps history explainable', () => {
  it('editing a rule creates version N+1; approved results are never rewritten, they get an adjustment', async () => {
    await clearRules(); await sql('DELETE FROM commission_entries WHERE agency_id = ?', [A.agencyId]); await sql('DELETE FROM commission_periods WHERE agency_id = ?', [A.agencyId]);
    const r = await rule({ name: 'Std 10%', rate: 10 }); const rid = r.body.id as number;
    const b = await mkBooking(); let [e] = await entries(b.id); expect(e.amount).toBe(20);
    expect((await A.post(`/commissions/periods/${PERIOD}/submit`)).status).toBe(200);
    expect((await A.post(`/commissions/periods/${PERIOD}/approve`)).status).toBe(200);
    const v2 = await A.put(`/commissions/rules/${rid}`, { name: 'Std 15%', kind: 'agent', basis: 'pct_margin', rate: 15 }); expect(v2.body.version).toBe(2);
    expect((await A.put(`/commissions/rules/${rid}`, { name: 'again', kind: 'agent', basis: 'pct_margin', rate: 20 })).status).toBe(409); // v1 is no longer current
    const key = ((await A.get('/commissions/rules?all=1')).body as any[]).find((x) => x.id === rid).rule_key;
    const hist = (await A.get(`/commissions/rules/${key}/history`)).body as any[]; expect(hist.map((h) => h.version)).toEqual([2, 1]); expect(hist[1].active).toBe(0);
    await recalc(b.id);
    [e] = await entries(b.id);
    expect(e.status).toBe('approved'); expect(e.amount).toBe(20); expect(JSON.stringify(e.calc_json)).toContain('Std 10%'); // untouched: still explains v1
    const adj = (await A.get(`/commissions/entries/${e.id}`)).body.adjustments as any[];
    expect(adj).toHaveLength(1); expect(adj[0]).toMatchObject({ kind: 'recalc', amount: 10, status: 'open' });
    await recalc(b.id); await recalc(b.id);                                                                                     // idempotent
    expect(((await A.get(`/commissions/entries/${e.id}`)).body.adjustments as any[]).length).toBe(1);
  });
});

describe('lifecycle & eligibility triggers', () => {
  beforeAll(async () => { await clearRules(); await rule({ name: 'Std', rate: 10 }); });
  it('enquiry → estimated, confirmed → eligible (default trigger), cancelled → reversed', async () => {
    const b = await mkBooking({ status: 'enquiry' }); expect((await entries(b.id))[0]).toMatchObject({ status: 'estimated', period: null });
    expect((await A.put(`/bookings/${b.id}`, { status: 'confirmed' })).status).toBe(200);             // booking edit triggers a recalc
    const e = (await entries(b.id))[0]; expect(e.status).toBe('eligible'); expect(e.period).toBe(PERIOD); expect(e.eligible_at).toBeTruthy();
    expect((await A.put(`/bookings/${b.id}`, { status: 'cancelled', reason: 'Client changed plans' })).status).toBe(200);
    expect((await entries(b.id))[0]).toMatchObject({ status: 'reversed', period: null });
  });
  it('client_paid trigger: accrued until the booking invoices are fully settled', async () => {
    expect((await A.put('/admin/settings', { commission_trigger: 'client_paid', reason: 'pay on collection' })).status).toBe(200);
    const b = await mkBooking(); expect((await entries(b.id))[0].status).toBe('accrued');
    const inv = (await A.post('/invoices', { client_id: b.client, booking_id: b.id, currency: 'USD', lines: [{ product_type: 'hotel', description: 'x', unit_cost: 1000, markup_pct: 0, tax_rate: 0 }] })).body.inv.id;
    await A.post(`/invoices/${inv}/status`, { status: 'reviewed' }); await A.post(`/invoices/${inv}/issue`);
    await recalc(b.id); expect((await entries(b.id))[0].status).toBe('accrued');                       // invoiced, not paid
    await A.post('/finance/receipts', { client_id: b.client, cash_account_id: bank, amount: 400, method: 'cash', allocations: [{ invoice_id: inv, amount: 400 }] });
    await recalc(b.id); expect((await entries(b.id))[0].status).toBe('accrued');                       // part-paid
    await A.post('/finance/receipts', { client_id: b.client, cash_account_id: bank, amount: 600, method: 'cash', allocations: [{ invoice_id: inv, amount: 600 }] });
    await recalc(b.id); expect((await entries(b.id))[0].status).toBe('eligible');
    expect((await A.put('/admin/settings', { commission_trigger: 'travel_completed', reason: 'after travel' })).status).toBe(200);
    await recalc(b.id); expect((await entries(b.id))[0].status).toBe('accrued');                       // regresses (not approved yet)
    expect((await A.put(`/bookings/${b.id}`, { status: 'travel_completed' })).status).toBe(200); expect((await entries(b.id))[0].status).toBe('eligible');
    expect((await A.put('/admin/settings', { commission_trigger: 'booking_confirmed', reason: 'reset' })).status).toBe(200);
  });
});

describe('splits & overrides', () => {
  it('splits sum exactly to the booking commission; invalid and foreign splits are refused', async () => {
    await clearRules(); await rule({ name: 'Std', rate: 33.33 });
    const b = await mkBooking(); const gross = (await entries(b.id))[0].gross_amount;
    expect((await A.put(`/commissions/bookings/${b.id}/splits`, { splits: [{ agent_id: ag1.userId, pct: 60 }, { agent_id: ag2.userId, pct: 30 }] })).status).toBe(400);
    expect((await A.put(`/commissions/bookings/${b.id}/splits`, { splits: [{ agent_id: ag1.userId, pct: 100 }, { agent_id: ag1.userId, pct: 0.01 }] })).status).toBe(400);
    expect((await A.put(`/commissions/bookings/${b.id}/splits`, { splits: [{ agent_id: B.userId, pct: 100 }] })).status).toBe(400);
    expect((await A.put(`/commissions/bookings/${b.id}/splits`, { splits: [{ agent_id: ag1.userId, pct: 60 }, { agent_id: ag2.userId, pct: 40 }] })).status).toBe(200);
    const es = await entries(b.id); expect(es).toHaveLength(2); expect(Math.round(es.reduce((s, e) => s + e.amount, 0) * 100) / 100).toBe(gross);
    expect(es.find((e) => e.agent_id === ag2.userId).split_pct).toBe(40);
    expect(((await ag2.get('/commissions/entries')).body as any[]).every((e) => e.agent_id === ag2.userId)).toBe(true);
    expect((await A.put(`/commissions/bookings/${b.id}/splits`, { splits: [{ agent_id: ag1.userId, pct: 100 }] })).status).toBe(200);     // ag2 removed → reversed
    expect((await entries(b.id)).find((e) => e.agent_id === ag2.userId).status).toBe('reversed');
  });
  it('manual override needs a reason, survives recalculation, and is locked once approved', async () => {
    await clearRules(); await rule({ name: 'Std', rate: 10 });
    const b = await mkBooking(); const e = (await entries(b.id))[0];
    expect((await A.put(`/commissions/entries/${e.id}/override`, { amount: 99 })).status).toBe(400);
    expect((await A.put(`/commissions/entries/${e.id}/override`, { amount: 99, reason: 'Negotiated at signing' })).status).toBe(200);
    await recalc(b.id); const after = (await entries(b.id))[0]; expect(after.amount).toBe(99); expect(after.calc_json.override.reason).toMatch(/Negotiated/); expect(after.flags).toContain('override');
    expect((await ag1.put(`/commissions/entries/${e.id}/override`, { amount: 1000, reason: 'self-serve' })).status).toBe(403);
    expect((await A.put(`/commissions/entries/${e.id}/override`, { amount: null })).status).toBe(200); expect((await entries(b.id))[0].amount).toBe(20);
    await sql(`UPDATE commission_entries SET status = 'approved' WHERE id = ?`, [e.id]);
    expect((await A.put(`/commissions/entries/${e.id}/override`, { amount: 5, reason: 'too late now' })).status).toBe(409);
    await sql(`UPDATE commission_entries SET status = 'eligible' WHERE id = ?`, [e.id]);
  });
});

describe('month-end close', () => {
  // A clean agency: the engine (correctly) regenerates entries for every earlier booking on refresh, so reuse would pollute the totals.
  beforeAll(async () => {
    A = await newAgency('R4M'); fin2 = await addMember(A, 'finance_manager'); ag1 = await addMember(A, 'agent'); ag2 = await addMember(A, 'agent'); viewer = await addMember(A, 'viewer');
    bank = ((await A.get('/accounting/lookup?types=110')).body as any[]).find((x) => x.name.includes('Bank')).id; await rule({ name: 'Std', rate: 10 });
  });
  it('blocking exceptions stop submission; warnings do not', async () => {
    await clearRules(); const nb = await mkBooking();                                                                    // no rules anywhere → no_rule
    const s = await A.post(`/commissions/periods/${PERIOD}/submit`); expect(s.status).toBe(409); expect(s.body.error).toMatch(/no commission rule/);
    expect((await A.put(`/commissions/entries/${(await entries(nb.id))[0].id}/override`, { amount: 25, reason: 'Flat deal' })).status).toBe(200);
    await rule({ name: 'Std', rate: 10 });
  });
  it('submit → approve (a different person above the threshold) posts a balanced accrual; reopen reverses it', async () => {
    expect((await A.put('/admin/settings', { approval_threshold: 10, reason: 'controls' })).status).toBe(200);
    await mkBooking(); await mkBooking({ agent: ag2.userId });
    const v = (await A.get(`/commissions/periods/${PERIOD}`)).body; expect(v.agents.length).toBe(2); expect(v.status).toBe('open');
    expect((await A.post(`/commissions/periods/${PERIOD}/approve`)).status).toBe(409);                                  // must be submitted first
    expect((await A.post(`/commissions/periods/${PERIOD}/submit`)).status).toBe(200);
    expect((await A.post(`/commissions/periods/${PERIOD}/approve`)).body.error).toMatch(/different person/);
    expect((await ag1.post(`/commissions/periods/${PERIOD}/approve`)).status).toBe(403);
    const before = await glBal('commission_payable');
    const ap = await fin2.post(`/commissions/periods/${PERIOD}/approve`); expect(ap.status).toBe(200);
    expect(ap.body.total).toBeGreaterThan(0); expect(await glBal('agent_commission_expense')).toBeGreaterThanOrEqual(ap.body.total); expect(before - (await glBal('commission_payable'))).toBeCloseTo(ap.body.total, 2);
    const t = await tb(); expect(t.debit).toBeCloseTo(t.credit, 2);
    expect((await fin2.post(`/commissions/periods/${PERIOD}/approve`)).status).toBe(409);
    expect(((await A.get(`/commissions/periods/${PERIOD}`)).body.entries as any[]).every((e) => e.status === 'approved')).toBe(true);
    expect((await fin2.post(`/commissions/periods/${PERIOD}/reopen`, { reason: 'Wrong rate used' })).status).toBe(403);   // admin only
    expect((await A.post(`/commissions/periods/${PERIOD}/reopen`, { reason: 'x' })).status).toBe(400);
    expect((await A.post(`/commissions/periods/${PERIOD}/reopen`, { reason: 'Wrong rate used' })).status).toBe(200);
    expect(await glBal('commission_payable')).toBeCloseTo(before, 2);                                                  // accrual fully reversed
    expect(((await A.get(`/commissions/periods/${PERIOD}`)).body.entries as any[]).every((e) => e.status === 'eligible')).toBe(true);
    expect((await sql(`SELECT reason FROM audit_log WHERE agency_id = ? AND entity = 'commission_periods' AND reason IS NOT NULL ORDER BY id DESC LIMIT 1`, [A.agencyId]))[0].reason).toBe('Wrong rate used');
  });
  it('pay posts Dr payable / Cr bank, exports payroll CSV only when approved, and a paid period is final', async () => {
    expect((await A.get(`/commissions/periods/${PERIOD}/payroll.csv`)).status).toBe(409);                                 // reopened → not exportable
    await A.post(`/commissions/periods/${PERIOD}/submit`); const ap = (await fin2.post(`/commissions/periods/${PERIOD}/approve`)).body;
    const csv = await A.get(`/commissions/periods/${PERIOD}/payroll.csv`); expect(csv.status).toBe(200); expect(String(csv.body)).toContain('Net payable'); expect(String(csv.body).split('\n').length).toBeGreaterThan(2);
    const cashBefore = ((await A.get('/accounting/cash-bank')).body as any[]).find((x) => x.id === bank).balance;
    const pay = await A.post(`/commissions/periods/${PERIOD}/pay`, { cash_account_id: bank }); expect(pay.status).toBe(200); expect(pay.body.paid).toBeCloseTo(ap.total, 2);
    expect(cashBefore - ((await A.get('/accounting/cash-bank')).body as any[]).find((x) => x.id === bank).balance).toBeCloseTo(ap.total, 2);
    expect((await glBal('commission_payable'))).toBeCloseTo(0, 2);
    expect((await A.post(`/commissions/periods/${PERIOD}/pay`, { cash_account_id: bank })).status).toBe(409);
    expect((await A.post(`/commissions/periods/${PERIOD}/reopen`, { reason: 'try anyway' })).status).toBe(409);
    expect(((await A.get(`/commissions/periods/${PERIOD}`)).body.entries as any[]).every((e) => e.status === 'paid')).toBe(true);
    const t = await tb(); expect(t.debit).toBeCloseTo(t.credit, 2);
  });
  it('a cancellation after payout claws back in a LATER period, and a negative net is carried forward, not paid', async () => {
    await A.put('/admin/settings', { approval_threshold: 0, reason: 'reset' });
    const e = ((await A.get(`/commissions/entries?period=${PERIOD}&agent_id=${ag1.userId}`)).body as any[])[0];
    const detail = (await A.get(`/commissions/entries/${e.id}`)).body;
    expect((await A.put(`/bookings/${e.booking_id}`, { status: 'cancelled', reason: 'Client cancelled after travel docs' })).status).toBe(200);
    const adj = (await A.get(`/commissions/entries/${e.id}`)).body.adjustments as any[]; expect(adj).toHaveLength(1);
    expect(adj[0]).toMatchObject({ kind: 'clawback', amount: -detail.amount, status: 'open' });
    expect((await entries(e.booking_id)).find((x) => x.id === e.id).status).toBe('paid');                                  // history stays as paid
    const next = new Date(); next.setUTCMonth(next.getUTCMonth() + 1, 1); const NP = next.toISOString().slice(0, 7);
    await sql('UPDATE commission_adjustments SET period = ? WHERE id = ?', [NP, adj[0].id]);                               // happens next month
    const v = (await A.get(`/commissions/periods/${NP}`)).body; expect(v.agents.find((a: any) => a.agent_id === ag1.userId).net).toBe(-detail.amount);
    expect(v.exceptions.some((x: any) => /negative/.test(x.message))).toBe(true);
    expect((await A.post(`/commissions/periods/${NP}/submit`)).status).toBe(200); expect((await A.post(`/commissions/periods/${NP}/approve`)).status).toBe(200);
    const pay = (await A.post(`/commissions/periods/${NP}/pay`, { cash_account_id: bank })).body; expect(pay.paid).toBe(0); expect(pay.carried_forward).toEqual([{ agent_id: ag1.userId, amount: -detail.amount }]);
    const after = new Date(); after.setUTCMonth(after.getUTCMonth() + 2, 1);
    expect(((await sql(`SELECT kind, amount, period FROM commission_adjustments WHERE agency_id = ? AND kind = 'carry_forward'`, [A.agencyId]))[0])).toMatchObject({ kind: 'carry_forward', amount: -detail.amount, period: after.toISOString().slice(0, 7) });
    const t = await tb(); expect(t.debit).toBeCloseTo(t.credit, 2);
  });
  it('agents see only their own statement; viewers can read but not act', async () => {
    const s = await ag2.get(`/commissions/periods/${PERIOD}/statement/${ag2.userId}`); expect(s.status).toBe(200); expect(s.body.entries.length).toBeGreaterThan(0); expect(s.body.entries[0].rule).toMatch(/Std/);
    expect((await ag2.get(`/commissions/periods/${PERIOD}/statement/${ag1.userId}`)).status).toBe(404);
    expect(((await ag2.get(`/commissions/periods/${PERIOD}`)).body.agents as any[]).every((a) => a.agent_id === ag2.userId)).toBe(true);
    expect((await viewer.get(`/commissions/periods/${PERIOD}`)).status).toBe(200); expect((await viewer.post(`/commissions/periods/${PERIOD}/submit`)).status).toBe(403);
    expect((await A.get('/commissions/periods/2026-13')).status).toBe(400);
  });
});

describe('supplier commission (receivable) & isolation', () => {
  it('is tracked separately, received into the ledger once, and voided if the booking is cancelled', async () => {
    const sup = (await A.post('/suppliers', { name: 'Payer Hotels' })).body.id;
    const b = await mkBooking({ supplier: sup, comps: [{ product_type: 'hotel', description: 'Resort', unit_cost: 1000, markup_pct: 10, supplier_id: sup, commission_pct: 10 }] });
    await recalc(b.id); const sc = (await A.get(`/commissions/bookings/${b.id}`)).body.supplier as any[]; expect(sc).toHaveLength(1); expect(sc[0]).toMatchObject({ amount: 110, status: 'expected' });
    const sum = (await A.get(`/commissions/bookings/${b.id}`)).body.summary; expect(sum.supplier_commission).toBe(110); expect(sum.net_agency_margin).toBe(100 + 110 - sum.agent_amount);
    const rcv = await A.post(`/commissions/supplier/${sc[0].id}/receive`, { cash_account_id: bank }); expect(rcv.status).toBe(200); expect(await glBal('commission_income')).toBeLessThanOrEqual(-110);
    expect((await A.post(`/commissions/supplier/${sc[0].id}/receive`, { cash_account_id: bank })).status).toBe(409);
    const b2 = await mkBooking({ supplier: sup, comps: [{ product_type: 'hotel', description: 'Resort', unit_cost: 1000, markup_pct: 10, supplier_id: sup, commission_pct: 10 }] });
    await recalc(b2.id); await A.put(`/bookings/${b2.id}`, { status: 'cancelled', reason: 'Client cancelled' });
    expect(((await A.get(`/commissions/bookings/${b2.id}`)).body.supplier as any[])[0].status).toBe('void');
    const t = await tb(); expect(t.debit).toBeCloseTo(t.credit, 2);
  });
  it("another agency can't see or act on any of it", async () => {
    const e = ((await A.get('/commissions/entries')).body as any[])[0], sc = ((await A.get('/commissions/supplier')).body as any[])[0];
    expect((await B.get(`/commissions/entries/${e.id}`)).status).toBe(404); expect(((await B.get('/commissions/entries')).body as any[]).length).toBe(0);
    expect((await B.get(`/commissions/bookings/${e.booking_id}`)).status).toBe(404); expect((await B.post(`/commissions/recalculate/${e.booking_id}`)).status).toBe(404);
    expect((await B.put(`/commissions/entries/${e.id}/override`, { amount: 1, reason: 'steal' })).status).toBe(404);
    expect((await B.post(`/commissions/supplier/${sc.id}/receive`, { cash_account_id: bank })).status).toBeGreaterThanOrEqual(400);
    expect((await B.put(`/commissions/bookings/${e.booking_id}/splits`, { splits: [] })).status).toBe(404);
    expect((await B.get(`/commissions/periods/${PERIOD}`)).body.entries).toEqual([]);
    expect((await B.post(`/commissions/periods/${PERIOD}/pay`, { cash_account_id: bank })).status).toBeGreaterThanOrEqual(400);
  });
});
