import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db.js';
import { requireRole } from '../auth.js';
import * as B from '../services/billing.js';
import * as L from '../services/localPay.js';
import { parse, T } from './util.js';

/** Billing for the agency's own subscription. Everyone can see status; only admins change it. Works even when the workspace is suspended. */
export const billingRouter = Router();
const ADMIN = requireRole('admin');
const Choice = z.object({ plan: z.string().min(2).max(30), interval: z.enum(['monthly', 'yearly']).default('monthly') });

billingRouter.get('/plans', async (_req, res) => {
  const [rows]: any = await pool.query('SELECT code, name, description, price_monthly, price_yearly, price_monthly_pkr, price_yearly_pkr, currency, trial_days, max_seats, max_branches, max_bookings_month, features, support_level FROM plans WHERE active = 1 ORDER BY sort');
  res.json(rows.map((p: any) => ({ ...p, features: String(p.features).split(',').filter(Boolean) })));
});

billingRouter.get('/subscription', async (req, res) => {
  const a = req.ctx!.agencyId, s = await B.getSub(a);
  if (!s) return void res.json({ subscription: null });
  const [pending]: any = s.pending_plan_id ? (await pool.query('SELECT code, name FROM plans WHERE id = ?', [s.pending_plan_id]))[0] : [null];
  res.json({
    subscription: { status: s.status, plan: { code: s.plan_code, name: s.plan_name, support_level: s.support_level }, interval: s.billing_interval, trial_ends_at: s.trial_ends_at, current_period_end: s.current_period_end, grace_until: s.grace_until,
      cancel_at_period_end: !!s.cancel_at_period_end, pending_plan: pending ?? null, pending_interval: s.pending_interval, manual: !!s.is_manual, has_payment_method: !!s.stripe_customer_id },
    limits: { seats: s.max_seats, branches: s.max_branches, bookings: s.max_bookings_month }, features: String(s.features).split(',').filter(Boolean),
    allowed_modules: s.allowed_modules ? String(s.allowed_modules).split(',').filter(Boolean) : null,
    usage: await B.usage(a), banner: B.banner(s), read_only: !B.FULL_ACCESS.includes(s.status), online_billing: B.gateway.enabled(), local_pay: await L.options(),
  });
});

billingRouter.post('/subscribe', ADMIN, async (req, res) => { const b = parse(Choice, req.body); const [[u]]: any = await pool.query('SELECT email FROM users WHERE id = ?', [req.ctx!.userId]); res.json({ url: await B.startSubscribe(T(req), b.plan, b.interval, u.email) }); });
// Pay for a plan period with JazzCash or Easypaisa (rupees). Returns where to send the browser; the plan only extends once the gateway's answer is verified.
billingRouter.post('/local/start', ADMIN, async (req, res) => {
  const b = parse(Choice.extend({ provider: z.enum(['jazzcash', 'easypaisa']) }), req.body); const [[u]]: any = await pool.query('SELECT email FROM users WHERE id = ?', [req.ctx!.userId]);
  res.json(await L.start({ agencyId: req.ctx!.agencyId, userId: req.ctx!.userId, email: u?.email ?? '', plan: b.plan, interval: b.interval, provider: b.provider }));
});
billingRouter.get('/local/payments', requireRole('admin', 'finance_manager'), async (req, res) => res.json(await L.listForAgency(req.ctx!.agencyId)));
billingRouter.post('/portal', ADMIN, async (req, res) => res.json({ url: await B.openPortal(T(req)) }));
billingRouter.post('/change-plan', ADMIN, async (req, res) => { const b = parse(Choice, req.body); res.json(await B.changePlan(T(req), b.plan, b.interval)); });
billingRouter.post('/cancel-pending-change', ADMIN, async (req, res) => { await B.cancelPending(T(req)); res.json({ ok: true }); });
billingRouter.post('/cancel', ADMIN, async (req, res) => { await B.setCancelAtPeriodEnd(T(req), true); res.json({ ok: true }); });
billingRouter.post('/resume', ADMIN, async (req, res) => { await B.setCancelAtPeriodEnd(T(req), false); res.json({ ok: true }); });
billingRouter.get('/invoices', requireRole('admin', 'finance_manager'), async (req, res) => res.json((await pool.query('SELECT id, number, amount, currency, status, period_start, period_end, hosted_url, paid_at, created_at FROM subscription_invoices WHERE agency_id = ? ORDER BY id DESC LIMIT 100', [req.ctx!.agencyId]))[0]));
billingRouter.get('/events', ADMIN, async (req, res) => res.json((await pool.query('SELECT kind, detail, created_at FROM billing_events WHERE agency_id = ? ORDER BY id DESC LIMIT 100', [req.ctx!.agencyId]))[0]));
