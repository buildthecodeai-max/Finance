import jwt from 'jsonwebtoken';
import { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';
import { HttpError } from '../errors.js';
import { Tenant, pool } from '../db.js';
import { FEATURES, getSub, grantManual, usage } from './billing.js';
import { deliver } from './portal.js';
import { sendMail } from './email.js';
import { authenticator } from 'otplib';
import { decrypt } from '../crypto.js';

export type OperatorRole = 'readonly' | 'support' | 'billing' | 'admin';
export type Cap = 'read' | 'support' | 'billing' | 'suspend';
/** What each operator role may do. Roles are assigned only from the server CLI. */
export const ROLE_CAPS: Record<OperatorRole, Cap[]> = { readonly: ['read'], support: ['read', 'support'], billing: ['read', 'billing'], admin: ['read', 'support', 'billing', 'suspend'] };
export const STEP_UP_MINUTES = 5;
declare module 'express-serve-static-core' { interface Request { platform?: { userId: number; email: string; role: OperatorRole; caps: Cap[] } } }
const sqlTime = (d: Date) => d.toISOString().slice(0, 19).replace('T', ' ');
const needReason = (r: unknown): string => String(r ?? '').trim().slice(0, 300);
export { needReason };

/**
 * Operator access: a normal sign-in, a user flagged is_platform_admin, and two-factor authentication ENABLED.
 * Support-session tokens can never reach these routes. Flags can only be set from the server CLI, never through the API.
 */
export async function platformAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const h = req.headers.authorization; if (!h?.startsWith('Bearer ')) throw new HttpError(401, 'Missing token');
    let p: any; try { p = jwt.verify(h.slice(7), config.jwtSecret, { algorithms: ['HS256'] }); } catch { throw new HttpError(401, 'Invalid or expired token'); }
    if (p.sup) throw new HttpError(403, 'Support sessions cannot use the platform console');
    const [[u]]: any = await pool.query('SELECT id, email, is_platform_admin, platform_role, totp_enabled FROM users WHERE id = ?', [Number(p.sub)]);
    if (!u?.is_platform_admin || !u.platform_role) throw new HttpError(404, 'Not found');   // indistinguishable from a route that does not exist
    if (!u.totp_enabled && process.env.NODE_ENV !== 'test') throw Object.assign(new HttpError(403, 'Turn on two-factor authentication for your account before using the platform console.'), { code: 'platform_2fa_required' });
    req.platform = { userId: u.id, email: u.email, role: u.platform_role, caps: ROLE_CAPS[u.platform_role as OperatorRole] };
    next();
  } catch (e) { next(e); }
}

/** Route guard: the operator's role must grant this capability. Denied attempts are themselves audited. */
export const needs = (cap: Cap) => async (req: Request, _res: Response, next: NextFunction) => {
  try {
    if (req.platform!.caps.includes(cap)) return next();
    await audit(req, 'permission_denied', null, `${req.method} ${req.originalUrl.split('?')[0]} needs ${cap}; role ${req.platform!.role}`);
    throw Object.assign(new HttpError(403, `Your operator role (${req.platform!.role}) cannot do this.`), { code: 'platform_role_forbidden' });
  } catch (e) { next(e); }
};
/** High-risk actions need a TOTP code entered within the last few minutes — a stolen browser session alone is not enough. */
export const stepUp = async (req: Request, _res: Response, next: NextFunction) => {
  try {
    if (process.env.NODE_ENV === 'test') return next();
    const [[u]]: any = await pool.query('SELECT TIMESTAMPDIFF(SECOND, platform_stepup_at, UTC_TIMESTAMP()) age FROM users WHERE id = ?', [req.platform!.userId]);
    if (u?.age == null || u.age > STEP_UP_MINUTES * 60) throw Object.assign(new HttpError(403, 'Confirm with your authenticator code to continue.'), { code: 'step_up_required' });
    next();
  } catch (e) { next(e); }
};

/**
 * Verify a TOTP code and refuse replays: a code (time step) can be used once, even inside its 30-second window.
 * Returns false for wrong or already-used codes.
 */
