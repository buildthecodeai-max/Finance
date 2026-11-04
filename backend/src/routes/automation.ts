import { requireFeature } from '../services/billing.js';
import { Router } from 'express';
import { z } from 'zod';
import { WRITERS, requireRole } from '../auth.js';
import { HttpError } from '../errors.js';
import { pool } from '../db.js';
import { signedUrl } from '../storage.js';
import { GENERATORS, PARAM_REPORTS } from './reports.js';
import * as A from '../services/automation.js';
import { today } from '../services/money.js';
import { idParam, parse, T } from './util.js';

export const automationRouter = Router();
automationRouter.use(requireRole('admin', 'finance_manager', 'viewer'));
const W = requireRole(...WRITERS);
automationRouter.use(['/rules', '/activity', '/run'], requireFeature('automation'));
automationRouter.use(['/schedules', '/report-runs'], requireFeature('scheduled_reports'));

/* ---- exception queue ---- */
automationRouter.get('/exceptions', async (req, res) => {
  const t = T(req), st = String(req.query.status ?? 'active');
  const where = st === 'all' ? '' : st === 'active' ? `AND (status IN ('open','acknowledged') OR (status = 'snoozed' AND snoozed_until <= CURDATE()))` : `AND status = ?`;
  const params = st === 'all' || st === 'active' ? [t.agencyId] : [t.agencyId, st];
  res.json(await t.query(`SELECT * FROM exceptions WHERE agency_id = ? ${where} ORDER BY FIELD(severity,'critical','warn','info'), last_seen DESC LIMIT 500`, params));
});
automationRouter.post('/exceptions/scan', W, async (req, res) => res.json(await A.scanExceptions(T(req))));
const Act = z.object({ days: z.number().int().min(1).max(90).optional(), note: z.string().max(300).optional() });
for (const action of ['acknowledge', 'snooze', 'reopen'] as const)
  automationRouter.post(`/exceptions/:id/${action}`, W, async (req, res) => { await A.setExceptionState(T(req), idParam(req), action, parse(Act, req.body)); res.json({ ok: true }); });

