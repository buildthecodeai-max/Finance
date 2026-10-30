import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Api, addMember, apiBase, boot, newAgency, shutdown, sql } from './helpers.js';
import { applyBillingEvent, gateway, runLifecycle } from '../services/billing.js';

let base: string; const rnd = () => Math.random().toString(36).slice(2, 7);
const planOf = async (a: Api, code: string, iv = 'monthly') => { await sql("UPDATE subscriptions SET plan_id = (SELECT id FROM plans WHERE code = ?), billing_interval = ? WHERE agency_id = ?", [code, iv, a.agencyId]); };
const sub = async (a: Api) => (await sql('SELECT * FROM subscriptions WHERE agency_id = ?', [a.agencyId]))[0];
const status = async (a: Api) => (await sub(a)).status as string;
const evt = (type: string, object: any, id = `evt_${rnd()}${rnd()}`) => ({ id, type, data: { object } });
const mkClient = (a: Api) => a.post('/clients', { name: `C ${rnd()}`, email: `${rnd()}@c.test`, currency: 'USD' });
const days = (n: number) => new Date(Date.now() + n * 86400_000);

beforeAll(async () => { await boot(); base = apiBase().replace(/\/api$/, ''); });
afterAll(shutdown);

describe('trial and plans', () => {
  it('every new agency starts a 14-day trial of Growth; plans are listed with limits and features', async () => {
    const A = await newAgency('BillA'); const s = await sub(A);
    expect(s.status).toBe('trialing'); const left = (new Date(String(s.trial_ends_at).replace(' ', 'T') + 'Z').getTime() - Date.now()) / 86400_000; expect(left).toBeGreaterThan(13); expect(left).toBeLessThan(15);
    const v = (await A.get('/billing/subscription')).body; expect(v.subscription).toMatchObject({ status: 'trialing', plan: { code: 'growth' } }); expect(v.limits.seats).toBe(10); expect(v.features).toContain('automation'); expect(v.banner.message).toMatch(/trial/i); expect(v.usage.seats).toBe(1); expect(v.read_only).toBe(false);
    const plans = (await A.get('/billing/plans')).body; expect(plans.map((p: any) => p.code).filter((c: string) => ['starter', 'growth', 'scale'].includes(c))).toEqual(['starter', 'growth', 'scale']); expect(plans.find((p: any) => p.code === 'scale').max_bookings_month).toBeNull();
  });
});