export async function verifyTotp(userId: number, code: string): Promise<boolean> {
  const [[u]]: any = await pool.query('SELECT totp_secret_enc, totp_enabled, totp_last_step FROM users WHERE id = ?', [userId]);
  if (!u?.totp_enabled || !u.totp_secret_enc) return false;
  const delta = authenticator.clone({ window: 1 }).checkDelta(   // ±1 step tolerates clock drift; replay protection below still allows each step once
    String(code).replace(/\s/g, ''), decrypt(u.totp_secret_enc));
  if (delta === null) return false;
  const step = Math.floor(Date.now() / 30000) + delta;
  const [r]: any = await pool.query('UPDATE users SET totp_last_step = ? WHERE id = ? AND (totp_last_step IS NULL OR totp_last_step < ?)', [step, userId, step]);   // atomic: concurrent reuse loses
  return r.affectedRows === 1;
}
export async function performStepUp(req: Request, code: string) {
  const [[f]]: any = await pool.query(`SELECT COUNT(*) n FROM platform_audit_log WHERE admin_user_id = ? AND action = 'step_up_failed' AND created_at > DATE_SUB(NOW(), INTERVAL 10 MINUTE)`, [req.platform!.userId]);
  if (f.n >= 5) throw new HttpError(429, 'Too many wrong codes. Wait 10 minutes.');
  if (!(await verifyTotp(req.platform!.userId, code))) { await audit(req, 'step_up_failed', null); throw new HttpError(401, 'That code is wrong or was already used. Wait for the next code.'); }
  await pool.query('UPDATE users SET platform_stepup_at = UTC_TIMESTAMP() WHERE id = ?', [req.platform!.userId]);
  await audit(req, 'step_up_ok', null); return { valid_for_minutes: STEP_UP_MINUTES };
}
export async function listOperators() { const [r]: any = await pool.query('SELECT email, name, platform_role role, totp_enabled, platform_stepup_at FROM users WHERE is_platform_admin = 1 ORDER BY platform_role, email'); return r; }

export async function audit(req: Request, action: string, agencyId: number | null, detail?: string | null, reason?: string | null) {
  await pool.query('INSERT INTO platform_audit_log (admin_user_id, action, agency_id, detail, reason, ip) VALUES (?,?,?,?,?,?)', [req.platform!.userId, action, agencyId, detail?.slice(0, 600) ?? null, reason ?? null, req.ip ?? null]);
}
async function agencyOrThrow(id: number) { const [[a]]: any = await pool.query('SELECT id, name, base_currency, created_at FROM agencies WHERE id = ?', [id]); if (!a) throw new HttpError(404, 'Agency not found'); return a; }
async function admins(agencyId: number) { const [r]: any = await pool.query(`SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.agency_id = ? AND m.role = 'admin'`, [agencyId]); return r.map((x: any) => x.email as string); }
const sec = (agencyId: number, userId: number, ip: string | undefined, event: string, detail: string) => pool.query('INSERT INTO security_events (agency_id, user_id, ip, event, detail) VALUES (?,?,?,?,?)', [agencyId, userId, ip ?? null, event, detail.slice(0, 500)]);
const bev = (agencyId: number, kind: string, detail: string, by: number) => pool.query('INSERT INTO billing_events (agency_id, kind, detail, created_by) VALUES (?,?,?,?)', [agencyId, kind, detail.slice(0, 400), by]);

