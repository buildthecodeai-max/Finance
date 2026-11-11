import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import { authenticator } from 'otplib';
import { PASSWORD, apiBase, boot, newAgency, addMember, shutdown, sql, type Api } from './helpers.js';
import { OperatorRole, setPlatformAdmin } from '../services/platform.js';
import * as LP from '../services/localPay.js';

let base: string; const rnd = () => Math.random().toString(36).slice(2, 7);
const call = async (token: string | null, method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); let j: any; try { j = JSON.parse(t); } catch { j = t; } return { status: r.status, body: j };
};
async function operator(role: OperatorRole = 'admin') {
  const email = `op-${rnd()}@users.test`, r = await call(null, 'POST', '/auth/register', { agencyName: `Op Travel ${rnd()}`, name: 'Op', email, password: PASSWORD });
  await setPlatformAdmin(email, role); const tk = r.body.accessToken as string;
  const s = await call(tk, 'POST', '/auth/2fa/setup', {}); await call(tk, 'POST', '/auth/2fa/enable', { code: authenticator.generate(s.body.secret) }); return { token: tk };
}
let op: { token: string }; const P = (m: string, p: string, b?: unknown) => call(op.token, m, `/platform${p}`, b);
const JAZZ = { merchant_id: 'MC12345', password: 'jazzpass', integrity_salt: 'saltsalt1', sandbox: true, reason: 'test setup' };
const EASY = { store_id: '4321', hash_key: '4VJ8Z6VMRFN1RQ4E', sandbox: true, reason: 'test setup' };
const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
const back = (r: Response) => new URL(r.headers.get('location')!);
const jazzReturn = (f: Record<string, string>, salt = JAZZ.integrity_salt) => { const x = { ...f }; x.pp_SecureHash = LP.jazzSign(x, salt); return fetch(`${base}/api/pay-return/jazzcash`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form(x) }); };
const sub = async (a: Api) => (await sql('SELECT * FROM subscriptions WHERE agency_id = ?', [a.agencyId]))[0];
const planCode = `pk-${rnd()}`;
const asDate = (v: string) => new Date(`${String(v).replace(' ', 'T')}Z`).getTime();

beforeAll(async () => {
  await boot(); base = apiBase().replace(/\/api$/, ''); op = await operator('admin');
  const r = await P('POST', '/plans', { code: planCode, name: 'Rupee Plan', description: 'x', price_monthly: 10, price_yearly: 100, price_monthly_pkr: 5000, price_yearly_pkr: 50000, trial_days: 7, max_seats: 20, max_branches: 5, max_bookings_month: 500, features: ['portal'], support_level: 'email', active: true, sort: 60 });
  expect(r.status).toBe(201);
});
afterAll(async () => { await sql("UPDATE plans SET active = 0 WHERE code = ?", [planCode]); await sql("DELETE FROM platform_settings WHERE k IN ('lp_jazzcash','lp_easypaisa')"); await shutdown(); });

describe('signing', () => {
  it('JazzCash: HMAC-SHA256 over the salt and the non-empty pp_ values in name order; tampering or the wrong salt is caught', () => {
    const f: Record<string, string> = { pp_Amount: '500000', pp_MerchantID: 'MC1', pp_TxnRefNo: 'T1', pp_Language: 'EN', pp_Empty: '', ppmpf_1: '', other: 'ignored' };
    const want = crypto.createHmac('sha256', 'S3').update('S3&500000&EN&MC1&T1').digest('hex').toUpperCase();
    expect(LP.jazzSign(f, 'S3')).toBe(want);
    const signed = { ...f, pp_SecureHash: want }; expect(LP.jazzVerify(signed, 'S3')).toBe(true);
    expect(LP.jazzVerify({ ...signed, pp_Amount: '1' }, 'S3')).toBe(false); expect(LP.jazzVerify(signed, 'other')).toBe(false); expect(LP.jazzVerify({ ...f }, 'S3')).toBe(false);
  });
  it('Easypaisa: fields sorted and joined name=value&…, AES-ECB with the hash key, base64', () => {
    const h = LP.easyHash({ storeId: '1', amount: '10.0', autoRedirect: '1', paymentMethod: '' }, '4VJ8Z6VMRFN1RQ4E');
    const d = crypto.createDecipheriv('aes-128-ecb', Buffer.from('4VJ8Z6VMRFN1RQ4E'), null); expect(Buffer.concat([d.update(Buffer.from(h, 'base64')), d.final()]).toString()).toBe('amount=10.0&autoRedirect=1&storeId=1');
  });
});