describe('entitlements', () => {
  it('enforces seat, branch and booking limits with a clear 402 and machine-readable code', async () => {
    const A = await newAgency('BillLimits'); await planOf(A, 'starter');                        // 3 seats, 1 branch
    await addMember(A, 'agent'); await addMember(A, 'viewer');                                   // admin + 2 = 3 seats
    const over = await A.post('/team', { email: `x-${rnd()}@t.dev`, name: 'X', role: 'agent', password: 'Passw0rd#12345' });
    expect(over.status).toBe(402); expect(over.body).toMatchObject({ code: 'plan_limit', limit_kind: 'seats', limit: 3, used: 3 }); expect(over.body.error).toMatch(/Upgrade/);
    const br = await A.post('/accounting/branches', { name: 'Second' }); expect(br.status).toBe(402); expect(br.body).toMatchObject({ code: 'plan_limit', limit_kind: 'branches', limit: 1 });   // the head-office branch already uses the one allowed
    const code = `tiny-${rnd()}`; await sql("INSERT INTO plans (code, name, price_monthly, price_yearly, max_seats, max_branches, max_bookings_month, features, active, sort) VALUES (?, 'Tiny', 1, 10, 5, 5, 2, 'portal', 0, 99)", [code]);
    await sql('UPDATE subscriptions SET plan_id = (SELECT id FROM plans WHERE code = ?) WHERE agency_id = ?', [code, A.agencyId]);
    const c = (await mkClient(A)).body.id;
    expect((await A.post('/bookings', { client_id: c, destination: 'A' })).status).toBe(201); expect((await A.post('/bookings', { client_id: c, destination: 'B' })).status).toBe(201);
    const third = await A.post('/bookings', { client_id: c, destination: 'C' }); expect(third.status).toBe(402); expect(third.body.limit_kind).toBe('bookings');
    expect((await A.get('/bookings')).status).toBe(200);                                         // reading is never blocked
  });
  it('gates features by plan, upgrades take effect immediately, and the public API follows the plan', async () => {
    const A = await newAgency('BillFeat'); const key = (await A.post('/hub/api-keys', { name: 'test key', scopes: ['clients:read'] })).body.key as string;
    expect((await fetch(`${base}/api/v1/clients`, { headers: { authorization: `Bearer ${key}` } })).status).toBe(200);
    await planOf(A, 'starter');
    for (const p of ['/hub/api-keys', '/hub/webhooks', '/automation/rules', '/automation/schedules']) { const r = await A.get(p); expect(r.status, p).toBe(402); expect(r.body.code).toBe('plan_limit'); }
    expect((await A.get('/hub/exports/journals')).status).toBe(200);                              // accounting export is in every plan
    const r = await fetch(`${base}/api/v1/clients`, { headers: { authorization: `Bearer ${key}` } }); expect(r.status).toBe(402);
    expect((await A.post('/billing/change-plan', { plan: 'growth' })).body).toEqual({ applied: 'now' });   // trial: free, immediate
    expect((await A.get('/automation/rules')).status).toBe(200); expect((await fetch(`${base}/api/v1/clients`, { headers: { authorization: `Bearer ${key}` } })).status).toBe(200);
  });
  it('refuses a downgrade the current usage does not fit, and never deletes data to make one work', async () => {
    const A = await newAgency('BillFit'); for (let i = 0; i < 3; i++) await addMember(A, 'agent');   // 4 seats
    const r = await A.post('/billing/change-plan', { plan: 'starter' }); expect(r.status).toBe(402); expect(r.body.error).toMatch(/4 team members/); expect((await sub(A)).plan_id).toBeTruthy();
    expect((await A.get('/billing/subscription')).body.subscription.plan.code).toBe('growth');
  });
});

