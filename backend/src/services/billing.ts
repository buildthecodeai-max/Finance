import { NextFunction, Request, Response } from 'express';
import Stripe from 'stripe';
import { config } from '../config.js';
import { HttpError } from '../errors.js';
import { Tenant, pool } from '../db.js';
import { deliver } from './portal.js';
import { fmt } from './money.js';

export const FEATURES = ['portal', 'accounting_export', 'automation', 'scheduled_reports', 'integrations', 'api', 'ai_assistant'] as const;
export type Feature = (typeof FEATURES)[number];
export const FULL_ACCESS = ['trialing', 'active', 'past_due', 'grace'];     // everything works (past_due/grace show a banner)
export const GRACE_DAYS = 7, TRIAL_REMINDER_DAYS = [3, 1];
const sqlTime = (d: Date) => d.toISOString().slice(0, 19).replace('T', ' ');
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86400_000);
const addInterval = (d: Date, i: string) => { const x = new Date(d); if (i === 'yearly') x.setUTCFullYear(x.getUTCFullYear() + 1); else x.setUTCMonth(x.getUTCMonth() + 1); return x; };
const planErr = (message: string, extra: object = {}) => Object.assign(new HttpError(402, message), { code: 'plan_limit', ...extra });

/** Payment provider. Swappable so tests (and other providers) can replace Stripe. */
export const gateway = {
  enabled: () => !!config.stripeKey,
  stripe: () => new Stripe(config.stripeKey),
  async checkout(o: { agencyId: number; planCode: string; interval: string; priceId: string; customer?: string | null; email?: string; successUrl: string; cancelUrl: string }): Promise<string> {
    const meta = { kind: 'subscription', agency_id: String(o.agencyId), plan_code: o.planCode, interval: o.interval };
    const s = await this.stripe().checkout.sessions.create({ mode: 'subscription', line_items: [{ price: o.priceId, quantity: 1 }], metadata: meta, subscription_data: { metadata: meta },
      ...(o.customer ? { customer: o.customer } : { customer_email: o.email }), success_url: o.successUrl, cancel_url: o.cancelUrl, allow_promotion_codes: true });
    return s.url!;
  },
  async portal(customer: string, returnUrl: string): Promise<string> { return (await this.stripe().billingPortal.sessions.create({ customer, return_url: returnUrl })).url; },
  async changePlan(subscriptionId: string, priceId: string, prorate: boolean): Promise<void> {
    const sub = await this.stripe().subscriptions.retrieve(subscriptionId);
    await this.stripe().subscriptions.update(subscriptionId, { items: [{ id: sub.items.data[0].id, price: priceId }], proration_behavior: prorate ? 'create_prorations' : 'none' });
  },
  async setCancel(subscriptionId: string, cancel: boolean): Promise<void> { await this.stripe().subscriptions.update(subscriptionId, { cancel_at_period_end: cancel }); },
};

/* ------------------------------------------------------------------ reading state */
export async function getSub(agencyId: number) {
  const [[s]]: any = await pool.query(`SELECT s.*, p.code plan_code, p.name plan_name, p.price_monthly, p.price_yearly, p.currency, p.max_seats, p.max_branches, p.max_bookings_month, p.features, p.allowed_modules, p.support_level, p.trial_days
    FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.agency_id = ?`, [agencyId]);
  return s as any | undefined;
}
export async function entitlements(agencyId: number) {
  const s = await getSub(agencyId);
  if (!s) return { status: 'cancelled', readOnly: true, features: new Set<string>(), limits: { seats: 0, branches: 0, bookings: 0 }, plan: null as any, sub: null as any };
  const features = new Set<string>(String(s.features).split(',').filter(Boolean));
  const [[ag]]: any = await pool.query('SELECT ai_access FROM agencies WHERE id = ?', [agencyId]);      // a platform operator can force the AI assistant on or off for one agency
  if (ag?.ai_access === 'on') features.add('ai_assistant'); else if (ag?.ai_access === 'off') features.delete('ai_assistant');
  return { status: s.status as string, readOnly: !FULL_ACCESS.includes(s.status), features,
    limits: { seats: s.max_seats as number | null, branches: s.max_branches as number | null, bookings: s.max_bookings_month as number | null }, plan: { code: s.plan_code, name: s.plan_name }, sub: s };
}
export async function usage(agencyId: number) {
  const q = async (sql: string) => ((await pool.query(sql, [agencyId])) as any)[0][0].n as number;
  return { seats: await q('SELECT COUNT(*) n FROM memberships WHERE agency_id = ?'), branches: await q('SELECT COUNT(*) n FROM branches WHERE agency_id = ?'),
    bookings: await q("SELECT COUNT(*) n FROM bookings WHERE agency_id = ? AND created_at >= DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-01')") };
}
export const hasFeature = async (agencyId: number, f: Feature) => (await entitlements(agencyId)).features.has(f);