describe('merchant settings (Super Admin)', () => {
  it('saves encrypted, never returns a secret, needs a reason and the right operator role, and validates the shapes', async () => {
    const before = (await P('GET', '/settings/local-pay')).body; expect(before.jazzcash.configured).toBe(false);
    expect((await P('PUT', '/settings/local-pay/jazzcash', { ...JAZZ, reason: '' })).status).toBe(400);
    expect((await P('PUT', '/settings/local-pay/jazzcash', { ...JAZZ, merchant_id: 'x y' })).status).toBe(400);
    expect((await P('PUT', '/settings/local-pay/easypaisa', { ...EASY, hash_key: 'short' })).status).toBe(400);
    expect((await P('PUT', '/settings/local-pay/easypaisa', { ...EASY, account_num: '123' })).status).toBe(400);   // all three inquiry details or none
    expect((await P('PUT', '/settings/local-pay/stripe', JAZZ)).status).toBe(404);
    const ro = await operator('readonly'); expect((await call(ro.token, 'PUT', '/platform/settings/local-pay/jazzcash', JAZZ)).status).toBe(403);
    const ok = await P('PUT', '/settings/local-pay/jazzcash', JAZZ); expect(ok.status).toBe(200);
    expect(ok.body.jazzcash).toMatchObject({ configured: true, sandbox: true, hint: '2345' }); const text = JSON.stringify(ok.body); expect(text).not.toContain('jazzpass'); expect(text).not.toContain('saltsalt1');
    expect((await sql("SELECT v_enc FROM platform_settings WHERE k = 'lp_jazzcash'"))[0].v_enc).not.toContain('saltsalt1');   // stored encrypted
    expect((await P('PUT', '/settings/local-pay/easypaisa', EASY)).body.easypaisa).toMatchObject({ configured: true, can_verify: false });
    expect((await sql("SELECT detail FROM platform_audit_log WHERE action = 'set_local_pay' ORDER BY id DESC LIMIT 1"))[0].detail).not.toMatch(/saltsalt1|jazzpass|4VJ8Z6/);   // secrets never reach the audit log
  });
});

describe('starting a payment', () => {
  it('is for admins, needs the provider switched on and a rupee price, and is refused for card-paid subscriptions', async () => {
    const A = await newAgency('PkStart'); await sql('UPDATE subscriptions SET plan_id = (SELECT id FROM plans WHERE code = ?) WHERE agency_id = ?', [planCode, A.agencyId]);
    const go = (a: Api, extra: object = {}) => a.post('/billing/local/start', { plan: planCode, interval: 'monthly', provider: 'jazzcash', ...extra });
    expect((await addMember(A, 'agent').then((m) => go(m))).status).toBe(403);
    await sql("DELETE FROM platform_settings WHERE k = 'lp_jazzcash'"); expect((await go(A)).status).toBe(501);
    await P('PUT', '/settings/local-pay/jazzcash', JAZZ);
    expect((await go(A, { plan: 'growth' })).status).toBe(409);                                       // no rupee price on that plan
    expect((await go(A, { provider: 'paypal' })).status).toBe(400);
    await sql("UPDATE subscriptions SET stripe_subscription_id = 'sub_x', status = 'active' WHERE agency_id = ?", [A.agencyId]);
    expect((await go(A)).status).toBe(409);
    expect((await A.get('/billing/subscription')).body.local_pay).toMatchObject({ jazzcash: { sandbox: true } });
    expect((await A.get('/billing/plans')).body.find((p: any) => p.code === planCode)).toMatchObject({ price_monthly_pkr: 5000, price_yearly_pkr: 50000 });
  });
});

