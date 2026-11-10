import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { pool } from '../db.js';
import { config } from '../config.js';
import { HttpError } from '../errors.js';
import { signAccess } from '../auth.js';
import { health } from '../services/observability.js';
import * as P from '../services/platform.js';
import { idParam, parse } from './util.js';

/** Operator console API. Not tenant-scoped: no X-Agency-Id, separate auth, everything audited. */
export const platformRouter = Router();
platformRouter.use(rateLimit({ windowMs: 60_000, limit: process.env.NODE_ENV === 'test' ? 5000 : 120 }), P.platformAuth);
const Interval = z.enum(['monthly', 'yearly']), Reason = z.object({ reason: z.string().optional().default('') });

platformRouter.get('/me', (req, res) => res.json({ ok: true, email: req.platform!.email, role: req.platform!.role, caps: req.platform!.caps }));
platformRouter.get('/operators', P.needs('suspend'), async (_req, res) => res.json(await P.listOperators()));
platformRouter.post('/operators', P.needs('suspend'), async (req, res) => { const b = parse(Reason.extend({ email: z.string().email(), role: z.enum(['readonly', 'support', 'billing', 'admin']) }), req.body); res.status(201).json(await P.addOperator(req, b.email, b.role, b.reason)); });
platformRouter.put('/operators/:id', P.needs('suspend'), async (req, res) => { const b = parse(Reason.extend({ role: z.enum(['readonly', 'support', 'billing', 'admin']) }), req.body); res.json(await P.setOperatorRole(req, idParam(req), b.role, b.reason)); });
platformRouter.delete('/operators/:id', P.needs('suspend'), async (req, res) => { const b = parse(Reason, req.body ?? {}); res.json(await P.setOperatorRole(req, idParam(req), null, b.reason)); });
// ---- user directory: every account on the platform. Reading needs 'support'; changing needs 'suspend'; every read of a person's detail and every change is audited.
const Why = z.object({ reason: z.string().trim().min(3, 'Say why you are doing this.').max(300) });
const UId = (req: any) => { const n = Number(req.params.id); if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'Bad user id'); return n; };
platformRouter.get('/agency-roles', P.needs('support'), async (_req, res) => res.json(await P.agencyRoleCounts()));
platformRouter.get('/users', P.needs('support'), async (req, res) => res.json(await P.listUsers(parse(z.object({ q: z.string().max(100).optional(), filter: z.enum(P.USER_FILTERS).optional(), page: z.coerce.number().int().min(1).optional() }), req.query))));
platformRouter.get('/users/:id', P.needs('support'), async (req, res) => { const d = await P.userDetail(UId(req)); await P.audit(req, 'view_user', null, d.user.email); res.json(d); });
platformRouter.post('/users/:id/reset-2fa', P.needs('suspend'), async (req, res) => res.json(await P.resetUserTwoFactor(req, UId(req), parse(Why, req.body).reason)));
platformRouter.post('/users/:id/sign-out', P.needs('suspend'), async (req, res) => res.json(await P.signOutUserEverywhere(req, UId(req), parse(Why, req.body).reason)));
platformRouter.post('/users/:id/disable', P.needs('suspend'), async (req, res) => res.json(await P.setUserDisabled(req, UId(req), true, parse(Why, req.body).reason)));
platformRouter.post('/users/:id/enable', P.needs('suspend'), async (req, res) => res.json(await P.setUserDisabled(req, UId(req), false, parse(Why, req.body).reason)));
platformRouter.post('/users/:id/set-password', P.needs('suspend'), async (req, res) => { const b = parse(Why.extend({ password: z.string().min(10, 'Use at least 10 characters.').max(200) }), req.body); res.json(await P.setUserPasswordByOperator(req, UId(req), b.password, b.reason)); });
platformRouter.post('/users/:id/password-reset', P.needs('suspend'), async (req, res) => res.json(await P.sendUserPasswordReset(req, UId(req), parse(Why, req.body).reason)));
const UserId = (req: any) => { const n = Number(req.params.userId); if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'Bad user id'); return n; };
platformRouter.put('/agencies/:id/users/:userId', P.needs('suspend'), async (req, res) => { const b = parse(Reason.extend({ name: z.string().trim().min(1).max(100).optional(), email: z.string().email().optional(), role: z.enum(['admin', 'finance_manager', 'agent', 'viewer']).optional() }), req.body); const { reason, ...patch } = b; await P.editAgencyUser(req, idParam(req), UserId(req), patch, reason); res.json({ ok: true }); });
platformRouter.get('/agencies/:id/users/:userId/workload', P.needs('suspend'), async (req, res) => res.json(await P.agencyUserWorkload(idParam(req), UserId(req))));
platformRouter.delete('/agencies/:id/users/:userId', P.needs('suspend'), async (req, res) => { const b = parse(Reason.extend({ reassign_to: z.number().int().nullish(), delete_account: z.boolean().optional() }), req.body ?? {}); res.json({ ok: true, ...(await P.removeAgencyUser(req, idParam(req), UserId(req), { reassignTo: b.reassign_to, deleteAccount: b.delete_account, reason: b.reason })) }); });
platformRouter.get('/overview', async (_req, res) => res.json(await P.overview()));
// ---- the AI provider key. Reading says whether one is set (never the key); changing needs an admin operator and a reason.
platformRouter.get('/settings/ai', P.needs('read'), async (_req, res) => res.json(await P.aiKeyInfo()));
platformRouter.put('/settings/ai', P.needs('suspend'), async (req, res) => { const b = parse(Why.extend({ api_key: z.string().trim().min(20).max(400) }), req.body); res.json(await P.setAiKey(req, b.api_key, b.reason)); });
platformRouter.delete('/settings/ai', P.needs('suspend'), async (req, res) => res.json(await P.removeAiKey(req, parse(Why, req.body ?? {}).reason)));
platformRouter.get('/system', async (_req, res) => { const [hb]: any = await pool.query("SELECT k, v, updated_at FROM system_state WHERE k LIKE 'hb:%'"); res.json({ ...(await P.systemStatus()), heartbeats: hb }); });