/* ------------------------------------------------------------------ read models */
export async function overview() {
  const [[a]]: any = await pool.query('SELECT COUNT(*) n, SUM(created_at > DATE_SUB(NOW(), INTERVAL 30 DAY)) new30 FROM agencies');
  const [st]: any = await pool.query('SELECT status, COUNT(*) n FROM subscriptions GROUP BY status');
  const [[m]]: any = await pool.query(`SELECT COALESCE(SUM(CASE WHEN s.is_manual = 0 THEN IF(s.billing_interval = 'yearly', p.price_yearly / 12, p.price_monthly) END),0) mrr,
      COALESCE(SUM(CASE WHEN s.is_manual = 1 THEN IF(s.billing_interval = 'yearly', p.price_yearly / 12, p.price_monthly) END),0) manual_mrr
      FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.status IN ('active','past_due')`);
  const [byPlan]: any = await pool.query(`SELECT p.code, p.name, COUNT(*) n FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.status IN ('active','past_due','trialing','grace') GROUP BY p.id ORDER BY p.sort`);
  const [[tr]]: any = await pool.query(`SELECT COUNT(*) n FROM subscriptions WHERE status = 'trialing' AND trial_ends_at < DATE_ADD(UTC_TIMESTAMP(), INTERVAL 7 DAY)`);
  const [[dead]]: any = await pool.query(`SELECT COUNT(*) n FROM webhook_deliveries WHERE status = 'dead'`);
  const [[crit]]: any = await pool.query(`SELECT COUNT(*) n FROM exceptions WHERE status = 'open' AND severity = 'critical'`);
  const [[holds]]: any = await pool.query('SELECT COUNT(*) n FROM subscriptions WHERE platform_hold = 1');
  const [[sess]]: any = await pool.query('SELECT COUNT(*) n FROM support_sessions WHERE revoked_at IS NULL AND expires_at > UTC_TIMESTAMP()');
  return { agencies: a.n, new_30d: Number(a.new30 ?? 0), by_status: Object.fromEntries(st.map((r: any) => [r.status, r.n])), by_plan: byPlan, mrr: Math.round(m.mrr * 100) / 100, manual_mrr: Math.round(m.manual_mrr * 100) / 100, arr: Math.round(m.mrr * 1200) / 100,
    trials_ending_7d: tr.n, dead_webhook_deliveries: dead.n, open_critical_exceptions: crit.n, platform_holds: holds.n, pending_approvals: (await pool.query("SELECT COUNT(*) n FROM platform_approvals WHERE status = 'pending' AND expires_at > UTC_TIMESTAMP()") as any)[0][0].n, active_support_sessions: sess.n };
}

export async function listAgencies(q: { q?: string; status?: string; plan?: string; page?: number }) {
  const where: string[] = [], p: any[] = [];
  if (q.q) { where.push('(a.name LIKE ? OR EXISTS (SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.agency_id = a.id AND u.email LIKE ?))'); p.push(`%${q.q}%`, `%${q.q}%`); }
  if (q.status) { where.push('s.status = ?'); p.push(q.status); }
  if (q.plan) { where.push('pl.code = ?'); p.push(q.plan); }
  const limit = 50, off = Math.max(0, ((q.page ?? 1) - 1) * limit);
  const [rows]: any = await pool.query(`SELECT a.id, a.name, a.base_currency, a.created_at, s.status, s.platform_hold, s.is_manual, s.trial_ends_at, s.current_period_end, pl.code plan_code, pl.name plan_name,
      (SELECT COUNT(*) FROM memberships m WHERE m.agency_id = a.id) seats, (SELECT MAX(created_at) FROM api_log l WHERE l.agency_id = a.id) last_active
    FROM agencies a LEFT JOIN subscriptions s ON s.agency_id = a.id LEFT JOIN plans pl ON pl.id = s.plan_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY a.id DESC LIMIT ? OFFSET ?`, [...p, limit, off]);
  const [[c]]: any = await pool.query(`SELECT COUNT(*) n FROM agencies a LEFT JOIN subscriptions s ON s.agency_id = a.id LEFT JOIN plans pl ON pl.id = s.plan_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`, p);
  return { total: c.n, page: q.page ?? 1, page_size: limit, rows };
}