describe('JazzCash payment', () => {
  it('sends a signed form, and only a correctly signed success extends the plan, exactly once; renewals stack', async () => {
    const A = await newAgency('PkJazz'); await P('PUT', '/settings/local-pay/jazzcash', JAZZ);
    const start = async () => (await A.post('/billing/local/start', { plan: planCode, interval: 'monthly', provider: 'jazzcash' })).body as LP.Checkout;
    const c = await start(); expect(c).toMatchObject({ provider: 'jazzcash', method: 'POST' }); expect(c.url).toBe('https://sandbox.jazzcash.com.pk/CustomerPortal/transactionmanagement/merchantform/');
    expect(c.fields).toMatchObject({ pp_Version: '1.1', pp_MerchantID: 'MC12345', pp_Amount: '500000', pp_TxnCurrency: 'PKR', pp_TxnRefNo: c.ref }); expect(c.ref).toMatch(/^T\d{14}\d{4}$/);
    expect(LP.jazzVerify(c.fields!, JAZZ.integrity_salt)).toBe(true); expect(c.fields!.pp_ReturnURL).toMatch(/\/api\/pay-return\/jazzcash$/);
    const ok = { pp_TxnRefNo: c.ref, pp_Amount: '500000', pp_ResponseCode: '000', pp_ResponseMessage: 'Thank you for Using JazzCash', pp_RetreivalReferenceNo: '123456' };
    // forged: not signed with the real salt, a wrong amount, or no signature at all
    expect(back(await jazzReturn(ok, 'wrong-salt')).searchParams.get('pay')).toBe('error');
    expect(back(await jazzReturn({ ...ok, pp_Amount: '100' })).searchParams.get('pay')).toBe('pending');
    expect((await fetch(`${base}/api/pay-return/jazzcash`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form(ok) })).status).toBe(303);
    expect((await sub(A)).status).toBe('trialing'); expect((await sql('SELECT status FROM local_payments WHERE txn_ref = ?', [c.ref]))[0].status).toBe('pending');
    // the real thing
    const r = await jazzReturn(ok); expect(r.status).toBe(303); expect(back(r).pathname).toBe('/billing'); expect(back(r).searchParams.get('pay')).toBe('paid');
    const s1 = await sub(A); expect(s1).toMatchObject({ status: 'active', is_manual: 1, billing_interval: 'monthly' }); expect(s1.trial_ends_at).toBeNull();
    const end1 = asDate(s1.current_period_end), days = (end1 - Date.now()) / 86400_000; expect(days).toBeGreaterThan(27); expect(days).toBeLessThan(32);
    expect((await sql('SELECT * FROM local_payments WHERE txn_ref = ?', [c.ref]))[0]).toMatchObject({ status: 'paid', settled_by: 'gateway', provider_ref: '123456' });
    expect(await sql("SELECT amount, currency, status FROM subscription_invoices WHERE stripe_invoice_id = ?", [c.ref])).toEqual([{ amount: 5000, currency: 'PKR', status: 'paid' }]);
    expect((await A.get('/billing/invoices')).body.some((i: any) => i.number === c.ref)).toBe(true);
    // the gateway repeats itself (browser return plus server notification): nothing changes
    expect(back(await jazzReturn(ok)).searchParams.get('pay')).toBe('paid'); expect(asDate((await sub(A)).current_period_end)).toBe(end1);
    expect((await sql("SELECT COUNT(*) n FROM billing_events WHERE agency_id = ? AND kind = 'local_payment'", [A.agencyId]))[0].n).toBe(1);
    // paying again early adds a month on top of what is already paid for
    const c2 = await start(); await jazzReturn({ ...ok, pp_TxnRefNo: c2.ref });
    const end2 = asDate((await sub(A)).current_period_end); expect(end2 - end1).toBeGreaterThan(27 * 86400_000); expect(end2 - end1).toBeLessThan(32 * 86400_000);
    // yearly costs the yearly rupee price
    const y = (await A.post('/billing/local/start', { plan: planCode, interval: 'yearly', provider: 'jazzcash' })).body; expect(y.fields.pp_Amount).toBe('5000000');
  });
  it('a failed or waiting result changes nothing but its status; a lapsed workspace is restored by a paid one', async () => {
    const A = await newAgency('PkJazzFail'); await P('PUT', '/settings/local-pay/jazzcash', JAZZ);
    const c = (await A.post('/billing/local/start', { plan: planCode, interval: 'monthly', provider: 'jazzcash' })).body as LP.Checkout;
    const base1 = { pp_TxnRefNo: c.ref, pp_Amount: '500000' };
    expect(back(await jazzReturn({ ...base1, pp_ResponseCode: '124', pp_ResponseMessage: 'Waiting' })).searchParams.get('pay')).toBe('pending');
    expect((await sql('SELECT status FROM local_payments WHERE txn_ref = ?', [c.ref]))[0].status).toBe('pending');
    expect(back(await jazzReturn({ ...base1, pp_ResponseCode: '999', pp_ResponseMessage: 'Declined' })).searchParams.get('pay')).toBe('failed');
    expect((await sql('SELECT status, gateway_code FROM local_payments WHERE txn_ref = ?', [c.ref]))[0]).toMatchObject({ status: 'failed', gateway_code: '999' }); expect((await sub(A)).status).toBe('trialing');
    expect(back(await jazzReturn({ pp_TxnRefNo: 'TNOSUCHREF', pp_ResponseCode: '000' })).searchParams.get('pay')).toBe('unknown');
    await sql("UPDATE subscriptions SET status = 'suspended' WHERE agency_id = ?", [A.agencyId]);
    const c2 = (await A.post('/billing/local/start', { plan: planCode, interval: 'monthly', provider: 'jazzcash' })).body as LP.Checkout;   // billing still works while suspended
    await jazzReturn({ ...base1, pp_TxnRefNo: c2.ref, pp_ResponseCode: '000' }); expect((await sub(A)).status).toBe('active');
  });
  it('slows down someone who starts many payments', async () => {
    const A = await newAgency('PkJazzRate'); await P('PUT', '/settings/local-pay/jazzcash', JAZZ); let last = 0;
    for (let i = 0; i < 6; i++) last = (await A.post('/billing/local/start', { plan: planCode, interval: 'monthly', provider: 'jazzcash' })).status; expect(last).toBe(429);
  });
});