describe('lifecycle', () => {
  it('trial → grace → suspended (read-only) → reactivated by payment; reminders and notices are sent once', async () => {
    const A = await newAgency('BillLife'), client = (await mkClient(A)).body.id; const link = (await A.post('/portal-admin/links', { client_id: client })).body.url.split('/').pop();
    await sql("UPDATE subscriptions SET trial_ends_at = ? WHERE agency_id = ?", [days(2).toISOString().slice(0, 19).replace('T', ' '), A.agencyId]);
    await runLifecycle(new Date(), A.agencyId); await runLifecycle(new Date(), A.agencyId);
    expect((await sql("SELECT COUNT(*) n FROM billing_events WHERE agency_id = ? AND kind = 'trial_reminder'", [A.agencyId]))[0].n).toBe(1);   // twice run, once sent
    await sql("UPDATE subscriptions SET trial_ends_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 HOUR) WHERE agency_id = ?", [A.agencyId]);
    await runLifecycle(new Date(), A.agencyId); expect(await status(A)).toBe('grace');
    expect((await mkClient(A)).status).toBe(201);                                                   // grace: everything still works
    expect((await A.get('/billing/subscription')).body.banner.level).toBe('warn');
    const r = await runLifecycle(days(8), A.agencyId); expect(r.suspended).toBe(1); expect(await status(A)).toBe('suspended'); await runLifecycle(days(9), A.agencyId);
    expect((await sql("SELECT COUNT(*) n FROM billing_events WHERE agency_id = ? AND kind IN ('trial_ended','suspended')", [A.agencyId]))[0].n).toBe(2);
    const blocked = await A.post('/clients', { name: 'Nope', currency: 'USD' }); expect(blocked.status).toBe(402); expect(blocked.body).toMatchObject({ code: 'subscription_inactive', sub_status: 'suspended' });
    expect((await A.get('/clients')).status).toBe(200); expect((await A.get('/billing/subscription')).body.read_only).toBe(true);
    expect((await A.get('/invoices')).status).toBe(200);
    expect((await fetch(`${base}/api/public/portal/${link}`)).status).toBe(200);                   // the agency's customers are not punished
    const sid = `sub_${rnd()}`; await sql('UPDATE subscriptions SET stripe_customer_id = ?, stripe_subscription_id = ? WHERE agency_id = ?', [`cus_${rnd()}`, sid, A.agencyId]);
    expect(await applyBillingEvent(evt('invoice.paid', { id: `in_${rnd()}`, subscription: sid, customer: 'x', amount_paid: 14900, currency: 'usd', hosted_invoice_url: 'https://stripe.test/i' }))).toBe('applied');
    expect(await status(A)).toBe('active'); expect((await mkClient(A)).status).toBe(201);
  });
  it('past-due payments give a grace period before suspension, with dunning sent once', async () => {
    const A = await newAgency('BillDun'); const sid = `sub_${rnd()}`; await sql("UPDATE subscriptions SET status = 'active', stripe_subscription_id = ?, stripe_customer_id = ?, current_period_end = ? WHERE agency_id = ?", [sid, `cus_${rnd()}`, days(20).toISOString().slice(0, 19).replace('T', ' '), A.agencyId]);
    await applyBillingEvent(evt('invoice.payment_failed', { id: `in_${rnd()}`, subscription: sid, amount_due: 14900, currency: 'usd' }));
    const s = await sub(A); expect(s.status).toBe('past_due'); expect(s.grace_until).toBeTruthy(); expect((await A.get('/billing/subscription')).body.banner.message).toMatch(/Payment failed/);
    await runLifecycle(new Date(), A.agencyId); await runLifecycle(new Date(), A.agencyId);
    expect((await sql("SELECT COUNT(*) n FROM billing_events WHERE agency_id = ? AND kind = 'payment_failed'", [A.agencyId]))[0].n).toBe(1);
    expect((await mkClient(A)).status).toBe(201);                                                   // still working during grace
    await runLifecycle(days(8), A.agencyId); expect(await status(A)).toBe('suspended');
  });
  it('scheduled cancellation ends the subscription at period end; resuming before then cancels the cancellation', async () => {
    const A = await newAgency('BillCancel'); await sql("UPDATE subscriptions SET status = 'active', is_manual = 1, current_period_end = ? WHERE agency_id = ?", [days(10).toISOString().slice(0, 19).replace('T', ' '), A.agencyId]);
    expect((await A.post('/billing/cancel')).status).toBe(200); expect((await A.get('/billing/subscription')).body.banner.message).toMatch(/ends on/);
    await runLifecycle(days(5), A.agencyId); expect(await status(A)).toBe('active');
    expect((await A.post('/billing/resume')).status).toBe(200); await runLifecycle(days(11), A.agencyId); expect(await status(A)).toBe('grace');   // manual customers fall into grace, not cancellation
    const B = await newAgency('BillCancel2'); await sql("UPDATE subscriptions SET status = 'active', is_manual = 1, current_period_end = ? WHERE agency_id = ?", [days(10).toISOString().slice(0, 19).replace('T', ' '), B.agencyId]);
    await B.post('/billing/cancel'); await sql('UPDATE subscriptions SET is_manual = 0 WHERE agency_id = ?', [B.agencyId]); await runLifecycle(days(11), B.agencyId); expect(await status(B)).toBe('cancelled');
    expect((await B.post('/clients', { name: 'x', currency: 'USD' })).body.code).toBe('subscription_inactive');
  });
  it('manual (invoiced) customers are granted access until a date, then enter grace', async () => {
    const { grantManual } = await import('../services/billing.js'); const A = await newAgency('BillManual'); await grantManual(A.agencyId, 'scale', 'yearly', days(30));
    const s = await sub(A); expect(s).toMatchObject({ status: 'active', is_manual: 1, billing_interval: 'yearly' }); expect((await A.get('/billing/subscription')).body.subscription).toMatchObject({ manual: true, plan: { code: 'scale' } });
    await runLifecycle(days(31), A.agencyId); expect(await status(A)).toBe('grace');
  });
});