export async function agencyDetail(id: number) {
  const a = await agencyOrThrow(id), s = await getSub(id);
  const [members]: any = await pool.query('SELECT m.user_id, m.role, u.name, u.email, u.totp_enabled FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.agency_id = ? ORDER BY m.role, u.name', [id]);
  const [events]: any = await pool.query('SELECT kind, detail, created_at FROM billing_events WHERE agency_id = ? ORDER BY id DESC LIMIT 30', [id]);
  const [secEv]: any = await pool.query('SELECT event, detail, ip, created_at FROM security_events WHERE agency_id = ? ORDER BY id DESC LIMIT 30', [id]);
  const [sessions]: any = await pool.query(`SELECT ss.id, ss.reason, ss.expires_at, ss.revoked_at, ss.created_at, u.email admin_email FROM support_sessions ss JOIN users u ON u.id = ss.admin_user_id WHERE ss.agency_id = ? ORDER BY ss.id DESC LIMIT 10`, [id]);
  const [[fail]]: any = await pool.query(`SELECT COUNT(*) n FROM delivery_log WHERE agency_id = ? AND status = 'failed' AND created_at > DATE_SUB(NOW(), INTERVAL 7 DAY)`, [id]);
  const [[crit]]: any = await pool.query(`SELECT COUNT(*) n FROM exceptions WHERE agency_id = ? AND status = 'open' AND severity = 'critical'`, [id]);
  const [[act]]: any = await pool.query('SELECT MAX(created_at) at, COUNT(*) n FROM api_log WHERE agency_id = ? AND created_at > DATE_SUB(NOW(), INTERVAL 30 DAY)', [id]);
  return { agency: a, subscription: s ? { status: s.status, plan: s.plan_code, plan_name: s.plan_name, interval: s.billing_interval, trial_ends_at: s.trial_ends_at, current_period_end: s.current_period_end, grace_until: s.grace_until, manual: !!s.is_manual,
      cancel_at_period_end: !!s.cancel_at_period_end, platform_hold: !!s.platform_hold, hold_reason: s.hold_reason, stripe_customer_id: s.stripe_customer_id } : null,
    usage: await usage(id), members, billing_events: events, security_events: secEv, support_sessions: sessions, failed_emails_7d: fail.n, open_critical_exceptions: crit.n, last_active: act.at, requests_30d: act.n };
}

/* ------------------------------------------------------------------ actions on an agency (all need a reason, all are audited) */
export async function extendTrial(req: Request, id: number, days: number, reasonIn: unknown) {
  const reason = needReason(reasonIn); await agencyOrThrow(id); const s = await getSub(id); if (!s) throw new HttpError(404, 'No subscription');
  if (s.platform_hold) throw new HttpError(409, 'Release the hold first');
  const base = s.trial_ends_at && new Date(`${String(s.trial_ends_at).replace(' ', 'T')}Z`) > new Date() ? new Date(`${String(s.trial_ends_at).replace(' ', 'T')}Z`) : new Date(), end = new Date(base.getTime() + days * 86400_000);
  await pool.query(`UPDATE subscriptions SET status = 'trialing', trial_ends_at = ?, grace_until = NULL WHERE agency_id = ? AND (status IN ('trialing','grace','suspended') )`, [sqlTime(end), id]);
  if ((await getSub(id)).status !== 'trialing') throw new HttpError(409, 'Only trialing, grace or suspended workspaces can have their trial extended');
  await bev(id, 'trial_extended', `+${days} days (${reason})`, req.platform!.userId); await audit(req, 'extend_trial', id, `+${days}d → ${sqlTime(end)}`, reason);
  return { trial_ends_at: sqlTime(end) };
}
export async function setPlan(req: Request, id: number, planCode: string, interval: 'monthly' | 'yearly', reasonIn: unknown) {
  const reason = needReason(reasonIn); await agencyOrThrow(id);
  const [[p]]: any = await pool.query('SELECT id FROM plans WHERE code = ?', [planCode]); if (!p) throw new HttpError(400, 'Unknown plan');
  await pool.query('UPDATE subscriptions SET plan_id = ?, billing_interval = ?, pending_plan_id = NULL, pending_interval = NULL WHERE agency_id = ?', [p.id, interval, id]);
  await bev(id, 'plan_set_by_operator', `${planCode} ${interval} (${reason})`, req.platform!.userId); await audit(req, 'set_plan', id, `${planCode} ${interval}`, reason);
}
export async function grant(req: Request, id: number, planCode: string, interval: 'monthly' | 'yearly', until: string, reasonIn: unknown) {
  const reason = needReason(reasonIn); await agencyOrThrow(id); const d = new Date(`${until}T23:59:59Z`);
  if (Number.isNaN(d.getTime()) || d.getTime() < Date.now()) throw new HttpError(400, 'The end date must be in the future');
  await grantManual(id, planCode, interval, d); await audit(req, 'grant_manual', id, `${planCode} ${interval} until ${until}`, reason);
}
export async function suspend(req: Request, id: number, reasonIn: unknown) {
  const reason = needReason(reasonIn); await agencyOrThrow(id);
  await pool.query(`UPDATE subscriptions SET status = 'suspended', platform_hold = 1, hold_reason = ? WHERE agency_id = ?`, [reason, id]);
  await pool.query(`UPDATE support_sessions SET revoked_at = UTC_TIMESTAMP(), revoked_by = ? WHERE agency_id = ? AND revoked_at IS NULL`, [req.platform!.userId, id]).catch(() => {});
  await bev(id, 'platform_suspended', reason, req.platform!.userId); await audit(req, 'suspend', id, null, reason);
  await sec(id, req.platform!.userId, req.ip, 'platform_suspended', reason);
}
/* ------------------------------------------------------------------ two-person approval */
export const APPROVAL_HOURS = 24;
/** Mark overdue requests expired. Called lazily on every read/decision, so no job is needed. */
async function expireStale() { await pool.query(`UPDATE platform_approvals SET status = 'expired', decided_at = UTC_TIMESTAMP() WHERE status = 'pending' AND expires_at < UTC_TIMESTAMP()`); }