platformRouter.get('/agencies', async (req, res) => res.json(await P.listAgencies(parse(z.object({ q: z.string().max(100).optional(), status: z.string().max(20).optional(), plan: z.string().max(30).optional(), page: z.coerce.number().int().min(1).optional() }), req.query))));
platformRouter.get('/agencies/:id', async (req, res) => { const id = idParam(req), d = await P.agencyDetail(id); await P.audit(req, 'view_agency', id); res.json(d); });   // viewing member emails is itself audited
platformRouter.put('/agencies/:id', P.needs('billing'), async (req, res) => {
  const id = idParam(req);
  const b = parse(z.object({ name: z.string().min(2).max(120), base_currency: z.string().length(3), tax_label: z.string().min(1).max(10), timezone: z.string().max(50).optional() }), req.body);
  const [[before]]: any = await pool.query('SELECT name, base_currency, tax_label, timezone FROM agencies WHERE id=?', [id]);
  if (!before) throw new HttpError(404, 'Agency not found');
  await pool.query('UPDATE agencies SET name=?, base_currency=?, tax_label=?, timezone=COALESCE(?,timezone) WHERE id=?', [b.name, b.base_currency.toUpperCase(), b.tax_label, b.timezone ?? null, id]);
  const [[after]]: any = await pool.query('SELECT name, base_currency, tax_label, timezone FROM agencies WHERE id=?', [id]);
  await P.audit(req, 'edit_agency', id, `name="${b.name}" currency=${b.base_currency}`, null, { before, after });
  res.json({ ok: true });
});
platformRouter.delete('/agencies/:id', P.needs('suspend'), async (req, res) => {
  const id = idParam(req);
  const b = parse(Reason, req.body ?? {});
  const r = await P.deleteAgency(id);
  await P.audit(req, 'delete_agency', id, `deleted "${r.name}": ${r.rows} rows in ${r.tables} tables, ${r.users} users removed`, b.reason, { before: { name: r.name }, after: { deleted: true, rows: r.rows, tables: r.tables, users: r.users } });
  res.json({ ok: true });
});
platformRouter.put('/agencies/:id/ai', P.needs('billing'), async (req, res) => {
  const id = idParam(req), b = parse(Reason.extend({ reason: z.string().trim().min(3, 'Say why you are changing this.'), access: z.enum(['plan', 'on', 'off']), monthly_limit: z.number().int().min(0).max(1_000_000).nullable() }), req.body);
  const [[before]]: any = await pool.query('SELECT ai_access, ai_monthly_limit FROM agencies WHERE id=?', [id]);
  if (!before) throw new HttpError(404, 'Agency not found');
  await pool.query('UPDATE agencies SET ai_access=?, ai_monthly_limit=? WHERE id=?', [b.access, b.monthly_limit, id]);
  await P.audit(req, 'set_ai_access', id, `access=${b.access} monthly_limit=${b.monthly_limit ?? 'default'}`, b.reason, { before, after: { ai_access: b.access, ai_monthly_limit: b.monthly_limit } });
  res.json({ ok: true });
});
platformRouter.post('/agencies/:id/extend-trial', P.needs('billing'), async (req, res) => { const b = parse(Reason.extend({ days: z.number().int().min(1).max(60) }), req.body); res.json(await P.extendTrial(req, idParam(req), b.days, b.reason)); });
platformRouter.post('/agencies/:id/set-plan', P.needs('billing'), async (req, res) => { const b = parse(Reason.extend({ plan: z.string(), interval: Interval.default('monthly') }), req.body); await P.setPlan(req, idParam(req), b.plan, b.interval, b.reason); res.json({ ok: true }); });
platformRouter.post('/agencies/:id/grant', P.needs('billing'), async (req, res) => { const b = parse(Reason.extend({ plan: z.string(), interval: Interval.default('yearly'), until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }), req.body); await P.grant(req, idParam(req), b.plan, b.interval, b.until, b.reason); res.json({ ok: true }); });
platformRouter.post('/agencies/:id/suspend', P.needs('suspend'), async (req, res) => {
  const reason = parse(Reason, req.body).reason, id = idParam(req);
  if (!config.platformTwoPerson) { await P.suspend(req, id, reason); return void res.json({ ok: true, status: 'suspended' }); }
  res.status(202).json(await P.requestSuspend(req, id, reason));   // pending until a second admin approves
});
platformRouter.get('/approvals', P.needs('suspend'), async (req, res) => res.json(await P.listApprovals(typeof req.query.status === 'string' ? req.query.status : undefined)));
platformRouter.post('/approvals/:id/approve', P.needs('suspend'), async (req, res) => { await P.approveSuspend(req, idParam(req), parse(z.object({ note: z.string().max(300).optional() }), req.body).note); res.json({ ok: true, status: 'suspended' }); });
platformRouter.post('/approvals/:id/reject', P.needs('suspend'), async (req, res) => { await P.rejectSuspend(req, idParam(req), parse(Reason, req.body).reason); res.json({ ok: true }); });
platformRouter.post('/approvals/:id/cancel', P.needs('suspend'), async (req, res) => { await P.cancelSuspend(req, idParam(req)); res.json({ ok: true }); });
platformRouter.post('/agencies/:id/reactivate', P.needs('suspend'), async (req, res) => { await P.reactivate(req, idParam(req), parse(Reason, req.body).reason); res.json({ ok: true }); });
platformRouter.post('/agencies/:id/support-session', P.needs('support'), async (req, res) => { const b = parse(Reason.extend({ minutes: z.number().int().min(5).max(60).default(30) }), req.body); res.status(201).json(await P.startSupportSession(req, idParam(req), b.reason, b.minutes)); });
platformRouter.post('/support-sessions/:id/revoke', P.needs('support'), async (req, res) => { await P.revokeSupportSession(req, idParam(req), parse(Reason, req.body).reason); res.json({ ok: true }); });
platformRouter.post('/agencies/:id/access-workspace', P.needs('support'), async (req, res) => {
  const id = idParam(req);
  const [[admin]]: any = await pool.query(
    `SELECT u.id, u.name, u.email FROM users u JOIN memberships m ON m.user_id = u.id WHERE m.agency_id = ? AND m.role = 'admin' ORDER BY u.id LIMIT 1`,
    [id]
  );
  if (!admin) throw new HttpError(404, 'No admin member found for this agency');
  const [[agency]]: any = await pool.query('SELECT id, name, base_currency, tax_label FROM agencies WHERE id = ?', [id]);
  const b = parse(Reason, req.body);
  const accessToken = signAccess(admin.id);
  await P.audit(req, 'workspace_access', id, `entered workspace as ${admin.email}`, b.reason);
  res.json({ accessToken, user: { id: admin.id, name: admin.name, email: admin.email }, agency });
});