describe('Easypaisa payment', () => {
  const ret = (ref: string, q: Record<string, string>) => fetch(`${base}/api/pay-return/easypaisa/${ref}?${form(q)}`, { redirect: 'manual' });
  it('sends an encrypted request; success is only believed once Easypaisa itself says paid', async () => {
    const A = await newAgency('PkEasy'); await P('PUT', '/settings/local-pay/easypaisa', EASY);
    const c = (await A.post('/billing/local/start', { plan: planCode, interval: 'monthly', provider: 'easypaisa' })).body as LP.Checkout;
    expect(c).toMatchObject({ provider: 'easypaisa', method: 'GET' }); const u = new URL(c.url); expect(u.origin + u.pathname).toBe('https://easypaystg.easypaisa.com.pk/easypay/Index.jsf');
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ storeId: '4321', amount: '5000.0', orderRefNum: c.ref, autoRedirect: '1' }); expect(u.searchParams.get('postBackURL')).toMatch(new RegExp(`/api/pay-return/easypaisa/${c.ref}$`));
    const p = Object.fromEntries(u.searchParams); const hashed = p.merchantHashedReq; delete (p as any).merchantHashedReq; expect(hashed).toBe(LP.easyHash(p, EASY.hash_key));
    // step 1: the customer comes back with a token, to be confirmed with Easypaisa
    const t1 = await ret(c.ref, { auth_token: 'tok123' }); expect(t1.status).toBe(303); const cl = new URL(t1.headers.get('location')!); expect(cl.origin + cl.pathname).toBe('https://easypaystg.easypaisa.com.pk/easypay/Confirm.jsf'); expect(cl.searchParams.get('auth_token')).toBe('tok123');
    // step 2 without a way to verify: a claimed success is not enough
    expect(back(await ret(c.ref, { status: '0000', desc: 'ok' })).searchParams.get('pay')).toBe('pending'); expect((await sub(A)).status).toBe('trialing');
    expect((await sql('SELECT gateway_message FROM local_payments WHERE txn_ref = ?', [c.ref]))[0].gateway_message).toMatch(/could not be confirmed automatically/);
    // with the inquiry login saved, Easypaisa is asked directly
    await P('PUT', '/settings/local-pay/easypaisa', { ...EASY, account_num: '03001234567', username: 'u', password: 'p' }); expect((await P('GET', '/settings/local-pay')).body.easypaisa.can_verify).toBe(true);
    const ask = vi.spyOn(LP.http, 'postJson');
    ask.mockResolvedValueOnce({ status: 200, json: { responseCode: '0000', transactionStatus: 'PAID', transactionAmount: 1 } });   // wrong amount
    expect(back(await ret(c.ref, { status: '0000' })).searchParams.get('pay')).toBe('pending'); expect((await sub(A)).status).toBe('trialing');
    ask.mockResolvedValueOnce({ status: 200, json: { responseCode: '0000', transactionStatus: 'PENDING' } });
    expect(back(await ret(c.ref, { status: '0000' })).searchParams.get('pay')).toBe('pending');
    ask.mockResolvedValueOnce({ status: 200, json: { responseCode: '0000', transactionStatus: 'PAID', transactionAmount: 5000 } });
    expect(back(await ret(c.ref, { status: '0000' })).searchParams.get('pay')).toBe('paid');
    expect(ask).toHaveBeenLastCalledWith('https://easypaystg.easypaisa.com.pk/easypay-service/rest/v4/inquire-transaction', { orderId: c.ref, storeId: '4321', accountNum: '03001234567' }, { Credentials: Buffer.from('u:p').toString('base64') });
    expect(await sub(A)).toMatchObject({ status: 'active', is_manual: 1 });
    expect(back(await ret(c.ref, { status: '0000' })).searchParams.get('pay')).toBe('paid'); expect(ask).toHaveBeenCalledTimes(3);   // already paid: no second ask, no second extension
    ask.mockRestore();
  });
  it('a reported failure is believed (it can never grant access); a bad reference is ignored', async () => {
    const A = await newAgency('PkEasyFail'); await P('PUT', '/settings/local-pay/easypaisa', EASY);
    const c = (await A.post('/billing/local/start', { plan: planCode, interval: 'monthly', provider: 'easypaisa' })).body as LP.Checkout;
    expect(back(await ret(c.ref, { status: '0001', desc: 'Declined by bank' })).searchParams.get('pay')).toBe('failed');
    expect((await sql('SELECT status, gateway_message FROM local_payments WHERE txn_ref = ?', [c.ref]))[0]).toMatchObject({ status: 'failed', gateway_message: 'Declined by bank' }); expect((await sub(A)).status).toBe('trialing');
    expect(back(await ret('TNOPE', { status: '0000' })).searchParams.get('pay')).toBe('unknown');
    const j = (await A.post('/billing/local/start', { plan: planCode, interval: 'monthly', provider: 'jazzcash' })).status; expect([200, 501]).toContain(j);
    expect(back(await ret(((await A.get('/billing/local/payments')).body as any[])[0].txn_ref, { status: '0000' })).searchParams.get('pay')).toMatch(/unknown|pending|failed/);   // a JazzCash row is never settled through the Easypaisa address
  });
});