/** Ask for a suspension. Nothing happens to the customer until a *different* admin operator approves it. */
export async function requestSuspend(req: Request, id: number, reasonIn: unknown) {
  const reason = needReason(reasonIn), a = await agencyOrThrow(id); await expireStale();
  const s = await getSub(id); if (s?.platform_hold) throw new HttpError(409, 'This workspace is already under an operator hold');
  const [[dup]]: any = await pool.query(`SELECT id FROM platform_approvals WHERE agency_id = ? AND action = 'suspend' AND status = 'pending'`, [id]); if (dup) throw new HttpError(409, `A suspension request for this agency is already awaiting approval (#${dup.id})`);
  const [[others]]: any = await pool.query(`SELECT COUNT(*) n FROM users WHERE is_platform_admin = 1 AND platform_role = 'admin' AND totp_enabled = 1 AND id <> ?`, [req.platform!.userId]);
  if (!others.n) throw Object.assign(new HttpError(409, 'No second admin operator exists to approve this. Add one (npm run platform:admin) — or, for a single-operator installation, set PLATFORM_TWO_PERSON=false.'), { code: 'no_second_approver' });
  const exp = sqlTime(new Date(Date.now() + APPROVAL_HOURS * 3600_000));
  const [r]: any = await pool.query(`INSERT INTO platform_approvals (action, agency_id, reason, requested_by, expires_at) VALUES ('suspend', ?, ?, ?, ?)`, [id, reason, req.platform!.userId, exp]);
  await audit(req, 'suspend_requested', id, `approval #${r.insertId}`, reason);
  const [mail]: any = await pool.query(`SELECT email FROM users WHERE is_platform_admin = 1 AND platform_role = 'admin' AND totp_enabled = 1 AND id <> ?`, [req.platform!.userId]);
  for (const m of mail) void sendMail(m.email, `Approval needed: suspend ${a.name}`, `<p>${req.platform!.email} asks to <b>suspend ${a.name.replace(/</g, '&lt;')}</b>.</p><p>Reason: ${reason.replace(/</g, '&lt;')}</p><p>Review it in the platform console → Approvals. The request expires in ${APPROVAL_HOURS} hours.</p>`).catch(() => {});
  return { approval_id: r.insertId as number, status: 'pending' as const, expires_at: exp };
}
export async function listApprovals(status?: string) {
  await expireStale();
  const [rows]: any = await pool.query(`SELECT p.id, p.action, p.agency_id, a.name agency_name, p.reason, p.status, p.requested_at, p.expires_at, p.decided_at, p.decision_note, rq.email requested_by_email, dc.email decided_by_email
    FROM platform_approvals p JOIN agencies a ON a.id = p.agency_id JOIN users rq ON rq.id = p.requested_by LEFT JOIN users dc ON dc.id = p.decided_by ${status ? 'WHERE p.status = ?' : ''} ORDER BY p.id DESC LIMIT 200`, status ? [status] : []);
  return rows;
}
async function loadApproval(id: number) { await expireStale(); const [[p]]: any = await pool.query('SELECT * FROM platform_approvals WHERE id = ?', [id]); if (!p) throw new HttpError(404, 'Approval request not found'); return p; }
export async function approveSuspend(req: Request, id: number, note?: string) {
  const p = await loadApproval(id);
  if (p.requested_by === req.platform!.userId) throw Object.assign(new HttpError(403, 'You cannot approve your own request — a second operator must.'), { code: 'self_approval' });
  const [claim]: any = await pool.query(`UPDATE platform_approvals SET status = 'approved', decided_by = ?, decided_at = UTC_TIMESTAMP(), decision_note = ? WHERE id = ? AND status = 'pending'`, [req.platform!.userId, note?.slice(0, 300) ?? null, id]);
  if (!claim.affectedRows) throw new HttpError(409, `This request is already ${p.status}.`);   // atomic: two approvers cannot both execute it
  try { await suspend(req, p.agency_id, p.reason); }
  catch (e) { await pool.query(`UPDATE platform_approvals SET status = 'pending', decided_by = NULL, decided_at = NULL WHERE id = ?`, [id]); throw e; }
  const [[rq]]: any = await pool.query('SELECT email FROM users WHERE id = ?', [p.requested_by]);
  await audit(req, 'suspend_approved', p.agency_id, `approval #${id}: requested by ${rq.email}, approved by ${req.platform!.email}`, note ?? null);
}
export async function rejectSuspend(req: Request, id: number, reasonIn: unknown) {
  const reason = needReason(reasonIn), p = await loadApproval(id);
  if (p.requested_by === req.platform!.userId) throw new HttpError(403, 'Use Cancel to withdraw your own request.');
  const [c]: any = await pool.query(`UPDATE platform_approvals SET status = 'rejected', decided_by = ?, decided_at = UTC_TIMESTAMP(), decision_note = ? WHERE id = ? AND status = 'pending'`, [req.platform!.userId, reason, id]);
  if (!c.affectedRows) throw new HttpError(409, `This request is already ${p.status}.`); await audit(req, 'suspend_rejected', p.agency_id, `approval #${id}`, reason);
}
export async function cancelSuspend(req: Request, id: number) {
  const p = await loadApproval(id); if (p.requested_by !== req.platform!.userId) throw new HttpError(403, 'Only the requester can cancel a request.');
  const [c]: any = await pool.query(`UPDATE platform_approvals SET status = 'cancelled', decided_by = ?, decided_at = UTC_TIMESTAMP() WHERE id = ? AND status = 'pending'`, [req.platform!.userId, id]);
  if (!c.affectedRows) throw new HttpError(409, `This request is already ${p.status}.`); await audit(req, 'suspend_cancelled', p.agency_id, `approval #${id}`);
}

