import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { pool } from '../db.js';
import { config } from '../config.js';
import { health } from '../services/observability.js';
import * as P from '../services/platform.js';
import { idParam, parse } from './util.js';

/** Operator console API. Not tenant-scoped: no X-Agency-Id, separate auth, everything audited. */
export const platformRouter = Router();
platformRouter.use(rateLimit({ windowMs: 60_000, limit: process.env.NODE_ENV === 'test' ? 5000 : 120 }), P.platformAuth);
const Interval = z.enum(['monthly', 'yearly']), Reason = z.object({ reason: z.string() });

platformRouter.get('/me', (req, res) => res.json({ ok: true, email: req.platform!.email, role: req.platform!.role, caps: req.platform!.caps }));
platformRouter.post('/step-up', async (req, res) => res.json(await P.performStepUp(req, parse(z.object({ code: z.string().min(6).max(8) }), req.body).code)));
platformRouter.get('/operators', P.needs('suspend'), async (_req, res) => res.json(await P.listOperators()));
platformRouter.get('/overview', async (_req, res) => res.json(await P.overview()));
platformRouter.get('/system', async (_req, res) => { const [hb]: any = await pool.query("SELECT k, v, updated_at FROM system_state WHERE k LIKE 'hb:%'"); res.json({ health: await health(), heartbeats: hb }); });

platformRouter.get('/agencies', async (req, res) => res.json(await P.listAgencies(parse(z.object({ q: z.string().max(100).optional(), status: z.string().max(20).optional(), plan: z.string().max(30).optional(), page: z.coerce.number().int().min(1).optional() }), req.query))));
platformRouter.get('/agencies/:id', async (req, res) => { const id = idParam(req), d = await P.agencyDetail(id); await P.audit(req, 'view_agency', id); res.json(d); });   // viewing member emails is itself audited
platformRouter.post('/agencies/:id/extend-trial', P.needs('billing'), async (req, res) => { const b = parse(Reason.extend({ days: z.number().int().min(1).max(60) }), req.body); res.json(await P.extendTrial(req, idParam(req), b.days, b.reason)); });
platformRouter.post('/agencies/:id/set-plan', P.needs('billing'), P.stepUp, async (req, res) => { const b = parse(Reason.extend({ plan: z.string(), interval: Interval.default('monthly') }), req.body); await P.setPlan(req, idParam(req), b.plan, b.interval, b.reason); res.json({ ok: true }); });
platformRouter.post('/agencies/:id/grant', P.needs('billing'), P.stepUp, async (req, res) => { const b = parse(Reason.extend({ plan: z.string(), interval: Interval.default('yearly'), until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }), req.body); await P.grant(req, idParam(req), b.plan, b.interval, b.until, b.reason); res.json({ ok: true }); });
platformRouter.post('/agencies/:id/suspend', P.needs('suspend'), P.stepUp, async (req, res) => {
  const reason = parse(Reason, req.body).reason, id = idParam(req);
  if (!config.platformTwoPerson) { await P.suspend(req, id, reason); return void res.json({ ok: true, status: 'suspended' }); }
  res.status(202).json(await P.requestSuspend(req, id, reason));   // pending until a second admin approves
});
platformRouter.get('/approvals', P.needs('suspend'), async (req, res) => res.json(await P.listApprovals(typeof req.query.status === 'string' ? req.query.status : undefined)));
platformRouter.post('/approvals/:id/approve', P.needs('suspend'), P.stepUp, async (req, res) => { await P.approveSuspend(req, idParam(req), parse(z.object({ note: z.string().max(300).optional() }), req.body).note); res.json({ ok: true, status: 'suspended' }); });
platformRouter.post('/approvals/:id/reject', P.needs('suspend'), async (req, res) => { await P.rejectSuspend(req, idParam(req), parse(Reason, req.body).reason); res.json({ ok: true }); });
platformRouter.post('/approvals/:id/cancel', P.needs('suspend'), async (req, res) => { await P.cancelSuspend(req, idParam(req)); res.json({ ok: true }); });
platformRouter.post('/agencies/:id/reactivate', P.needs('suspend'), P.stepUp, async (req, res) => { await P.reactivate(req, idParam(req), parse(Reason, req.body).reason); res.json({ ok: true }); });
platformRouter.post('/agencies/:id/support-session', P.needs('support'), P.stepUp, async (req, res) => { const b = parse(Reason.extend({ minutes: z.number().int().min(5).max(60).default(30) }), req.body); res.status(201).json(await P.startSupportSession(req, idParam(req), b.reason, b.minutes)); });
platformRouter.post('/support-sessions/:id/revoke', P.needs('support'), async (req, res) => { await P.revokeSupportSession(req, idParam(req), parse(Reason, req.body).reason); res.json({ ok: true }); });

const Plan = z.object({ code: z.string().optional(), name: z.string().min(2).max(60), description: z.string().max(200).nullish(), price_monthly: z.number().min(0).max(100000), price_yearly: z.number().min(0).max(1000000), currency: z.string().length(3).optional(), trial_days: z.number().int().min(0).max(90),
  max_seats: z.number().int().min(1).nullable(), max_branches: z.number().int().min(1).nullable(), max_bookings_month: z.number().int().min(1).nullable(), features: z.array(z.string()), support_level: z.string().min(2).max(30), stripe_price_monthly: z.string().max(80).nullish(), stripe_price_yearly: z.string().max(80).nullish(), active: z.boolean(), sort: z.number().int() });
platformRouter.get('/plans', async (_req, res) => res.json(await P.listPlans()));
platformRouter.post('/plans', P.needs('billing'), P.stepUp, async (req, res) => res.status(201).json({ id: await P.createPlan(req, parse(Plan, req.body) as P.PlanIn) }));
platformRouter.put('/plans/:id', P.needs('billing'), P.stepUp, async (req, res) => { const b = parse(Plan.extend({ reason: z.string() }), req.body); const { reason, ...plan } = b; res.json(await P.updatePlan(req, idParam(req), plan as P.PlanIn, reason)); });

platformRouter.get('/audit', async (_req, res) => res.json((await pool.query(`SELECT a.id, a.action, a.agency_id, ag.name agency_name, a.detail, a.reason, a.ip, a.created_at, u.email admin_email FROM platform_audit_log a JOIN users u ON u.id = a.admin_user_id LEFT JOIN agencies ag ON ag.id = a.agency_id ORDER BY a.id DESC LIMIT 300`))[0]));
platformRouter.get('/security-events', async (_req, res) => res.json((await pool.query(`SELECT e.id, e.agency_id, ag.name agency_name, e.event, e.detail, e.ip, e.created_at FROM security_events e LEFT JOIN agencies ag ON ag.id = e.agency_id ORDER BY e.id DESC LIMIT 300`))[0]));