/** Throws 402 when creating `add` more of something would exceed the plan. */
export async function assertWithinLimit(agencyId: number, kind: 'seats' | 'branches' | 'bookings', add = 1) {
  const e = await entitlements(agencyId), limit = e.limits[kind];
  if (limit === null || limit === undefined) return;
  const used = (await usage(agencyId))[kind];
  if (used + add > limit) throw planErr(`Your ${e.plan?.name ?? ''} plan allows ${limit} ${kind === 'bookings' ? 'bookings per month' : kind === 'seats' ? 'team members' : 'branches'} (${used} used). Upgrade under Billing to add more.`, { limit_kind: kind, limit, used });
}

export const requireFeature = (f: Feature) => async (req: Request, _res: Response, next: NextFunction) => {
  try {
    const e = await entitlements(req.ctx!.agencyId);
    if (!e.features.has(f)) throw planErr(`${f.replace(/_/g, ' ')} is not included in your ${e.plan?.name ?? ''} plan. Upgrade under Billing to use it.`, { feature: f });
    next();
  } catch (err) { next(err); }
};

/** Suspended or cancelled workspaces stay readable (your data is yours) but cannot be changed. Billing and sign-in always work. */
export async function subscriptionGuard(req: Request, _res: Response, next: NextFunction) {
  try {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS' || req.path.startsWith('/billing')) return next();
    const e = await entitlements(req.ctx!.agencyId);
    if (e.readOnly) throw Object.assign(new HttpError(402, e.status === 'cancelled' ? 'This subscription is cancelled. Your data is read-only — resubscribe under Billing to continue.' : 'This workspace is suspended for non-payment and is read-only. Update your payment details under Billing to restore access.'), { code: 'subscription_inactive', sub_status: e.status });
    next();
  } catch (err) { next(err); }
}

/* ------------------------------------------------------------------ lifecycle */
export async function startTrial(agencyId: number, planCode = 'growth') {
  const [[p]]: any = await pool.query('SELECT id, trial_days FROM plans WHERE code = ? AND active = 1', [planCode]);
  await pool.query('INSERT IGNORE INTO subscriptions (agency_id, plan_id, status, trial_ends_at) VALUES (?,?,?,?)', [agencyId, p.id, 'trialing', sqlTime(addDays(new Date(), p.trial_days))]);
  await pool.query('INSERT IGNORE INTO billing_events (agency_id, kind, detail) VALUES (?,?,?)', [agencyId, 'trial_started', `${planCode}, ${p.trial_days} days`]);
}
const log = (c: any, agencyId: number, kind: string, detail: string | null, key?: string, by?: number | null) =>
  c.query('INSERT IGNORE INTO billing_events (agency_id, kind, detail, event_key, created_by) VALUES (?,?,?,?,?)', [agencyId, kind, detail, key ?? null, by ?? null]).then((r: any) => r[0].affectedRows === 1);

async function planByPrice(priceId: string | undefined) { if (!priceId) return null; const [[p]]: any = await pool.query('SELECT * FROM plans WHERE stripe_price_monthly = ? OR stripe_price_yearly = ?', [priceId, priceId]); return p ? { ...p, interval: p.stripe_price_yearly === priceId ? 'yearly' : 'monthly' } : null; }
const ts = (unix?: number | null) => (unix ? sqlTime(new Date(unix * 1000)) : null);