describe('operators settling a payment by hand', () => {
  it('confirm extends the plan once with an audit trail; reject marks it failed; both need a reason and the billing role', async () => {
    const A = await newAgency('PkManual'); await P('PUT', '/settings/local-pay/easypaisa', EASY);
    const mk = async () => ((await A.post('/billing/local/start', { plan: planCode, interval: 'monthly', provider: 'easypaisa' })).body as LP.Checkout).ref;
    const r1 = await mk(), id1 = (await sql('SELECT id FROM local_payments WHERE txn_ref = ?', [r1]))[0].id;
    const list = (await P('GET', '/local-payments?status=pending')).body; expect(list.rows.some((x: any) => x.id === id1 && x.agency_name)).toBe(true); expect(list.counts.pending).toBeGreaterThan(0);
    expect((await P('POST', `/local-payments/${id1}/confirm`, {})).status).toBe(400);
    const ro = await operator('readonly'); expect((await call(ro.token, 'POST', `/platform/local-payments/${id1}/confirm`, { reason: 'checked the Easypaisa portal' })).status).toBe(403);
    expect((await P('POST', `/local-payments/${id1}/confirm`, { reason: 'Checked in the Easypaisa merchant portal' })).status).toBe(200);
    expect(await sub(A)).toMatchObject({ status: 'active', is_manual: 1 }); expect((await sql('SELECT status, settled_by FROM local_payments WHERE id = ?', [id1]))[0]).toMatchObject({ status: 'paid', settled_by: 'operator' });
    expect((await P('POST', `/local-payments/${id1}/confirm`, { reason: 'again' })).status).toBe(409);
    expect((await sql("SELECT COUNT(*) n FROM platform_audit_log WHERE action = 'local_payment_confirm' AND agency_id = ?", [A.agencyId]))[0].n).toBe(1);
    const r2 = await mk(), id2 = (await sql('SELECT id FROM local_payments WHERE txn_ref = ?', [r2]))[0].id;
    expect((await P('POST', `/local-payments/${id2}/reject`, { reason: 'Never arrived in the merchant account' })).status).toBe(200);
    expect((await sql('SELECT status FROM local_payments WHERE id = ?', [id2]))[0].status).toBe('failed'); expect((await P('POST', '/local-payments/999999/confirm', { reason: 'nope' })).status).toBe(404);
  });
});