export async function reactivate(req: Request, id: number, reasonIn: unknown) {
  const reason = needReason(reasonIn); await agencyOrThrow(id); const s = await getSub(id); if (!s?.platform_hold) throw new HttpError(409, 'This workspace has no operator hold');
  const paid = s.stripe_subscription_id || s.is_manual;
  await pool.query(`UPDATE subscriptions SET platform_hold = 0, hold_reason = NULL, status = ?, grace_until = ?, trial_ends_at = IF(? = 'trialing', ?, trial_ends_at) WHERE agency_id = ?`,
    [paid ? 'active' : 'trialing', null, paid ? 'active' : 'trialing', sqlTime(new Date(Date.now() + 7 * 86400_000)), id]);
  await bev(id, 'platform_reactivated', reason, req.platform!.userId); await audit(req, 'reactivate', id, paid ? 'active' : 'trialing +7d', reason);
}

/* ------------------------------------------------------------------ support sessions: read-only, time-boxed, visible to the customer */
export async function startSupportSession(req: Request, id: number, reasonIn: unknown, minutes = 30) {
  const reason = needReason(reasonIn), a = await agencyOrThrow(id), mins = Math.min(60, Math.max(5, minutes)), exp = new Date(Date.now() + mins * 60_000);
  const [r]: any = await pool.query('INSERT INTO support_sessions (admin_user_id, agency_id, reason, expires_at) VALUES (?,?,?,?)', [req.platform!.userId, id, reason, sqlTime(exp)]);
  const token = jwt.sign({ sub: req.platform!.userId, sup: r.insertId }, config.jwtSecret, { algorithm: 'HS256', expiresIn: mins * 60 });
  await audit(req, 'support_session_start', id, `session ${r.insertId}, ${mins} min`, reason);
  await sec(id, req.platform!.userId, req.ip, 'support_access_granted', `Platform support (${req.platform!.email}) opened a read-only session for ${mins} min. Reason: ${reason}`);
  const t = new Tenant(id, { userId: null, ip: 'platform' });
  for (const to of await admins(id)) await deliver(t, { kind: 'support_access', to, subject: 'Support accessed your workspace (read-only)', html: `<p>A TravelFinance Pro support engineer opened a <b>read-only</b> session on your workspace for ${mins} minutes.</p><p>Reason: ${reason.replace(/</g, '&lt;')}</p><p>You can end it at any time under Settings → Support access.</p>` });
  return { token, session_id: r.insertId, expires_at: sqlTime(exp), agency: a };
}
export async function revokeSupportSession(req: Request, sessionId: number, reasonIn: unknown) {
  const reason = needReason(reasonIn); const [[s]]: any = await pool.query('SELECT agency_id FROM support_sessions WHERE id = ?', [sessionId]); if (!s) throw new HttpError(404, 'Session not found');
  await pool.query('UPDATE support_sessions SET revoked_at = COALESCE(revoked_at, UTC_TIMESTAMP()), revoked_by = ? WHERE id = ?', [req.platform!.userId, sessionId]); await audit(req, 'support_session_revoke', s.agency_id, `session ${sessionId}`, reason);
}