/** Apply a Stripe event to our state. Idempotent: the event id is claimed in the same transaction that applies it. */
export async function applyBillingEvent(ev: any): Promise<'applied' | 'duplicate' | 'ignored'> {
  const o = ev.data.object;
  const c = await pool.getConnection();
  try {
    await c.beginTransaction();
    const findAgency = async (): Promise<number | null> => {
      const meta = o.metadata ?? o.subscription_details?.metadata ?? {};
      if (meta.agency_id) return Number(meta.agency_id);
      const subId = o.object === 'subscription' ? o.id : o.subscription, cust = o.customer;
      const [[r]]: any = await c.query('SELECT agency_id FROM subscriptions WHERE (stripe_subscription_id = ? AND ? IS NOT NULL) OR (stripe_customer_id = ? AND ? IS NOT NULL) LIMIT 1', [subId ?? null, subId ?? null, cust ?? null, cust ?? null]);
      return r?.agency_id ?? null;
    };
    const agencyId = await findAgency();
    if (!agencyId) { await c.rollback(); return 'ignored'; }
    if (!(await log(c, agencyId, ev.type, null, `stripe:${ev.id}`))) { await c.rollback(); return 'duplicate'; }
    const now = new Date();
    if (ev.type === 'checkout.session.completed' && o.mode === 'subscription') {
      const [[p]]: any = await c.query('SELECT id FROM plans WHERE code = ?', [o.metadata?.plan_code]);
      const iv = o.metadata?.interval === 'yearly' ? 'yearly' : 'monthly';
      await c.query(`UPDATE subscriptions SET plan_id = COALESCE(?, plan_id), billing_interval = ?, status = IF(platform_hold = 1, status, 'active'), stripe_customer_id = ?, stripe_subscription_id = ?, current_period_start = ?, current_period_end = ?,
        grace_until = NULL, cancel_at_period_end = 0, pending_plan_id = NULL, pending_interval = NULL, is_manual = 0 WHERE agency_id = ?`, [p?.id ?? null, iv, o.customer, o.subscription, sqlTime(now), sqlTime(addInterval(now, iv)), agencyId]);
    } else if (ev.type === 'customer.subscription.updated' || ev.type === 'customer.subscription.deleted') {
      const price = o.items?.data?.[0]?.price?.id, pl = await planByPrice(price);
      const st = ev.type === 'customer.subscription.deleted' ? 'cancelled' : ({ active: 'active', trialing: 'active', past_due: 'past_due', unpaid: 'suspended', canceled: 'cancelled', incomplete_expired: 'cancelled' } as any)[o.status];
      if (st) await c.query(`UPDATE subscriptions SET status = IF(platform_hold = 1, status, ?), current_period_start = COALESCE(?, current_period_start), current_period_end = COALESCE(?, current_period_end), cancel_at_period_end = ?,
        ${pl ? 'plan_id = ?, billing_interval = ?,' : ''} grace_until = CASE WHEN ? = 'past_due' THEN COALESCE(grace_until, ?) WHEN ? = 'active' THEN NULL ELSE grace_until END WHERE agency_id = ?`,
        [st, ts(o.current_period_start), ts(o.current_period_end), o.cancel_at_period_end ? 1 : 0, ...(pl ? [pl.id, pl.interval] : []), st, sqlTime(addDays(now, GRACE_DAYS)), st, agencyId]);
    } else if (ev.type === 'invoice.paid' || ev.type === 'invoice.payment_failed') {
      const paid = ev.type === 'invoice.paid';
      await c.query(`INSERT INTO subscription_invoices (agency_id, stripe_invoice_id, number, amount, currency, status, period_start, period_end, hosted_url, paid_at) VALUES (?,?,?,?,?,?,?,?,?,?)
        ON DUPLICATE KEY UPDATE status = VALUES(status), paid_at = VALUES(paid_at), hosted_url = VALUES(hosted_url)`,
        [agencyId, o.id, o.number ?? null, (o.amount_paid || o.amount_due || 0) / 100, String(o.currency ?? 'usd').toUpperCase(), paid ? 'paid' : 'failed', ts(o.period_start), ts(o.period_end), o.hosted_invoice_url ?? null, paid ? sqlTime(now) : null]);
      if (paid) await c.query(`UPDATE subscriptions SET status = 'active', grace_until = NULL WHERE agency_id = ? AND platform_hold = 0 AND status IN ('past_due','grace','suspended','trialing')`, [agencyId]);
      else await c.query(`UPDATE subscriptions SET status = 'past_due', grace_until = COALESCE(grace_until, ?) WHERE agency_id = ? AND status IN ('active','trialing')`, [sqlTime(addDays(now, GRACE_DAYS)), agencyId]);
    } else { await c.rollback(); return 'ignored'; }
    await c.commit(); return 'applied';
  } catch (e) { await c.rollback(); throw e; } finally { c.release(); }
}