describe('plan rupee prices', () => {
  it('are saved with the plan, left alone when not sent, and can be cleared', async () => {
    const id = (await sql('SELECT id FROM plans WHERE code = ?', [planCode]))[0].id, body = { name: 'Rupee Plan', description: 'x', price_monthly: 10, price_yearly: 100, trial_days: 7, max_seats: 20, max_branches: 5, max_bookings_month: 500, features: ['portal'], support_level: 'email', active: true, sort: 60, reason: 'prices' };
    expect((await P('PUT', `/plans/${id}`, body)).status).toBe(200); expect(Number((await sql('SELECT price_monthly_pkr p FROM plans WHERE id = ?', [id]))[0].p)).toBe(5000);   // untouched
    expect((await P('PUT', `/plans/${id}`, { ...body, price_monthly_pkr: 6000 })).status).toBe(200); expect(Number((await sql('SELECT price_monthly_pkr p, price_yearly_pkr y FROM plans WHERE id = ?', [id]))[0].p)).toBe(6000);
    expect((await P('PUT', `/plans/${id}`, { ...body, price_monthly_pkr: null, price_yearly_pkr: null })).status).toBe(200); expect((await sql('SELECT price_monthly_pkr p FROM plans WHERE id = ?', [id]))[0].p).toBeNull();
    await sql('UPDATE plans SET price_monthly_pkr = 5000, price_yearly_pkr = 50000 WHERE id = ?', [id]);
  });
});