describe('Stripe events', () => {
  it('apply once, map plans by price, mirror invoices, and ignore strangers', async () => {
    const A = await newAgency('BillStripe'), pm = `price_m_${rnd()}`, py = `price_y_${rnd()}`;
    await sql("UPDATE plans SET stripe_price_monthly = ?, stripe_price_yearly = ? WHERE code = 'scale'", [pm, py]);
    try {
      const co = evt('checkout.session.completed', { mode: 'subscription', customer: 'cus_1', subscription: 'sub_1', metadata: { kind: 'subscription', agency_id: String(A.agencyId), plan_code: 'starter', interval: 'yearly' } });
      expect(await applyBillingEvent(co)).toBe('applied'); expect(await applyBillingEvent(co)).toBe('duplicate');
      expect(await sub(A)).toMatchObject({ status: 'active', stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1', billing_interval: 'yearly', is_manual: 0 });
      expect((await A.get('/billing/subscription')).body.subscription.plan.code).toBe('starter');
      const end = Math.floor(Date.now() / 1000) + 86400 * 30;
      await applyBillingEvent(evt('customer.subscription.updated', { object: 'subscription', id: 'sub_1', status: 'active', current_period_start: end - 2592000, current_period_end: end, cancel_at_period_end: true, items: { data: [{ price: { id: pm } }] } }));
      expect(await sub(A)).toMatchObject({ billing_interval: 'monthly', cancel_at_period_end: 1 }); expect((await A.get('/billing/subscription')).body.subscription.plan.code).toBe('scale');
      const inv = evt('invoice.paid', { id: 'in_dup', subscription: 'sub_1', customer: 'cus_1', amount_paid: 39900, currency: 'usd', number: 'INV-1', hosted_invoice_url: 'https://stripe.test/in_dup' }); await applyBillingEvent(inv); await applyBillingEvent(inv);
      expect((await sql('SELECT COUNT(*) n FROM subscription_invoices WHERE agency_id = ?', [A.agencyId]))[0].n).toBe(1);
      const list = (await A.get('/billing/invoices')).body; expect(list[0]).toMatchObject({ amount: 399, status: 'paid', number: 'INV-1' });
      expect(await applyBillingEvent(evt('customer.subscription.updated', { object: 'subscription', id: 'sub_unknown', status: 'active' }))).toBe('ignored');
      await applyBillingEvent(evt('customer.subscription.deleted', { object: 'subscription', id: 'sub_1', status: 'canceled' })); expect(await status(A)).toBe('cancelled');
    } finally { await sql("UPDATE plans SET stripe_price_monthly = NULL, stripe_price_yearly = NULL WHERE code = 'scale'"); }
  });
});

describe('agency actions', () => {
  it('subscribe → checkout; upgrades are prorated immediately; downgrades wait for renewal; portal needs a customer', async () => {
    const A = await newAgency('BillPay'), pm = `pm_${rnd()}`; const en = vi.spyOn(gateway, 'enabled').mockReturnValue(true);
    const co = vi.spyOn(gateway, 'checkout').mockResolvedValue('https://checkout.test/s'), ch = vi.spyOn(gateway, 'changePlan').mockResolvedValue(undefined), po = vi.spyOn(gateway, 'portal').mockResolvedValue('https://portal.test/p');
    await sql("UPDATE plans SET stripe_price_monthly = CONCAT(?, code), stripe_price_yearly = CONCAT(?, code, 'y') WHERE code IN ('starter','growth','scale')", [pm, pm]);
    try {
      expect((await A.post('/billing/portal')).status).toBe(409);
      expect((await A.post('/billing/subscribe', { plan: 'growth', interval: 'monthly' })).body.url).toBe('https://checkout.test/s');
      expect(co.mock.calls[0][0]).toMatchObject({ agencyId: A.agencyId, planCode: 'growth', priceId: `${pm}growth`, interval: 'monthly' }); expect((await A.post('/billing/subscribe', { plan: 'nope' })).status).toBe(400);
      const end = days(20).toISOString().slice(0, 19).replace('T', ' '); await sql("UPDATE subscriptions SET status = 'active', stripe_customer_id = 'cus_x', stripe_subscription_id = 'sub_x', current_period_end = ? WHERE agency_id = ?", [end, A.agencyId]);
      expect((await A.post('/billing/subscribe', { plan: 'scale' })).status).toBe(409);            // already subscribed: use change-plan
      expect((await A.post('/billing/portal')).body.url).toBe('https://portal.test/p');
      expect((await A.post('/billing/change-plan', { plan: 'scale' })).body.applied).toBe('now'); expect(ch).toHaveBeenLastCalledWith('sub_x', `${pm}scale`, true);
      expect((await A.get('/billing/subscription')).body.subscription.plan.code).toBe('scale');
      expect((await A.post('/billing/change-plan', { plan: 'starter' })).body.applied).toBe('period_end'); expect(ch).toHaveBeenCalledTimes(1);   // nothing charged or changed yet
      expect((await A.get('/billing/subscription')).body.subscription).toMatchObject({ plan: { code: 'scale' }, pending_plan: { code: 'starter' } });
      await runLifecycle(days(21), A.agencyId); expect(ch).toHaveBeenLastCalledWith('sub_x', `${pm}starter`, false);
      expect((await A.get('/billing/subscription')).body.subscription).toMatchObject({ plan: { code: 'starter' }, pending_plan: null });
      expect((await A.post('/billing/change-plan', { plan: 'starter' })).status).toBe(409);
    } finally { en.mockRestore(); co.mockRestore(); ch.mockRestore(); po.mockRestore(); await sql("UPDATE plans SET stripe_price_monthly = NULL, stripe_price_yearly = NULL"); }
  });
  it('is honest when online billing is not configured', async () => {
    const A = await newAgency('BillNoStripe'); expect((await A.post('/billing/subscribe', { plan: 'growth' })).status).toBe(501); expect((await A.get('/billing/subscription')).body.online_billing).toBe(false);
  });
  it('only admins manage billing; everyone sees status; agencies are isolated', async () => {
    const A = await newAgency('BillRoles'), B = await newAgency('BillRolesB'); const fin = await addMember(A, 'finance_manager'), agent = await addMember(A, 'agent'), viewer = await addMember(A, 'viewer');
    for (const u of [fin, agent, viewer]) { expect((await u.get('/billing/subscription')).status).toBe(200); for (const p of ['/billing/subscribe', '/billing/cancel', '/billing/change-plan', '/billing/portal']) expect((await u.post(p, { plan: 'growth' })).status, p).toBe(403); }
    expect((await fin.get('/billing/invoices')).status).toBe(200); expect((await agent.get('/billing/invoices')).status).toBe(403);
    await sql("UPDATE subscriptions SET status = 'cancelled' WHERE agency_id = ?", [B.agencyId]); expect((await A.get('/billing/subscription')).body.subscription.status).toBe('trialing'); expect((await B.get('/billing/subscription')).body.read_only).toBe(true);
    expect((await B.post('/clients', { name: 'x', currency: 'USD' })).status).toBe(402); expect((await mkClient(A)).status).toBe(201);
  });
});