async function adminsOf(agencyId: number) { const [r]: any = await pool.query(`SELECT u.email, u.name FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.agency_id = ? AND m.role = 'admin'`, [agencyId]); return r as { email: string; name: string }[]; }
async function notify(agencyId: number, key: string, kind: string, subject: string, body: string) {
  if (!(await log(pool, agencyId, kind, subject, key))) return false;     // once per key, however often the job runs
  const t = new Tenant(agencyId, { userId: null, ip: 'billing' });
  for (const a of await adminsOf(agencyId)) await deliver(t, { kind: 'billing', to: a.email, subject, html: `<p>Hi ${a.name.replace(/</g, '&lt;')},</p><p>${body}</p><p>Manage your subscription under <a href="${config.appUrl}/billing">Billing</a>.</p>` });
  return true;
}

/** Daily: trial expiry, dunning, suspension, scheduled cancellation and plan changes, reminders. Safe to re-run; `now` is injectable for tests. */
export async function runLifecycle(now = new Date(), onlyAgencyId?: number) {
  const out = { grace: 0, suspended: 0, cancelled: 0, plan_changes: 0, reminders: 0 }, nowS = sqlTime(now);
  const [subs]: any = await pool.query(`SELECT s.*, p.name plan_name FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.status <> 'cancelled' AND s.platform_hold = 0 ${onlyAgencyId ? 'AND s.agency_id = ?' : ''}`, onlyAgencyId ? [onlyAgencyId] : []);
  for (const s of subs) {
    const a = s.agency_id;
    if (s.status === 'trialing' && !s.stripe_subscription_id && s.trial_ends_at && String(s.trial_ends_at) <= nowS) {
      await pool.query(`UPDATE subscriptions SET status = 'grace', grace_until = ? WHERE id = ? AND status = 'trialing'`, [sqlTime(addDays(now, GRACE_DAYS)), s.id]); out.grace++;
      await notify(a, `trial_ended:${a}`, 'trial_ended', 'Your trial has ended', `Your free trial ended. Everything keeps working for ${GRACE_DAYS} more days — choose a plan to continue without interruption, otherwise your workspace becomes read-only.`);
      continue;
    }
    if (s.status === 'trialing' && s.trial_ends_at) {
      const left = Math.ceil((new Date(`${String(s.trial_ends_at).replace(' ', 'T')}Z`).getTime() - now.getTime()) / 86400_000);
      for (const d of TRIAL_REMINDER_DAYS) if (left <= d && left > 0 && await notify(a, `trial_reminder:${a}:${d}`, 'trial_reminder', `Your trial ends in ${left} day${left === 1 ? '' : 's'}`, `Your trial of ${s.plan_name} ends soon. Choose a plan to keep your workspace running.`)) { out.reminders++; break; }
    }
    if (['past_due', 'grace'].includes(s.status) && s.grace_until && String(s.grace_until) <= nowS) {
      await pool.query(`UPDATE subscriptions SET status = 'suspended' WHERE id = ? AND status IN ('past_due','grace')`, [s.id]); out.suspended++;
      await notify(a, `suspended:${a}:${String(s.grace_until).slice(0, 10)}`, 'suspended', 'Your workspace is now read-only', 'We could not collect payment, so your workspace is read-only. Your data is safe; update your payment details to restore full access.');
      continue;
    }
    if (s.status === 'past_due' && s.grace_until) await notify(a, `dunning:${a}:${String(s.grace_until).slice(0, 10)}`, 'payment_failed', 'Payment failed — please update your card', `We could not collect your subscription payment. Please update your payment details before ${String(s.grace_until).slice(0, 10)} to avoid your workspace becoming read-only.`);
    if (s.is_manual && s.status === 'active' && s.current_period_end && String(s.current_period_end) <= nowS) {   // offline-billed customers: no card on file, so expiry starts the grace period
      await pool.query(`UPDATE subscriptions SET status = 'grace', grace_until = ? WHERE id = ?`, [sqlTime(addDays(now, GRACE_DAYS)), s.id]); out.grace++; continue;
    }
    if (s.status === 'active' && s.current_period_end && String(s.current_period_end) <= nowS) {
      if (s.cancel_at_period_end) { await pool.query(`UPDATE subscriptions SET status = 'cancelled' WHERE id = ?`, [s.id]); out.cancelled++; await notify(a, `cancelled:${a}:${String(s.current_period_end).slice(0, 10)}`, 'cancelled', 'Your subscription has ended', 'Your subscription has ended. Your data remains available read-only; you can resubscribe at any time.'); continue; }
      if (s.pending_plan_id) {
        const [[np]]: any = await pool.query('SELECT * FROM plans WHERE id = ?', [s.pending_plan_id]), iv = s.pending_interval ?? s.billing_interval;
        if (s.stripe_subscription_id && gateway.enabled()) await gateway.changePlan(s.stripe_subscription_id, iv === 'yearly' ? np.stripe_price_yearly : np.stripe_price_monthly, false).catch((e) => { throw new Error(`plan change for agency ${a}: ${e.message}`); });
        await pool.query('UPDATE subscriptions SET plan_id = ?, billing_interval = ?, pending_plan_id = NULL, pending_interval = NULL WHERE id = ?', [np.id, iv, s.id]); out.plan_changes++;
        await log(pool, a, 'plan_changed', `${np.code} (scheduled)`);
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ agency actions */
async function planOrThrow(code: string) { const [[p]]: any = await pool.query('SELECT * FROM plans WHERE code = ? AND active = 1', [code]); if (!p) throw new HttpError(400, 'Unknown plan'); return p; }
const priceId = (p: any, iv: string) => (iv === 'yearly' ? p.stripe_price_yearly : p.stripe_price_monthly);

export async function startSubscribe(t: Tenant, planCode: string, interval: 'monthly' | 'yearly', email: string) {
  if (!gateway.enabled()) throw new HttpError(501, 'Online billing is not enabled on this installation. Contact support to arrange invoicing.');
  const p = await planOrThrow(planCode), s = await getSub(t.agencyId);
  if (s?.stripe_subscription_id && s.status === 'active') throw new HttpError(409, 'You already have an active subscription — use Change plan.');
  if (!priceId(p, interval)) throw new HttpError(501, `The ${p.name} ${interval} price is not configured in Stripe yet.`);
  await assertFits(t.agencyId, p);
  return gateway.checkout({ agencyId: t.agencyId, planCode, interval, priceId: priceId(p, interval), customer: s?.stripe_customer_id, email, successUrl: `${config.appUrl}/billing?subscribed=1`, cancelUrl: `${config.appUrl}/billing` });
}
export async function openPortal(t: Tenant) {
  const s = await getSub(t.agencyId); if (!s?.stripe_customer_id) throw new HttpError(409, 'No payment method on file yet — subscribe first.');
  return gateway.portal(s.stripe_customer_id, `${config.appUrl}/billing`);
}
/** A plan can be chosen only if current usage already fits it; we never delete data to make a downgrade work. */
async function assertFits(agencyId: number, p: any) {
  const u = await usage(agencyId), over: string[] = [];
  if (p.max_seats !== null && u.seats > p.max_seats) over.push(`${u.seats} team members (limit ${p.max_seats})`);
  if (p.max_branches !== null && u.branches > p.max_branches) over.push(`${u.branches} branches (limit ${p.max_branches})`);
  if (over.length) throw planErr(`${p.name} does not fit your current usage: reduce ${over.join(' and ')} first.`, { over });
}
export async function changePlan(t: Tenant, planCode: string, interval: 'monthly' | 'yearly') {
  const s = await getSub(t.agencyId); if (!s) throw new HttpError(404, 'No subscription');
  const p = await planOrThrow(planCode);
  if (FULL_ACCESS.includes(s.status) === false) throw new HttpError(409, 'Reactivate your subscription first.');
  const rank = (pl: { price_monthly: number }) => Number(pl.price_monthly), up = rank(p) > rank(s) || (rank(p) === rank(s) && interval === 'yearly' && s.billing_interval === 'monthly');
  if (p.code === s.plan_code && interval === s.billing_interval) throw new HttpError(409, 'You are already on that plan.');
  await assertFits(t.agencyId, p);
  const paying = s.stripe_subscription_id && s.status === 'active';
  if (!paying) {   // trial / offline-billed: switch immediately, nothing to charge
    await t.event('update', 'subscriptions', s.id, { plan: s.plan_code }, { plan: p.code }, 'plan change');
    await pool.query('UPDATE subscriptions SET plan_id = ?, billing_interval = ?, pending_plan_id = NULL, pending_interval = NULL WHERE agency_id = ?', [p.id, interval, t.agencyId]);
    await log(pool, t.agencyId, 'plan_changed', `${p.code} ${interval}`, undefined, t.actor.userId); return { applied: 'now' as const };
  }
  if (!gateway.enabled()) throw new HttpError(501, 'Online billing is not enabled.');
  if (!priceId(p, interval)) throw new HttpError(501, `The ${p.name} ${interval} price is not configured in Stripe yet.`);
  if (up) {   // upgrades are immediate and prorated by Stripe
    await gateway.changePlan(s.stripe_subscription_id, priceId(p, interval), true);
    await pool.query('UPDATE subscriptions SET plan_id = ?, billing_interval = ?, pending_plan_id = NULL, pending_interval = NULL WHERE agency_id = ?', [p.id, interval, t.agencyId]);
    await log(pool, t.agencyId, 'plan_changed', `${p.code} ${interval} (upgrade)`, undefined, t.actor.userId); return { applied: 'now' as const };
  }
  await pool.query('UPDATE subscriptions SET pending_plan_id = ?, pending_interval = ? WHERE agency_id = ?', [p.id, interval, t.agencyId]);   // downgrades wait for the renewal date
  await log(pool, t.agencyId, 'downgrade_scheduled', `${p.code} ${interval}`, undefined, t.actor.userId); return { applied: 'period_end' as const, at: s.current_period_end };
}
export async function cancelPending(t: Tenant) { await pool.query('UPDATE subscriptions SET pending_plan_id = NULL, pending_interval = NULL WHERE agency_id = ?', [t.agencyId]); }
export async function setCancelAtPeriodEnd(t: Tenant, cancel: boolean) {
  const s = await getSub(t.agencyId); if (!s) throw new HttpError(404, 'No subscription');
  if (!['active', 'past_due'].includes(s.status)) throw new HttpError(409, s.status === 'trialing' ? 'Your trial simply ends on its own — nothing to cancel.' : 'There is no active subscription to change.');
  if (s.stripe_subscription_id && gateway.enabled()) await gateway.setCancel(s.stripe_subscription_id, cancel);
  await pool.query('UPDATE subscriptions SET cancel_at_period_end = ? WHERE agency_id = ?', [cancel ? 1 : 0, t.agencyId]);
  await log(pool, t.agencyId, cancel ? 'cancel_requested' : 'cancel_withdrawn', null, undefined, t.actor.userId);
}
/** Offline-billed customers (bank transfer / contract): platform operator grants access until a date. */
export async function grantManual(agencyId: number, planCode: string, interval: 'monthly' | 'yearly', until: Date) {
  const p = await planOrThrow(planCode);
  await pool.query(`UPDATE subscriptions SET plan_id = ?, billing_interval = ?, status = 'active', is_manual = 1, current_period_start = UTC_TIMESTAMP(), current_period_end = ?, grace_until = NULL, cancel_at_period_end = 0, trial_ends_at = NULL WHERE agency_id = ?`, [p.id, interval, sqlTime(until), agencyId]);
  await log(pool, agencyId, 'manual_grant', `${planCode} until ${sqlTime(until)}`);
}

export function banner(s: any): { level: 'info' | 'warn' | 'danger'; message: string } | null {
  if (!s) return null; const d = (x: string) => String(x).slice(0, 10);
  if (s.platform_hold) return { level: 'danger', message: `This workspace has been suspended by the platform operator${s.hold_reason ? `: ${s.hold_reason}` : ''}. It is read-only — contact support.` };
  if (s.status === 'trialing') { const left = Math.ceil((new Date(`${String(s.trial_ends_at).replace(' ', 'T')}Z`).getTime() - Date.now()) / 86400_000); return { level: left <= 3 ? 'warn' : 'info', message: `Free trial: ${Math.max(0, left)} day${left === 1 ? '' : 's'} left on ${s.plan_name}.` }; }
  if (s.status === 'grace') return { level: 'warn', message: `Your trial has ended. Choose a plan by ${d(s.grace_until)} or the workspace becomes read-only.` };
  if (s.status === 'past_due') return { level: 'warn', message: `Payment failed. Update your payment details by ${d(s.grace_until)} to avoid suspension.` };
  if (s.status === 'suspended') return { level: 'danger', message: 'Workspace suspended for non-payment — it is read-only until payment is restored.' };
  if (s.status === 'cancelled') return { level: 'danger', message: 'Subscription cancelled — your data is read-only. Resubscribe to continue.' };
  if (s.cancel_at_period_end) return { level: 'info', message: `Your subscription ends on ${d(s.current_period_end)}.` };
  if (s.pending_plan_id) return { level: 'info', message: `A plan change takes effect on ${d(s.current_period_end)}.` };
  return null;
}
export const priceLabel = (p: any, iv: string) => fmt(iv === 'yearly' ? p.price_yearly : p.price_monthly, p.currency);