const Plan = z.object({ code: z.string().optional(), name: z.string().min(2).max(60), description: z.string().max(200).nullish(), price_monthly: z.number().min(0).max(100000), price_yearly: z.number().min(0).max(1000000), currency: z.string().length(3).optional(), trial_days: z.number().int().min(0).max(90),
  max_seats: z.number().int().min(1).nullable(), max_branches: z.number().int().min(1).nullable(), max_bookings_month: z.number().int().min(1).nullable(), features: z.array(z.string()), allowed_modules: z.array(z.string()).nullable().default(null), support_level: z.string().min(2).max(30), stripe_price_monthly: z.string().max(80).nullish(), stripe_price_yearly: z.string().max(80).nullish(), active: z.boolean(), sort: z.number().int() });

const NewAgency = z.object({ agencyName: z.string().min(2).max(120), adminName: z.string().min(2).max(80), adminEmail: z.string().email(), adminPassword: z.string().min(10).max(100), planCode: z.string().min(2).max(30).default('growth'), baseCurrency: z.string().length(3).default('USD') });
platformRouter.post('/agencies', P.needs('billing'), async (req, res) => { const b = parse(NewAgency, req.body); res.status(201).json(await P.createAgency(req, b)); });
platformRouter.get('/plans', async (_req, res) => res.json(await P.listPlans()));
platformRouter.post('/plans', P.needs('billing'), async (req, res) => res.status(201).json({ id: await P.createPlan(req, parse(Plan, req.body) as P.PlanIn) }));
platformRouter.put('/plans/:id', P.needs('billing'), async (req, res) => { const b = parse(Plan.extend({ reason: z.string().optional().default('') }), req.body); const { reason, ...plan } = b; res.json(await P.updatePlan(req, idParam(req), plan as P.PlanIn, reason)); });

platformRouter.get('/audit', async (req, res) => res.json(await P.listAudit(parse(z.object({ q: z.string().max(100).optional(), category: z.string().max(20).optional(), operator: z.string().max(255).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), page: z.coerce.number().int().min(1).optional(), size: z.coerce.number().int().min(1).max(1000).optional() }), req.query))));
platformRouter.get('/security-events', async (req, res) => res.json(await P.listSecurityEvents(parse(z.object({ q: z.string().max(100).optional(), category: z.string().max(20).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), page: z.coerce.number().int().min(1).optional(), size: z.coerce.number().int().min(1).max(1000).optional() }), req.query))));