/* ------------------------------------------------------------------ plans */
export const MODULE_CODES = ['crm', 'ticketing', 'finance', 'accounting', 'insights'] as const;
export type ModuleCode = (typeof MODULE_CODES)[number];
export interface PlanIn { code?: string; name: string; description?: string | null; price_monthly: number; price_yearly: number; currency?: string; trial_days: number; max_seats: number | null; max_branches: number | null; max_bookings_month: number | null; features: string[]; allowed_modules: string[] | null; support_level: string; stripe_price_monthly?: string | null; stripe_price_yearly?: string | null; active: boolean; sort: number }
const checkFeatures = (f: string[]) => { const bad = f.filter((x) => !(FEATURES as readonly string[]).includes(x)); if (bad.length) throw new HttpError(400, `Unknown feature(s): ${bad.join(', ')}`); };
const checkModules = (m: string[] | null) => { if (!m) return; const bad = m.filter((x) => !(MODULE_CODES as readonly string[]).includes(x)); if (bad.length) throw new HttpError(400, `Unknown module(s): ${bad.join(', ')}`); };
const parseModules = (v: any): string[] | null => { if (v === null || v === undefined) return null; const s = String(v); return s === '' ? null : s.split(',').filter(Boolean); };
export async function listPlans() {
  const [r]: any = await pool.query(`SELECT p.*, (SELECT COUNT(*) FROM subscriptions s WHERE s.plan_id = p.id) agencies FROM plans p ORDER BY p.sort, p.id`);
  return r.map((p: any) => ({ ...p, features: String(p.features).split(',').filter(Boolean), allowed_modules: parseModules(p.allowed_modules) }));
}
export async function createPlan(req: Request, b: PlanIn) {
  if (!b.code || !/^[a-z][a-z0-9_-]{1,29}$/.test(b.code)) throw new HttpError(400, 'Plan code must be lowercase letters, digits, - or _');
  checkFeatures(b.features); checkModules(b.allowed_modules);
  try { const [r]: any = await pool.query('INSERT INTO plans (code, name, description, price_monthly, price_yearly, currency, trial_days, max_seats, max_branches, max_bookings_month, features, allowed_modules, support_level, stripe_price_monthly, stripe_price_yearly, active, sort) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [b.code, b.name, b.description ?? null, b.price_monthly, b.price_yearly, b.currency ?? 'USD', b.trial_days, b.max_seats, b.max_branches, b.max_bookings_month, b.features.join(','), b.allowed_modules ? b.allowed_modules.join(',') : null, b.support_level, b.stripe_price_monthly ?? null, b.stripe_price_yearly ?? null, b.active ? 1 : 0, b.sort]);
    await audit(req, 'plan_create', null, `${b.code}`); return r.insertId as number; } catch (e: any) { if (e.code === 'ER_DUP_ENTRY') throw new HttpError(409, 'A plan with that code already exists'); throw e; }
}
export async function updatePlan(req: Request, id: number, b: PlanIn, reasonIn: unknown) {
  const reason = needReason(reasonIn); checkFeatures(b.features); checkModules(b.allowed_modules);
  const [[cur]]: any = await pool.query('SELECT * FROM plans WHERE id = ?', [id]); if (!cur) throw new HttpError(404, 'Plan not found');
  await pool.query(`UPDATE plans SET name = ?, description = ?, price_monthly = ?, price_yearly = ?, trial_days = ?, max_seats = ?, max_branches = ?, max_bookings_month = ?, features = ?, allowed_modules = ?, support_level = ?, stripe_price_monthly = ?, stripe_price_yearly = ?, active = ?, sort = ? WHERE id = ?`,
    [b.name, b.description ?? null, b.price_monthly, b.price_yearly, b.trial_days, b.max_seats, b.max_branches, b.max_bookings_month, b.features.join(','), b.allowed_modules ? b.allowed_modules.join(',') : null, b.support_level, b.stripe_price_monthly ?? null, b.stripe_price_yearly ?? null, b.active ? 1 : 0, b.sort, id]);
  const diff = Object.entries({ price_monthly: b.price_monthly, price_yearly: b.price_yearly, max_seats: b.max_seats, max_branches: b.max_branches, max_bookings_month: b.max_bookings_month, features: b.features.join(','), allowed_modules: (b.allowed_modules ?? []).join(','), active: b.active ? 1 : 0 }).filter(([k, v]) => String((cur as any)[k] ?? '') !== String(v)).map(([k, v]) => `${k}: ${(cur as any)[k]} → ${v}`).join('; ');
  await audit(req, 'plan_update', null, `${cur.code}: ${diff || 'no material change'}`, reason);
  const [[n]]: any = await pool.query('SELECT COUNT(*) n FROM subscriptions WHERE plan_id = ?', [id]); return { agencies_affected: n.n };
}

/* ------------------------------------------------------------------ agency creation (platform operator) */
export async function createAgency(req: Request, b: { agencyName: string; adminName: string; adminEmail: string; adminPassword: string; planCode: string; baseCurrency: string }) {
  const { default: bcrypt } = await import('bcryptjs');
  const { startTrial } = await import('./billing.js');
  const { seedChart } = await import('./accounting.js');
  const { Tenant } = await import('../db.js');
  const [ex]: any = await pool.query('SELECT id FROM users WHERE email = ?', [b.adminEmail]);
  if (ex.length) throw new HttpError(409, 'A user with that email already exists');
  const c = await pool.getConnection();
  let agencyId: number, userId: number;
  try {
    await c.beginTransaction();
    const [a]: any = await c.query('INSERT INTO agencies (name, base_currency) VALUES (?,?)', [b.agencyName, b.baseCurrency]);
    agencyId = a.insertId;
    const [u]: any = await c.query('INSERT INTO users (email, name, password_hash) VALUES (?,?,?)', [b.adminEmail, b.adminName, await bcrypt.hash(b.adminPassword, 12)]);
    userId = u.insertId;
    await c.query('INSERT INTO memberships (agency_id, user_id, role) VALUES (?,?,"admin")', [agencyId, userId]);
    await c.commit();
  } catch (e) { await c.rollback(); throw e; } finally { c.release(); }
  await seedChart(new Tenant(agencyId, { userId, ip: req.ip ?? 'platform' }));
  await startTrial(agencyId, b.planCode || 'growth');
  await audit(req, 'agency_create', agencyId, `${b.agencyName} / admin: ${b.adminEmail} / plan: ${b.planCode}`);
  return { agencyId, userId };
}

/* ------------------------------------------------------------------ operator CLI helpers */
export async function setPlatformAdmin(email: string, role: OperatorRole | null) {
  if (role !== null && !(role in ROLE_CAPS)) throw new Error(`Unknown role ${role}. Use: ${Object.keys(ROLE_CAPS).join(', ')}`);
  const [r]: any = await pool.query('UPDATE users SET is_platform_admin = ?, platform_role = ?, platform_stepup_at = NULL WHERE email = ?', [role ? 1 : 0, role, email]); if (!r.affectedRows) throw new Error(`No user with email ${email}`);
  await pool.query('INSERT INTO platform_audit_log (admin_user_id, action, detail, ip) SELECT id, ?, ?, ? FROM users WHERE email = ?', [role ? 'operator_role_set_cli' : 'operator_revoked_cli', role ? `role ${role}` : 'revoked', 'cli', email]);
}