/* ---- rules ---- */
const Rule = z.object({ name: z.string().trim().min(2).max(120), trigger_kind: z.enum(['invoice_overdue', 'quote_expiring', 'departure_upcoming', 'bill_due']), days: z.number().int().min(0).max(365),
  action: z.enum(['create_task', 'email_client']), task_priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'), message: z.string().max(500).nullish(), active: z.boolean().default(true) });
automationRouter.get('/rules', async (req, res) => { const t = T(req); res.json(await t.query(`SELECT r.*, (SELECT COUNT(*) FROM automation_runs x WHERE x.agency_id = r.agency_id AND x.rule_id = r.id AND x.status = 'done') done,
  (SELECT COUNT(*) FROM automation_runs x WHERE x.agency_id = r.agency_id AND x.rule_id = r.id AND x.status = 'failed') failed FROM automation_rules r WHERE r.agency_id = ? ORDER BY r.id DESC`, [t.agencyId])); });
automationRouter.post('/rules', W, async (req, res) => { const b = parse(Rule, req.body); A.validateRule(b); res.status(201).json({ id: await T(req).insert('automation_rules', { ...b, active: b.active ? 1 : 0, created_by: req.ctx!.userId }) }); });
automationRouter.put('/rules/:id', W, async (req, res) => {
  const t = T(req), id = idParam(req), cur = await t.get('automation_rules', id); if (!cur) throw new HttpError(404, 'Rule not found');
  const b = parse(Rule.partial(), req.body), merged = { ...cur, ...b }; A.validateRule(merged);
  await t.update('automation_rules', id, { ...b, ...(b.active !== undefined ? { active: b.active ? 1 : 0 } : {}) }); res.json({ ok: true });
});
automationRouter.delete('/rules/:id', W, async (req, res) => { const t = T(req), id = idParam(req); if (!(await t.get('automation_rules', id))) throw new HttpError(404, 'Rule not found'); await t.remove('automation_rules', id); res.json({ ok: true }); });
automationRouter.get('/activity', async (req, res) => { const t = T(req); res.json(await t.query(`SELECT x.*, r.name rule_name FROM automation_runs x JOIN automation_rules r ON r.id = x.rule_id AND r.agency_id = x.agency_id WHERE x.agency_id = ? ORDER BY x.updated_at DESC, x.id DESC LIMIT 200`, [t.agencyId])); });
automationRouter.post('/run', W, async (req, res) => { const t = T(req); res.json({ automations: await A.runAutomations(t), exceptions: await A.scanExceptions(t), schedules: await A.runDueSchedules(t) }); });

/* ---- scheduled reports ---- */
const Sched = z.object({ name: z.string().trim().min(2).max(120), report: z.string().refine((r) => r in GENERATORS && !PARAM_REPORTS.has(r), 'Unknown report'), range_kind: z.enum(['last_30d', 'mtd', 'last_month', 'ytd']).default('last_month'),
  frequency: z.enum(['daily', 'weekly', 'monthly']), weekday: z.number().int().min(0).max(6).optional(), day_of_month: z.number().int().min(1).max(28).optional(),
  recipients: z.array(z.string().email()).min(1).max(5), format: z.enum(['csv', 'xlsx', 'pdf']).default('csv'), active: z.boolean().default(true) });
/** Financial reports go only to people on the team — never to arbitrary outside addresses. */
async function assertTeam(agencyId: number, emails: string[]) {
  const [rows]: any = await pool.query('SELECT LOWER(u.email) e FROM users u JOIN memberships m ON m.user_id = u.id WHERE m.agency_id = ?', [agencyId]);
  const ok = new Set(rows.map((r: any) => r.e)); const bad = emails.filter((e) => !ok.has(e.toLowerCase()));
  if (bad.length) throw new HttpError(400, `Scheduled reports can only be sent to members of your team (not: ${bad.join(', ')})`);
}
automationRouter.get('/schedules', async (req, res) => { const t = T(req); res.json(await t.query(`SELECT s.*, (SELECT COUNT(*) FROM report_runs r WHERE r.agency_id = s.agency_id AND r.schedule_id = s.id AND r.status = 'failed') failures FROM report_schedules s WHERE s.agency_id = ? ORDER BY s.id DESC`, [t.agencyId])); });
automationRouter.post('/schedules', W, async (req, res) => {
  const b = parse(Sched, req.body), t = T(req); await assertTeam(t.agencyId, b.recipients);
  if (b.frequency === 'weekly' && b.weekday === undefined) throw new HttpError(400, 'Choose a weekday');
  if (b.frequency === 'monthly' && !b.day_of_month) throw new HttpError(400, 'Choose a day of the month');
  const { recipients, active, ...rest } = b;
  res.status(201).json({ id: await t.insert('report_schedules', { ...rest, recipients: recipients.join(','), active: active ? 1 : 0, next_run_at: A.nextRun(b, today()), created_by: req.ctx!.userId }) });
});
automationRouter.put('/schedules/:id', W, async (req, res) => {
  const t = T(req), id = idParam(req), cur = await t.get('report_schedules', id); if (!cur) throw new HttpError(404, 'Schedule not found');
  const b = parse(z.object({ active: z.boolean().optional(), recipients: z.array(z.string().email()).min(1).max(5).optional() }), req.body);
  if (b.recipients) await assertTeam(t.agencyId, b.recipients);
  await t.update('report_schedules', id, { ...(b.active !== undefined ? { active: b.active ? 1 : 0 } : {}), ...(b.recipients ? { recipients: b.recipients.join(',') } : {}) }); res.json({ ok: true });
});
automationRouter.delete('/schedules/:id', W, async (req, res) => { const t = T(req), id = idParam(req); if (!(await t.get('report_schedules', id))) throw new HttpError(404, 'Schedule not found'); await t.remove('report_schedules', id); res.json({ ok: true }); });
automationRouter.post('/schedules/:id/run', W, async (req, res) => {
  const t = T(req), id = idParam(req), s = await t.get('report_schedules', id); if (!s) throw new HttpError(404, 'Schedule not found');
  res.json(await A.executeSchedule(t, s, `manual-${Date.now()}`));
});
automationRouter.get('/schedules/:id/runs', async (req, res) => { const t = T(req); res.json(await t.query('SELECT * FROM report_runs WHERE agency_id = ? AND schedule_id = ? ORDER BY id DESC LIMIT 50', [t.agencyId, idParam(req)])); });
automationRouter.get('/report-runs/:id/download', async (req, res) => {
  const t = T(req), r = await t.get('report_runs', idParam(req)); if (!r?.file_key) throw new HttpError(404, 'No file for this run');
  res.json({ url: await signedUrl(t.agencyId, r.file_key, String(r.file_key).split('/').pop()!) });
});
