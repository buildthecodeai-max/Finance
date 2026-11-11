import jwt from 'jsonwebtoken';
import { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';
import { HttpError } from '../errors.js';
import { Tenant, pool } from '../db.js';
import { FEATURES, getSub, grantManual, usage } from './billing.js';
import { aiStatus, aiUsedThisMonth, llm } from './ai.js';
import { dropAiKeyCache, resolveAi } from './aiKey.js';
import { DEFAULT_MODELS, PROVIDERS, PROVIDER_LABEL, checkBaseUrl, type AiProvider } from './aiProviders.js';
import { encrypt } from '../crypto.js';
import { deliver } from './portal.js';
import { counters, health } from './observability.js';
import { setPasswordFor } from './passwords.js';
import { sendMail } from './email.js';
import { authenticator } from 'otplib';
import crypto from 'node:crypto';
import { decrypt, sha256 } from '../crypto.js';
import { changeMember, memberWorkload, removeMember } from './records.js';
import * as LP from './localPay.js';

export type OperatorRole = 'readonly' | 'support' | 'billing' | 'admin';
export type Cap = 'read' | 'support' | 'billing' | 'suspend';
/** What each operator role may do. Roles are assigned only from the server CLI. */
export const ROLE_CAPS: Record<OperatorRole, Cap[]> = { readonly: ['read'], support: ['read', 'support'], billing: ['read', 'billing'], admin: ['read', 'support', 'billing', 'suspend'] };
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
    const [[u]]: any = await pool.query('SELECT id, email, is_platform_admin, platform_role, totp_enabled, disabled_at FROM users WHERE id = ?', [Number(p.sub)]);
    if (!u?.is_platform_admin || !u.platform_role) throw new HttpError(404, 'Not found');
    if (u.disabled_at) throw new HttpError(401, 'This account has been disabled.');   // indistinguishable from a route that does not exist
    if (!u.totp_enabled && !config.skip2fa) throw Object.assign(new HttpError(403, 'Turn on two-factor authentication for your account before using the platform console.'), { code: 'platform_2fa_required' });
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
/** Append-only by database trigger: kept after an agency is deleted, as evidence of what happened. */
export const RETAINED_ON_DELETE = new Set(['audit_log', 'security_events', 'period_locks', 'booking_changes', 'platform_audit_log']);

/** Every table that holds per-agency rows (read from the schema, so tables added later are covered), minus the append-only evidence tables. */
export async function tenantTables(): Promise<string[]> {
  const [found]: any = await pool.query(
    `SELECT DISTINCT c.TABLE_NAME AS t FROM information_schema.COLUMNS c
     JOIN information_schema.TABLES x ON x.TABLE_SCHEMA = c.TABLE_SCHEMA AND x.TABLE_NAME = c.TABLE_NAME AND x.TABLE_TYPE = 'BASE TABLE'
     WHERE c.TABLE_SCHEMA = DATABASE() AND c.COLUMN_NAME = 'agency_id' ORDER BY c.TABLE_NAME`);
  return found.map((r: any) => r.t).filter((t: string) => !RETAINED_ON_DELETE.has(t));
}

/**
 * Permanently delete an agency and every tenant row that carries its agency_id, in one transaction.
 * Tenant isolation is enforced in application code (only `memberships` has a real FK), so the table list is read from the schema
 * rather than hard-coded; a table added later is covered automatically. Users who belonged only to this agency are removed too
 * (never platform operators). Any failure rolls everything back and is reported, never swallowed.
 */
export async function deleteAgency(id: number): Promise<{ name: string; tables: number; rows: number; users: number }> {
  const [[ag]]: any = await pool.query('SELECT name FROM agencies WHERE id = ?', [id]);
  if (!ag) throw new HttpError(404, 'Agency not found');
  const tables = await tenantTables();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [members]: any = await conn.query('SELECT DISTINCT user_id FROM memberships WHERE agency_id = ?', [id]);
    let rows = 0;
    for (const t of tables) { const [r]: any = await conn.query(`DELETE FROM \`${t}\` WHERE agency_id = ?`, [id]); rows += r.affectedRows; }
    let users = 0;
    if (members.length) {
      const [orphans]: any = await conn.query(
        `SELECT u.id FROM users u WHERE u.id IN (?) AND u.is_platform_admin = 0 AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = u.id)`, [members.map((m: any) => m.user_id)]);
      const ids = orphans.map((o: any) => o.id);
      if (ids.length) {
        await conn.query('DELETE FROM refresh_tokens WHERE user_id IN (?)', [ids]);
        await conn.query('DELETE FROM password_resets WHERE user_id IN (?)', [ids]);
        const [u]: any = await conn.query('DELETE FROM users WHERE id IN (?)', [ids]); users = u.affectedRows;
      }
    }
    await conn.query('DELETE FROM agencies WHERE id = ?', [id]);
    await conn.commit();
    return { name: ag.name, tables: tables.length, rows, users };
  } catch (e) { await conn.rollback(); throw e; }
  finally { conn.release(); }
}
export async function listOperators() {
  const [r]: any = await pool.query(`SELECT u.id, u.email, u.name, u.platform_role role, u.totp_enabled, u.totp_required, u.disabled_at, u.created_at,
      (SELECT MAX(t.created_at) FROM refresh_tokens t WHERE t.user_id = u.id) last_seen,
      (SELECT COUNT(*) FROM platform_audit_log a WHERE a.admin_user_id = u.id AND a.created_at > DATE_SUB(NOW(), INTERVAL 30 DAY)) actions_30d
    FROM users u WHERE u.is_platform_admin = 1 ORDER BY FIELD(u.platform_role, 'admin', 'billing', 'support', 'readonly'), u.email`);
  return r;
}

/** The subscription fields worth showing in an audit before/after diff. */
const subState = (s: any) => s && ({ status: s.status, plan_id: s.plan_id, billing_interval: s.billing_interval, trial_ends_at: s.trial_ends_at, platform_hold: !!s.platform_hold, is_manual: !!s.is_manual });

/** Append-only record of an operator action: who (id + role), what, which agency, before/after state, and request metadata. The reason is optional. */
export async function audit(req: Request, action: string, agencyId: number | null, detail?: string | null, reason?: string | null, state?: { before?: unknown; after?: unknown }) {
  const json = (v: unknown) => (v === undefined || v === null ? null : JSON.stringify(v));
  await pool.query('INSERT INTO platform_audit_log (admin_user_id, action, agency_id, detail, reason, ip, actor_role, user_agent, before_json, after_json) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [req.platform!.userId, action, agencyId, detail?.slice(0, 600) ?? null, reason || null, req.ip ?? null, req.platform!.role, String(req.headers['user-agent'] ?? '').slice(0, 200) || null, json(state?.before), json(state?.after)]);
}
async function agencyOrThrow(id: number) { const [[a]]: any = await pool.query('SELECT id, name, base_currency, created_at, ai_access, ai_monthly_limit FROM agencies WHERE id = ?', [id]); if (!a) throw new HttpError(404, 'Agency not found'); return a; }
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
  // New agencies per week for the last 12 weeks (week 0 is the current one), filled in so a quiet week shows as zero
  const [wk]: any = await pool.query('SELECT FLOOR(DATEDIFF(CURDATE(), DATE(created_at)) / 7) w, COUNT(*) n FROM agencies WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 84 DAY) GROUP BY w');
  const signups = Array.from({ length: 12 }, (_, i) => Number(wk.find((x: any) => Number(x.w) === 11 - i)?.n ?? 0));
  const [[act7]]: any = await pool.query('SELECT COUNT(DISTINCT agency_id) n FROM api_log WHERE created_at > DATE_SUB(NOW(), INTERVAL 7 DAY)');
  const [trials]: any = await pool.query(`SELECT a.id, a.name, pl.name plan_name, s.trial_ends_at, CEIL(TIMESTAMPDIFF(MINUTE, UTC_TIMESTAMP(), s.trial_ends_at) / 1440) days_left
      FROM subscriptions s JOIN agencies a ON a.id = s.agency_id LEFT JOIN plans pl ON pl.id = s.plan_id WHERE s.status = 'trialing' ORDER BY s.trial_ends_at LIMIT 6`);
  const [fresh]: any = await pool.query(`SELECT a.id, a.name, a.created_at, s.status, pl.name plan_name FROM agencies a LEFT JOIN subscriptions s ON s.agency_id = a.id LEFT JOIN plans pl ON pl.id = s.plan_id ORDER BY a.id DESC LIMIT 5`);
  return { signups, active_7d: Number(act7.n), trials, recent_agencies: fresh, agencies: a.n, new_30d: Number(a.new30 ?? 0), by_status: Object.fromEntries(st.map((r: any) => [r.status, r.n])), by_plan: byPlan, mrr: Math.round(m.mrr * 100) / 100, manual_mrr: Math.round(m.manual_mrr * 100) / 100, arr: Math.round(m.mrr * 1200) / 100,
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
  const [cs]: any = await pool.query("SELECT COALESCE(s.status, 'none') st, COUNT(*) n FROM agencies a LEFT JOIN subscriptions s ON s.agency_id = a.id GROUP BY st");
  return { total: c.n, page: q.page ?? 1, page_size: limit, rows, counts: Object.fromEntries(cs.map((r: any) => [r.st, Number(r.n)])) };
}

export async function agencyDetail(id: number) {
  const a = await agencyOrThrow(id), s = await getSub(id);
  const [members]: any = await pool.query('SELECT m.user_id, m.role, u.name, u.email, u.totp_enabled, u.totp_required FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.agency_id = ? ORDER BY m.role, u.name', [id]);
  const [events]: any = await pool.query('SELECT kind, detail, created_at FROM billing_events WHERE agency_id = ? ORDER BY id DESC LIMIT 30', [id]);
  const [secEv]: any = await pool.query('SELECT event, detail, ip, created_at FROM security_events WHERE agency_id = ? ORDER BY id DESC LIMIT 30', [id]);
  const [sessions]: any = await pool.query(`SELECT ss.id, ss.reason, ss.expires_at, ss.revoked_at, ss.created_at, u.email admin_email FROM support_sessions ss JOIN users u ON u.id = ss.admin_user_id WHERE ss.agency_id = ? ORDER BY ss.id DESC LIMIT 10`, [id]);
  const [[fail]]: any = await pool.query(`SELECT COUNT(*) n FROM delivery_log WHERE agency_id = ? AND status = 'failed' AND created_at > DATE_SUB(NOW(), INTERVAL 7 DAY)`, [id]);
  const [[crit]]: any = await pool.query(`SELECT COUNT(*) n FROM exceptions WHERE agency_id = ? AND status = 'open' AND severity = 'critical'`, [id]);
  const [[act]]: any = await pool.query('SELECT MAX(created_at) at, COUNT(*) n FROM api_log WHERE agency_id = ? AND created_at > DATE_SUB(NOW(), INTERVAL 30 DAY)', [id]);
  return { agency: a, subscription: s ? { status: s.status, plan: s.plan_code, plan_name: s.plan_name, interval: s.billing_interval, trial_ends_at: s.trial_ends_at, current_period_end: s.current_period_end, grace_until: s.grace_until, manual: !!s.is_manual,
      cancel_at_period_end: !!s.cancel_at_period_end, platform_hold: !!s.platform_hold, hold_reason: s.hold_reason, stripe_customer_id: s.stripe_customer_id } : null,
    usage: await usage(id), ai: { ...(await aiStatus(id)), ...(await aiUsedThisMonth(id)), key_configured: !!(await resolveAi()).key }, members, billing_events: events, security_events: secEv, support_sessions: sessions, failed_emails_7d: fail.n, open_critical_exceptions: crit.n, last_active: act.at, requests_30d: act.n };
}

/* ------------------------------------------------------------------ actions on an agency (all need a reason, all are audited) */
export async function extendTrial(req: Request, id: number, days: number, reasonIn: unknown) {
  const reason = needReason(reasonIn); await agencyOrThrow(id); const s = await getSub(id); if (!s) throw new HttpError(404, 'No subscription');
  if (s.platform_hold) throw new HttpError(409, 'Release the hold first');
  const before = subState(s);
  const base = s.trial_ends_at && new Date(`${String(s.trial_ends_at).replace(' ', 'T')}Z`) > new Date() ? new Date(`${String(s.trial_ends_at).replace(' ', 'T')}Z`) : new Date(), end = new Date(base.getTime() + days * 86400_000);
  await pool.query(`UPDATE subscriptions SET status = 'trialing', trial_ends_at = ?, grace_until = NULL WHERE agency_id = ? AND (status IN ('trialing','grace','suspended') )`, [sqlTime(end), id]);
  if ((await getSub(id)).status !== 'trialing') throw new HttpError(409, 'Only trialing, grace or suspended workspaces can have their trial extended');
  await bev(id, 'trial_extended', `+${days} days (${reason})`, req.platform!.userId); await audit(req, 'extend_trial', id, `+${days}d → ${sqlTime(end)}`, reason, { before, after: subState(await getSub(id)) });
  return { trial_ends_at: sqlTime(end) };
}
export async function setPlan(req: Request, id: number, planCode: string, interval: 'monthly' | 'yearly', reasonIn: unknown) {
  const reason = needReason(reasonIn); await agencyOrThrow(id);
  const [[p]]: any = await pool.query('SELECT id FROM plans WHERE code = ?', [planCode]); if (!p) throw new HttpError(400, 'Unknown plan');
  const before = subState(await getSub(id));
  await pool.query('UPDATE subscriptions SET plan_id = ?, billing_interval = ?, pending_plan_id = NULL, pending_interval = NULL WHERE agency_id = ?', [p.id, interval, id]);
  await bev(id, 'plan_set_by_operator', `${planCode} ${interval} (${reason})`, req.platform!.userId); await audit(req, 'set_plan', id, `${planCode} ${interval}`, reason, { before, after: subState(await getSub(id)) });
}
export async function grant(req: Request, id: number, planCode: string, interval: 'monthly' | 'yearly', until: string, reasonIn: unknown) {
  const reason = needReason(reasonIn); await agencyOrThrow(id); const d = new Date(`${until}T23:59:59Z`);
  if (Number.isNaN(d.getTime()) || d.getTime() < Date.now()) throw new HttpError(400, 'The end date must be in the future');
  const before = subState(await getSub(id));
  await grantManual(id, planCode, interval, d); await audit(req, 'grant_manual', id, `${planCode} ${interval} until ${until}`, reason, { before, after: subState(await getSub(id)) });
}
export async function suspend(req: Request, id: number, reasonIn: unknown) {
  const reason = needReason(reasonIn); await agencyOrThrow(id); const before = subState(await getSub(id));
  await pool.query(`UPDATE subscriptions SET status = 'suspended', platform_hold = 1, hold_reason = ? WHERE agency_id = ?`, [reason, id]);
  await pool.query(`UPDATE support_sessions SET revoked_at = UTC_TIMESTAMP(), revoked_by = ? WHERE agency_id = ? AND revoked_at IS NULL`, [req.platform!.userId, id]).catch(() => {});
  await bev(id, 'platform_suspended', reason, req.platform!.userId); await audit(req, 'suspend', id, null, reason, { before, after: subState(await getSub(id)) });
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
  const paid = s.stripe_subscription_id || s.is_manual; const before = subState(s);
  await pool.query(`UPDATE subscriptions SET platform_hold = 0, hold_reason = NULL, status = ?, grace_until = ?, trial_ends_at = IF(? = 'trialing', ?, trial_ends_at) WHERE agency_id = ?`,
    [paid ? 'active' : 'trialing', null, paid ? 'active' : 'trialing', sqlTime(new Date(Date.now() + 7 * 86400_000)), id]);
  await bev(id, 'platform_reactivated', reason, req.platform!.userId); await audit(req, 'reactivate', id, paid ? 'active' : 'trialing +7d', reason, { before, after: subState(await getSub(id)) });
}

/* ------------------------------------------------------------------ support sessions: read-only, time-boxed, visible to the customer */
export async function startSupportSession(req: Request, id: number, reasonIn: unknown, minutes = 30) {
  const reason = needReason(reasonIn), a = await agencyOrThrow(id), mins = Math.min(60, Math.max(5, minutes)), exp = new Date(Date.now() + mins * 60_000);
  const [r]: any = await pool.query('INSERT INTO support_sessions (admin_user_id, agency_id, reason, expires_at) VALUES (?,?,?,?)', [req.platform!.userId, id, reason, sqlTime(exp)]);
  const token = jwt.sign({ sub: req.platform!.userId, sup: r.insertId }, config.jwtSecret, { algorithm: 'HS256', expiresIn: mins * 60 });
  await audit(req, 'support_session_start', id, `session ${r.insertId}, ${mins} min`, reason);
  await sec(id, req.platform!.userId, req.ip, 'support_access_granted', `Platform support (${req.platform!.email}) opened a read-only session for ${mins} min. Reason: ${reason}`);
  const t = new Tenant(id, { userId: null, ip: 'platform' });
  for (const to of await admins(id)) await deliver(t, { kind: 'support_access', to, subject: 'Support accessed your workspace (read-only)', html: `<p>A Travel CRM support engineer opened a <b>read-only</b> session on your workspace for ${mins} minutes.</p><p>Reason: ${reason.replace(/</g, '&lt;')}</p><p>You can end it at any time under Settings → Support access.</p>` });
  return { token, session_id: r.insertId, expires_at: sqlTime(exp), agency: a };
}
export async function revokeSupportSession(req: Request, sessionId: number, reasonIn: unknown) {
  const reason = needReason(reasonIn); const [[s]]: any = await pool.query('SELECT agency_id FROM support_sessions WHERE id = ?', [sessionId]); if (!s) throw new HttpError(404, 'Session not found');
  await pool.query('UPDATE support_sessions SET revoked_at = COALESCE(revoked_at, UTC_TIMESTAMP()), revoked_by = ? WHERE id = ?', [req.platform!.userId, sessionId]); await audit(req, 'support_session_revoke', s.agency_id, `session ${sessionId}`, reason);
}

/* ------------------------------------------------------------------ plans */
export const MODULE_CODES = ['crm', 'ticketing', 'finance', 'accounting', 'insights'] as const;
export type ModuleCode = (typeof MODULE_CODES)[number];
export interface PlanIn { code?: string; name: string; description?: string | null; price_monthly: number; price_yearly: number; currency?: string; trial_days: number; max_seats: number | null; max_branches: number | null; max_bookings_month: number | null; features: string[]; allowed_modules: string[] | null; support_level: string; stripe_price_monthly?: string | null; stripe_price_yearly?: string | null; price_monthly_pkr?: number | null; price_yearly_pkr?: number | null; active: boolean; sort: number }
/** Built-in codes (portal, api …) switch real functionality on. Any other text is a feature the plan advertises; "Parent > Sub" is a sub-feature. */
const checkFeatures = (f: string[]) => {
  const bad = f.filter((x) => !(FEATURES as readonly string[]).includes(x) && !/^[^,<>;|]{1,40}( > [^,<>;|>]{1,40})?$/.test(x) || x !== x.trim());
  if (bad.length) throw new HttpError(400, `Feature names must be 1–40 characters without commas or < > : ${bad.join(' / ')}`);
  if (new Set(f).size !== f.length) throw new HttpError(400, 'A feature is listed twice');
  if (f.join(',').length > 1500) throw new HttpError(400, 'Too many features for one plan');
};
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
    if (b.price_monthly_pkr != null || b.price_yearly_pkr != null) await pool.query('UPDATE plans SET price_monthly_pkr = ?, price_yearly_pkr = ? WHERE id = ?', [b.price_monthly_pkr ?? null, b.price_yearly_pkr ?? null, r.insertId]);
    await audit(req, 'plan_create', null, `${b.code}`); return r.insertId as number; } catch (e: any) { if (e.code === 'ER_DUP_ENTRY') throw new HttpError(409, 'A plan with that code already exists'); throw e; }
}
export async function updatePlan(req: Request, id: number, b: PlanIn, reasonIn: unknown) {
  const reason = needReason(reasonIn); checkFeatures(b.features); checkModules(b.allowed_modules);
  const [[cur]]: any = await pool.query('SELECT * FROM plans WHERE id = ?', [id]); if (!cur) throw new HttpError(404, 'Plan not found');
  const planState = (r: any) => ({ name: r.name, price_monthly: Number(r.price_monthly), price_yearly: Number(r.price_yearly), currency: r.currency, trial_days: r.trial_days, max_seats: r.max_seats, max_branches: r.max_branches, max_bookings_month: r.max_bookings_month, features: String(r.features ?? ''), allowed_modules: r.allowed_modules ?? null, active: !!r.active });
  await pool.query(`UPDATE plans SET name = ?, description = ?, price_monthly = ?, price_yearly = ?, currency = ?, trial_days = ?, max_seats = ?, max_branches = ?, max_bookings_month = ?, features = ?, allowed_modules = ?, support_level = ?, stripe_price_monthly = ?, stripe_price_yearly = ?, active = ?, sort = ? WHERE id = ?`,
    [b.name, b.description ?? null, b.price_monthly, b.price_yearly, (b.currency ?? cur.currency).toUpperCase(), b.trial_days, b.max_seats, b.max_branches, b.max_bookings_month, b.features.join(','), b.allowed_modules ? b.allowed_modules.join(',') : null, b.support_level, b.stripe_price_monthly ?? null, b.stripe_price_yearly ?? null, b.active ? 1 : 0, b.sort, id]);
  if (b.price_monthly_pkr !== undefined || b.price_yearly_pkr !== undefined) await pool.query('UPDATE plans SET price_monthly_pkr = ?, price_yearly_pkr = ? WHERE id = ?', [b.price_monthly_pkr === undefined ? cur.price_monthly_pkr : b.price_monthly_pkr, b.price_yearly_pkr === undefined ? cur.price_yearly_pkr : b.price_yearly_pkr, id]);
  const diff = Object.entries({ currency: (b.currency ?? cur.currency).toUpperCase(), ...(b.price_monthly_pkr !== undefined ? { price_monthly_pkr: b.price_monthly_pkr } : {}), ...(b.price_yearly_pkr !== undefined ? { price_yearly_pkr: b.price_yearly_pkr } : {}), price_monthly: b.price_monthly, price_yearly: b.price_yearly, max_seats: b.max_seats, max_branches: b.max_branches, max_bookings_month: b.max_bookings_month, features: b.features.join(','), allowed_modules: (b.allowed_modules ?? []).join(','), active: b.active ? 1 : 0 }).filter(([k, v]) => String((cur as any)[k] ?? '') !== String(v)).map(([k, v]) => `${k}: ${(cur as any)[k]} → ${v}`).join('; ');
  const [[next]]: any = await pool.query('SELECT * FROM plans WHERE id = ?', [id]);
  await audit(req, 'plan_update', null, `${cur.code}: ${diff || 'no material change'}`, reason, { before: planState(cur), after: planState(next) });
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


/* ---------------------------------------------------------------- operators and agency users, managed from the console */
const ROLES = ['admin', 'finance_manager', 'agent', 'viewer'] as const;

/** Make an existing user an operator, change an operator's role, or (role = null) end their operator access. The user account stays. */
export async function setOperatorRole(req: Request, userId: number, role: OperatorRole | null, reason?: string) {
  if (role !== null && !(role in ROLE_CAPS)) throw new HttpError(400, `Role must be one of ${Object.keys(ROLE_CAPS).join(', ')}`);
  const [[u]]: any = await pool.query('SELECT id, email, name, is_platform_admin, platform_role FROM users WHERE id = ?', [userId]); if (!u) throw new HttpError(404, 'User not found');
  if (u.id === req.platform!.userId) throw new HttpError(409, 'You cannot change your own operator access. Ask another admin operator.');
  if (role === null && !u.is_platform_admin) throw new HttpError(409, 'This user is not an operator');
  if (u.is_platform_admin && u.platform_role === 'admin' && role !== 'admin') {
    const [[n]]: any = await pool.query("SELECT COUNT(*) n FROM users WHERE is_platform_admin = 1 AND platform_role = 'admin' AND id <> ?", [u.id]);
    if (!n.n) throw new HttpError(409, 'This is the last admin operator. Make someone else an admin first.');
  }
  await pool.query('UPDATE users SET is_platform_admin = ?, platform_role = ?, platform_stepup_at = NULL WHERE id = ?', [role ? 1 : 0, role, u.id]);
  await audit(req, role ? (u.is_platform_admin ? 'operator_role_changed' : 'operator_added') : 'operator_revoked', null, `${u.email}: ${u.platform_role ?? 'none'} → ${role ?? 'none'}`, reason, { before: { role: u.platform_role ?? null }, after: { role } });
  return { email: u.email, role };
}
export async function addOperator(req: Request, email: string, role: OperatorRole, reason?: string) {
  const [[u]]: any = await pool.query('SELECT id FROM users WHERE email = ?', [email]); if (!u) throw new HttpError(404, 'No user with that email. They must have an account first.');
  return setOperatorRole(req, u.id, role, reason);
}

async function memberOrThrow(agencyId: number, userId: number) {
  const [[m]]: any = await pool.query('SELECT m.id, m.user_id, m.role, u.name, u.email, u.is_platform_admin FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.agency_id = ? AND m.user_id = ?', [agencyId, userId]);
  if (!m) throw new HttpError(404, 'That user is not in this agency'); return m;
}
const actingTenant = (req: Request, agencyId: number) => new Tenant(agencyId, { userId: req.platform!.userId, ip: req.ip, role: 'support' });

/** Edit a person inside one agency: their name and sign-in email (on the account), and their role in this agency. */
export async function editAgencyUser(req: Request, agencyId: number, userId: number, patch: { name?: string; email?: string; role?: (typeof ROLES)[number] }, reason?: string) {
  await agencyOrThrow(agencyId); const m = await memberOrThrow(agencyId, userId);
  if (patch.email && patch.email !== m.email) {
    const [[dup]]: any = await pool.query('SELECT id FROM users WHERE email = ? AND id <> ?', [patch.email, userId]); if (dup) throw new HttpError(409, 'Another account already uses that email');
  }
  if (patch.role && patch.role !== m.role) await changeMember(actingTenant(req, agencyId), m.id, { role: patch.role }, req.platform!.userId);
  const acct: Record<string, string> = {}; if (patch.name && patch.name !== m.name) acct.name = patch.name; if (patch.email && patch.email !== m.email) acct.email = patch.email;
  if (Object.keys(acct).length) await pool.query(`UPDATE users SET ${Object.keys(acct).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...Object.values(acct), userId]);
  await audit(req, 'agency_user_edit', agencyId, `${m.email}: ${[patch.role && patch.role !== m.role ? `role ${m.role} → ${patch.role}` : '', acct.name ? `name → ${acct.name}` : '', acct.email ? `email → ${acct.email}` : ''].filter(Boolean).join('; ') || 'no change'}`, reason,
    { before: { role: m.role, name: m.name, email: m.email }, after: { role: patch.role ?? m.role, name: acct.name ?? m.name, email: acct.email ?? m.email } });
}
export async function agencyUserWorkload(agencyId: number, userId: number) { await memberOrThrow(agencyId, userId); return memberWorkload(new Tenant(agencyId, { userId: 0 }), userId); }

/** Remove a person from an agency (access ends at once; work can be handed to someone else). With deleteAccount, also delete their account when nothing else depends on it. */
export async function removeAgencyUser(req: Request, agencyId: number, userId: number, o: { reassignTo?: number | null; deleteAccount?: boolean; reason?: string }) {
  await agencyOrThrow(agencyId); const m = await memberOrThrow(agencyId, userId);
  const out: any = await removeMember(actingTenant(req, agencyId), m.id, req.platform!.userId, o.reassignTo);
  let account = 'kept';
  if (o.deleteAccount) {
    const [[other]]: any = await pool.query('SELECT COUNT(*) n FROM memberships WHERE user_id = ?', [userId]);
    if (m.is_platform_admin) account = 'kept: operator account';
    else if (other.n) account = 'kept: belongs to other agencies';
    else try { await pool.query('DELETE FROM users WHERE id = ?', [userId]); account = 'deleted'; } catch (e: any) { if (e.code === 'ER_ROW_IS_REFERENCED_2' || e.errno === 1451) account = 'kept: has history in the books'; else throw e; }
  }
  await audit(req, 'agency_user_remove', agencyId, `${m.email} (${m.role}) removed; account ${account}`, o.reason, { before: { role: m.role, email: m.email }, after: { removed: true, account } });
  return { ...out, account };
}


/* ------------------------------------------------------------------ user directory (every account on the platform) */
export const USER_FILTERS = ['all', 'operators', 'no2fa', 'disabled', 'multi', 'owners'] as const;
const USER_SIZE = 25;

/** Every account across every agency. Filters answer the questions operators actually ask: who has no 2FA, who is switched off, who works for several agencies. */
export async function listUsers(q: { q?: string; filter?: string; page?: number }) {
  const where: string[] = ['1 = 1'], p: any[] = [], page = Math.max(1, q.page ?? 1);
  const s = (q.q ?? '').trim().replace(/[%_]/g, '');
  if (s) { where.push('(u.name LIKE ? OR u.email LIKE ? OR EXISTS (SELECT 1 FROM memberships m JOIN agencies a ON a.id = m.agency_id WHERE m.user_id = u.id AND a.name LIKE ?))'); p.push(`%${s}%`, `%${s}%`, `%${s}%`); }
  const f = q.filter ?? 'all';
  if (f === 'operators') where.push('u.is_platform_admin = 1');
  else if (f === 'no2fa') where.push('u.totp_enabled = 0');
  else if (f === 'disabled') where.push('u.disabled_at IS NOT NULL');
  else if (f === 'multi') where.push('(SELECT COUNT(*) FROM memberships m WHERE m.user_id = u.id) > 1');
  else if (f === 'owners') where.push("EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = u.id AND m.role = 'admin')");
  const w = where.join(' AND ');
  const [[tot]]: any = await pool.query(`SELECT COUNT(*) n FROM users u WHERE ${w}`, p);
  const [rows]: any = await pool.query(`SELECT u.id, u.name, u.email, u.totp_enabled, u.totp_required, u.is_platform_admin, u.platform_role, u.disabled_at, u.created_at,
      (SELECT MAX(t.created_at) FROM refresh_tokens t WHERE t.user_id = u.id) last_seen FROM users u WHERE ${w} ORDER BY u.created_at DESC, u.id DESC LIMIT ? OFFSET ?`, [...p, USER_SIZE, (page - 1) * USER_SIZE]);
  const ids = rows.map((r: any) => r.id);
  const [ms]: any = ids.length ? await pool.query('SELECT m.user_id, m.agency_id, a.name agency_name, m.role FROM memberships m JOIN agencies a ON a.id = m.agency_id WHERE m.user_id IN (?) ORDER BY a.name', [ids]) : [[]];
  const [[c]]: any = await pool.query('SELECT COUNT(*) users, SUM(totp_enabled = 0) no2fa, SUM(disabled_at IS NOT NULL) disabled, SUM(is_platform_admin = 1) operators FROM users');
  return { rows: rows.map((r: any) => ({ ...r, memberships: ms.filter((m: any) => m.user_id === r.id) })), total: tot.n, page, page_size: USER_SIZE,
    counts: { users: Number(c.users), no2fa: Number(c.no2fa ?? 0), disabled: Number(c.disabled ?? 0), operators: Number(c.operators ?? 0) } };
}

async function userOrThrow(id: number) {
  const [[u]]: any = await pool.query('SELECT id, name, email, totp_enabled, totp_required, is_platform_admin, platform_role, disabled_at, disabled_reason, created_at FROM users WHERE id = ?', [id]);
  if (!u) throw new HttpError(404, 'User not found'); return u;
}
const revokeSessions = async (userId: number) => ((await pool.query('UPDATE refresh_tokens SET revoked = 1, revoked_at = COALESCE(revoked_at, UTC_TIMESTAMP()) WHERE user_id = ? AND revoked = 0', [userId])) as any)[0].affectedRows as number;
const notSelf = (req: Request, id: number, what: string) => { if (id === req.platform!.userId) throw new HttpError(409, `You cannot ${what} your own account. Ask another admin operator.`); };

export async function userDetail(id: number) {
  const u = await userOrThrow(id);
  const [memberships]: any = await pool.query('SELECT m.agency_id, a.name agency_name, m.role, m.branch_id FROM memberships m JOIN agencies a ON a.id = m.agency_id WHERE m.user_id = ? ORDER BY a.name', [id]);
  const [[seen]]: any = await pool.query('SELECT MAX(created_at) last_seen, SUM(revoked = 0 AND expires_at > UTC_TIMESTAMP()) live FROM refresh_tokens WHERE user_id = ?', [id]);
  const [events]: any = await pool.query('SELECT event, detail, ip, created_at FROM security_events WHERE user_id = ? ORDER BY id DESC LIMIT 15', [id]);
  const [[reset]]: any = await pool.query('SELECT COUNT(*) n FROM password_resets WHERE user_id = ? AND used_at IS NULL AND expires_at > UTC_TIMESTAMP()', [id]);
  return { user: u, memberships, last_seen: seen.last_seen, live_sessions: Number(seen.live ?? 0), events, reset_pending: reset.n > 0 };
}

/** Clears 2FA for someone who lost their device, and signs them out. They must set it up again (operators cannot use the console until they do). */
export async function resetUserTwoFactor(req: Request, id: number, reason: string) {
  notSelf(req, id, 'reset 2FA on'); const u = await userOrThrow(id);
  if (!u.totp_enabled) throw new HttpError(409, 'This user has not turned on 2FA.');
  await pool.query('UPDATE users SET totp_enabled = 0, totp_secret_enc = NULL, totp_last_step = NULL WHERE id = ?', [id]);
  const ended = await revokeSessions(id);
  await audit(req, 'reset_user_2fa', null, `${u.email}: 2FA cleared, ${ended} session(s) ended`, reason, { before: { totp_enabled: true }, after: { totp_enabled: false } });
  return { email: u.email, sessions_ended: ended };
}

export async function signOutUserEverywhere(req: Request, id: number, reason: string) {
  const u = await userOrThrow(id); const ended = await revokeSessions(id);
  await audit(req, 'sign_out_user', null, `${u.email}: ${ended} session(s) ended`, reason);
  return { email: u.email, sessions_ended: ended };
}

/** Switches an account off (sign-in refused, sessions ended) or back on. Nothing is deleted. */
export async function setUserDisabled(req: Request, id: number, disabled: boolean, reason: string) {
  notSelf(req, id, disabled ? 'disable' : 'enable'); const u = await userOrThrow(id);
  if (disabled && u.disabled_at) throw new HttpError(409, 'This account is already disabled.');
  if (!disabled && !u.disabled_at) throw new HttpError(409, 'This account is not disabled.');
  if (disabled && u.is_platform_admin && u.platform_role === 'admin') {
    const [[n]]: any = await pool.query("SELECT COUNT(*) n FROM users WHERE is_platform_admin = 1 AND platform_role = 'admin' AND disabled_at IS NULL AND id <> ?", [id]);
    if (!n.n) throw new HttpError(409, 'This is the last active admin operator. Make someone else an admin first.');
  }
  await pool.query('UPDATE users SET disabled_at = ?, disabled_reason = ? WHERE id = ?', [disabled ? new Date().toISOString().slice(0, 19).replace('T', ' ') : null, disabled ? reason.slice(0, 300) : null, id]);
  const ended = disabled ? await revokeSessions(id) : 0;
  await audit(req, disabled ? 'disable_user' : 'enable_user', null, `${u.email}${disabled ? `: ${ended} session(s) ended` : ''}`, reason);
  return { email: u.email, disabled, sessions_ended: ended };
}

/** Emails the user a one-time password reset link (same link the "forgot password" page sends). Without an email service in development, the link is returned so the operator can pass it on. */
export async function sendUserPasswordReset(req: Request, id: number, reason: string) {
  const u = await userOrThrow(id);
  const [[recent]]: any = await pool.query('SELECT COUNT(*) n FROM password_resets WHERE user_id = ? AND created_at > DATE_SUB(NOW(), INTERVAL 1 HOUR)', [id]);
  if (recent.n >= 3) throw new HttpError(429, 'Three reset links were already sent in the last hour. Try again later.');
  const token = crypto.randomBytes(32).toString('base64url');
  await pool.query('UPDATE password_resets SET used_at = UTC_TIMESTAMP() WHERE user_id = ? AND used_at IS NULL', [id]);
  await pool.query('INSERT INTO password_resets (user_id, token_hash, expires_at, ip) VALUES (?,?,DATE_ADD(UTC_TIMESTAMP(), INTERVAL 30 MINUTE),?)', [id, sha256(token), req.ip ?? null]);
  const link = `${config.appUrl}/reset-password/${token}`;
  void sendMail(u.email, 'Reset your Travel CRM password', `<p>Hi ${String(u.name).replace(/</g, '&lt;')},</p><p>An administrator sent you a link to choose a new password: <a href="${link}">Choose a new password</a>. It works once and expires in 30 minutes.</p>`);
  await audit(req, 'send_user_password_reset', null, u.email, reason);
  return { email: u.email, expires_minutes: 30, ...(!config.isProd && !config.sendgridKey ? { link } : {}) };
}

/** How many people hold each role inside customer agencies, and in how many agencies. */
export async function agencyRoleCounts() {
  const [r]: any = await pool.query('SELECT role, COUNT(*) people, COUNT(DISTINCT agency_id) agencies FROM memberships GROUP BY role');
  return ['admin', 'finance_manager', 'agent', 'viewer'].map((k) => { const x = r.find((y: any) => y.role === k); return { role: k, people: Number(x?.people ?? 0), agencies: Number(x?.agencies ?? 0) }; });
}

/* ------------------------------------------------------------------ operator audit log: search, filter, summarise */
/** Groups of audit actions, so the console can show "what kind of thing is this" and filter by it. Anything not listed counts as "other". */
export const AUDIT_CATEGORIES: Record<string, string[]> = {
  views: ['view_agency', 'view_user'],
  access: ['workspace_access', 'support_session_start', 'support_session_revoke', 'step_up_ok', 'step_up_failed', 'permission_denied'],
  billing: ['set_plan', 'extend_trial', 'grant_manual', 'plan_create', 'plan_update', 'set_ai_access', 'edit_agency', 'agency_create'],
  people: ['operator_added', 'operator_role_changed', 'operator_revoked', 'operator_granted_cli', 'operator_role_set_cli', 'operator_revoked_cli', 'disable_user', 'enable_user', 'reset_user_2fa', 'sign_out_user', 'send_user_password_reset', 'agency_user_edit', 'agency_user_remove'],
  critical: ['suspend', 'suspend_requested', 'suspend_approved', 'suspend_rejected', 'suspend_cancelled', 'reactivate', 'delete_agency'],
};
const categoryOf = (action: string) => Object.entries(AUDIT_CATEGORIES).find(([, a]) => a.includes(action))?.[0] ?? 'other';

export async function listAudit(q: { q?: string; category?: string; operator?: string; from?: string; to?: string; page?: number; size?: number }) {
  const where: string[] = ['1 = 1'], p: any[] = []; const size = Math.min(1000, Math.max(1, q.size ?? 25)), page = Math.max(1, q.page ?? 1);
  const s = (q.q ?? '').trim().replace(/[%_]/g, '');
  if (s) { where.push('(a.action LIKE ? OR a.detail LIKE ? OR a.reason LIKE ? OR ag.name LIKE ? OR u.email LIKE ?)'); p.push(...Array(5).fill(`%${s}%`)); }
  if (q.operator) { where.push('u.email = ?'); p.push(q.operator); }
  if (q.from) { where.push('a.created_at >= ?'); p.push(`${q.from} 00:00:00`); }
  if (q.to) { where.push('a.created_at < DATE_ADD(?, INTERVAL 1 DAY)'); p.push(q.to); }
  const base = `FROM platform_audit_log a JOIN users u ON u.id = a.admin_user_id LEFT JOIN agencies ag ON ag.id = a.agency_id`;
  const [byAction]: any = await pool.query(`SELECT a.action, COUNT(*) n ${base} WHERE ${where.join(' AND ')} GROUP BY a.action`, p);   // tiles ignore the category chosen, so they can be used to switch between categories
  const summary: Record<string, number> = { all: 0, views: 0, access: 0, billing: 0, people: 0, critical: 0, other: 0 };
  for (const r of byAction) { const c = categoryOf(r.action); summary[c] += Number(r.n); summary.all += Number(r.n); }
  if (q.category && q.category !== 'all') {
    const known = AUDIT_CATEGORIES[q.category];
    if (known) { where.push(`a.action IN (${known.map(() => '?').join(',')})`); p.push(...known); }
    else if (q.category === 'other') { const all = Object.values(AUDIT_CATEGORIES).flat(); where.push(`a.action NOT IN (${all.map(() => '?').join(',')})`); p.push(...all); }
  }
  const w = where.join(' AND ');
  const [[tot]]: any = await pool.query(`SELECT COUNT(*) n ${base} WHERE ${w}`, p);
  const [rows]: any = await pool.query(`SELECT a.id, a.action, a.agency_id, ag.name agency_name, a.detail, a.reason, a.ip, a.user_agent, a.created_at, a.actor_role, a.before_json, a.after_json, u.email admin_email, u.name admin_name ${base} WHERE ${w} ORDER BY a.id DESC LIMIT ? OFFSET ?`, [...p, size, (page - 1) * size]);
  const [ops]: any = await pool.query('SELECT DISTINCT u.email FROM platform_audit_log a JOIN users u ON u.id = a.admin_user_id ORDER BY u.email');
  return { rows: rows.map((r: any) => ({ ...r, category: categoryOf(r.action) })), total: tot.n, page, page_size: size, summary, operators: ops.map((o: any) => o.email) };
}

/* ------------------------------------------------------------------ security events across every agency */
/** What kind of event this is. "blocked" events are someone trying something they may not do, which is what an operator wants to spot first. */
export const SECURITY_CATEGORIES: Record<string, string[]> = {
  blocked: ['role_denied', 'agency_access_denied', 'foreign_reference_denied'],
  sensitive: ['sensitive_view'],
  support: ['support_access_granted', 'support_access_revoked'],
  recovery: ['password_reset_requested', 'password_reset_completed'],
  platform: ['platform_suspended'],
};
const secCategory = (e: string) => Object.entries(SECURITY_CATEGORIES).find(([, a]) => a.includes(e))?.[0] ?? 'other';
/** Trying to reach another agency's data is the serious one; being refused an action inside your own agency is routine. */
const secSeverity = (e: string) => (['agency_access_denied', 'foreign_reference_denied'].includes(e) ? 'high' : ['role_denied', 'platform_suspended', 'sensitive_view'].includes(e) ? 'medium' : 'info');

export async function listSecurityEvents(q: { q?: string; category?: string; from?: string; to?: string; page?: number; size?: number }) {
  const where: string[] = ['1 = 1'], p: any[] = []; const size = Math.min(1000, Math.max(1, q.size ?? 25)), page = Math.max(1, q.page ?? 1);
  const s = (q.q ?? '').trim().replace(/[%_]/g, '');
  if (s) { where.push('(e.event LIKE ? OR e.detail LIKE ? OR e.ip LIKE ? OR ag.name LIKE ? OR u.email LIKE ? OR u.name LIKE ?)'); p.push(...Array(6).fill(`%${s}%`)); }
  if (q.from) { where.push('e.created_at >= ?'); p.push(`${q.from} 00:00:00`); }
  if (q.to) { where.push('e.created_at < DATE_ADD(?, INTERVAL 1 DAY)'); p.push(q.to); }
  const base = 'FROM security_events e LEFT JOIN agencies ag ON ag.id = e.agency_id LEFT JOIN users u ON u.id = e.user_id';
  const [byEvent]: any = await pool.query(`SELECT e.event, COUNT(*) n ${base} WHERE ${where.join(' AND ')} GROUP BY e.event`, p);
  const summary: Record<string, number> = { all: 0, blocked: 0, sensitive: 0, support: 0, recovery: 0, platform: 0, other: 0 };
  for (const r of byEvent) { const c = secCategory(r.event); summary[c] += Number(r.n); summary.all += Number(r.n); }
  const blocked = SECURITY_CATEGORIES.blocked;
  const [hot]: any = await pool.query(`SELECT u.id, u.name, u.email, ag.name agency_name, COUNT(*) n, MAX(e.created_at) last_at ${base} WHERE ${where.join(' AND ')} AND e.event IN (${blocked.map(() => '?').join(',')}) AND e.user_id IS NOT NULL GROUP BY u.id, u.name, u.email, ag.name ORDER BY n DESC, last_at DESC LIMIT 5`, [...p, ...blocked]);
  const [trend]: any = await pool.query("SELECT DATE_FORMAT(created_at, '%Y-%m-%d') d, SUM(event IN (?)) blocked, COUNT(*) n FROM security_events WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 13 DAY) GROUP BY d ORDER BY d", [blocked]);
  if (q.category && q.category !== 'all') {
    const known = SECURITY_CATEGORIES[q.category];
    if (known) { where.push(`e.event IN (${known.map(() => '?').join(',')})`); p.push(...known); }
    else if (q.category === 'other') { const all = Object.values(SECURITY_CATEGORIES).flat(); where.push(`e.event NOT IN (${all.map(() => '?').join(',')})`); p.push(...all); }
  }
  const w = where.join(' AND ');
  const [[tot]]: any = await pool.query(`SELECT COUNT(*) n ${base} WHERE ${w}`, p);
  const [rows]: any = await pool.query(`SELECT e.id, e.agency_id, ag.name agency_name, e.user_id, u.name user_name, u.email user_email, e.event, e.detail, e.ip, e.created_at ${base} WHERE ${w} ORDER BY e.id DESC LIMIT ? OFFSET ?`, [...p, size, (page - 1) * size]);
  return { rows: rows.map((r: any) => ({ ...r, category: secCategory(r.event), severity: secSeverity(r.event) })), total: tot.n, page, page_size: size, summary,
    attention: hot.map((h: any) => ({ ...h, n: Number(h.n) })), trend: trend.map((t: any) => ({ day: t.d, total: Number(t.n), blocked: Number(t.blocked ?? 0) })) };
}


/* ------------------------------------------------------------------ system status page */
/** Everything an operator wants to know about the running platform. Only yes/no and numbers: no keys, addresses or credentials ever leave here. */
export async function systemStatus() {
  const t0 = Date.now(); const h = await health(); const dbMs = Date.now() - t0;
  let sizeMb: number | null = null, agencies = 0, users = 0, backlog = 0, dead = 0, failedMail = 0, critical = 0;
  if (h.checks.database === 'ok') {
    const [[sz]]: any = await pool.query('SELECT ROUND(SUM(data_length + index_length) / 1048576, 1) mb FROM information_schema.tables WHERE table_schema = DATABASE()'); sizeMb = Number(sz?.mb ?? 0);
    agencies = ((await pool.query('SELECT COUNT(*) n FROM agencies')) as any)[0][0].n; users = ((await pool.query('SELECT COUNT(*) n FROM users')) as any)[0][0].n;
    const [[w]]: any = await pool.query("SELECT COALESCE(SUM(status IN ('pending','failed')), 0) backlog, COALESCE(SUM(status = 'dead'), 0) dead FROM webhook_deliveries"); backlog = Number(w.backlog); dead = Number(w.dead);
    failedMail = ((await pool.query("SELECT COUNT(*) n FROM delivery_log WHERE status = 'failed' AND created_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)")) as any)[0][0].n;
    critical = ((await pool.query("SELECT COUNT(*) n FROM exceptions WHERE status = 'open' AND severity = 'critical'")) as any)[0][0].n;
  }
  const mem = process.memoryUsage(), c = counters, total = c.total;
  return {
    health: h, checked_at: new Date().toISOString(),
    process: { uptime_s: Math.round((Date.now() - c.startedAt) / 1000), started_at: new Date(c.startedAt).toISOString(), node: process.version, env: config.isProd ? 'production' : process.env.NODE_ENV ?? 'development', rss_mb: Math.round(mem.rss / 1048576), heap_mb: Math.round(mem.heapUsed / 1048576) },
    database: { latency_ms: dbMs, size_mb: sizeMb, agencies, users, migrations: h.checks.migrations ?? null },
    traffic: { total, by_class: c.byClass, avg_ms: total ? Math.round(c.sumMs / total) : 0, error_rate: total ? Math.round(((c.byClass['5xx'] ?? 0) / total) * 1000) / 10 : 0, latency: c.ms },
    queues: { webhook_backlog: backlog, webhook_dead: dead, failed_emails_24h: failedMail, critical_exceptions: critical },
    integrations: {
      email: !!config.sendgridKey, storage: !!(config.r2.bucket && config.r2.accessKeyId), payments: !!config.stripeKey, payments_webhook: !!config.stripeWebhookSecret,
      ai: !!(await resolveAi()).key, exchange_rates: !!config.oxrAppId, cache: !!config.redisUrl,
    },
  };
}

/** An operator creates a sign-in account. It can be made an operator at once; agency access is given from the agency's own Team page. */
export async function createUserByOperator(req: Request, b: { name: string; email: string; password: string; operator_role?: OperatorRole | null }, reason: string) {
  const email = b.email.trim().toLowerCase();
  if (b.operator_role && !(b.operator_role in ROLE_CAPS)) throw new HttpError(400, `Role must be one of ${Object.keys(ROLE_CAPS).join(', ')}`);
  const [[dup]]: any = await pool.query('SELECT id FROM users WHERE email = ?', [email]); if (dup) throw new HttpError(409, 'An account with that email already exists. Find them under People instead.');
  const { default: bcrypt } = await import('bcryptjs');
  const [r]: any = await pool.query('INSERT INTO users (email, name, password_hash, is_platform_admin, platform_role) VALUES (?,?,?,?,?)', [email, b.name.trim(), await bcrypt.hash(b.password, 12), b.operator_role ? 1 : 0, b.operator_role ?? null]);
  await audit(req, b.operator_role ? 'operator_created' : 'user_created', null, `${email}${b.operator_role ? ` as ${b.operator_role} operator` : ''}`, reason, { after: { email, name: b.name.trim(), operator_role: b.operator_role ?? null } });
  return { id: r.insertId, email };
}

/** Change a person's name or sign-in email. Their email is the same login for every agency they work for. */
export async function editUserByOperator(req: Request, id: number, patch: { name?: string; email?: string }, reason: string) {
  const u = await userOrThrow(id); const acct: Record<string, string> = {};
  if (patch.name && patch.name.trim() !== u.name) acct.name = patch.name.trim();
  if (patch.email && patch.email.trim().toLowerCase() !== u.email) {
    const email = patch.email.trim().toLowerCase(); const [[dup]]: any = await pool.query('SELECT id FROM users WHERE email = ? AND id <> ?', [email, id]); if (dup) throw new HttpError(409, 'Another account already uses that email');
    acct.email = email;
  }
  if (!Object.keys(acct).length) throw new HttpError(400, 'Nothing was changed.');
  await pool.query(`UPDATE users SET ${Object.keys(acct).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...Object.values(acct), id]);
  if (acct.email) await revokeSessions(id);   // a new login address means signing in again
  await audit(req, 'edit_user', null, `${u.email}: ${[acct.name ? `name → ${acct.name}` : '', acct.email ? `email → ${acct.email}` : ''].filter(Boolean).join('; ')}`, reason, { before: { name: u.name, email: u.email }, after: { name: acct.name ?? u.name, email: acct.email ?? u.email } });
  return { email: acct.email ?? u.email };
}

/** Delete an account for good. Only when it works for no agency and holds no operator access; one with history in the books is switched off instead. */
export async function deleteUserByOperator(req: Request, id: number, reason: string) {
  notSelf(req, id, 'delete'); const u = await userOrThrow(id);
  if (u.is_platform_admin) throw new HttpError(409, 'This person is an operator. Remove their operator access first (Operators tab).');
  const [[m]]: any = await pool.query('SELECT COUNT(*) n FROM memberships WHERE user_id = ?', [id]);
  if (m.n) throw new HttpError(409, `${u.name} still works for ${m.n} agenc${m.n === 1 ? 'y' : 'ies'}. Remove them from there first (Agencies → People), or switch the account off instead.`);
  try {
    await pool.query('DELETE FROM refresh_tokens WHERE user_id = ?', [id]); await pool.query('DELETE FROM password_resets WHERE user_id = ?', [id]);
    await pool.query('DELETE FROM users WHERE id = ?', [id]);
  } catch (e: any) { if (e.code === 'ER_ROW_IS_REFERENCED_2' || e.errno === 1451) throw new HttpError(409, 'This account has history in the books, so it cannot be deleted. Switch it off instead.'); throw e; }
  await audit(req, 'delete_user', null, u.email, reason, { before: { name: u.name, email: u.email } });
  return { email: u.email };
}

/** An operator sets someone's password directly (for a person who cannot use the reset email). They are signed out everywhere and must use the new password. */
export async function setUserPasswordByOperator(req: Request, id: number, password: string, reason: string) {
  notSelf(req, id, 'set the password of'); const u = await userOrThrow(id);
  const r = await setPasswordFor(id, password, 'A platform administrator');
  await audit(req, 'set_user_password', null, `${u.email}: password set, ${r.sessions_ended} session(s) ended`, reason);
  return { email: u.email, sessions_ended: r.sessions_ended };
}


/* ------------------------------------------------------------------ AI provider (which service, key and model; set from the console, kept encrypted) */
export async function aiKeyInfo() {
  const r = await resolveAi(); const env = process.env;
  return { configured: !!r.key, source: r.source, provider: r.provider, model: r.model, base_url: r.baseUrl, hint: r.hint, updated_at: r.updated_at, updated_by: r.updated_by, environment_key: !!(config.anthropicKey || config.openaiKey || env.AI_PROVIDER),
    providers: PROVIDERS.map((p) => ({ key: p, label: PROVIDER_LABEL[p], default_model: DEFAULT_MODELS[p] })) };
}

const KEY_SHAPE: Record<AiProvider, [RegExp, string]> = {
  anthropic: [/^sk-ant-[A-Za-z0-9_-]{20,300}$/, 'That does not look like an Anthropic key. It starts with sk-ant- and has no spaces.'],
  openai: [/^sk-(?!ant-)[A-Za-z0-9_-]{20,300}$/, 'That does not look like an OpenAI key. It starts with sk- and has no spaces.'],
  compatible: [/^\S{8,400}$/, 'The key must be at least 8 characters with no spaces.'],
};
/** Saves the provider, model and key an operator entered, but only after one real request proves they work. The key is never returned, logged or audited: only its last four characters. */
export async function setAiKey(req: Request, b: { provider?: string; api_key: string; model?: string | null; base_url?: string | null }, reasonIn: unknown) {
  const reason = needReason(reasonIn), k = b.api_key.trim(), provider = (b.provider ?? 'anthropic') as AiProvider;
  if (!PROVIDERS.includes(provider)) throw new HttpError(400, 'Choose Anthropic, OpenAI or an OpenAI-compatible service.');
  if (!KEY_SHAPE[provider][0].test(k)) throw new HttpError(400, KEY_SHAPE[provider][1]);
  const model = (b.model ?? '').trim() || DEFAULT_MODELS[provider]; if (!model) throw new HttpError(400, 'Enter the model name to use, for example gemini-2.0-flash.');
  if (!/^[A-Za-z0-9._:\/-]{1,100}$/.test(model)) throw new HttpError(400, 'The model name has characters it should not.');
  let baseUrl: string | null = null;
  if (provider === 'compatible') { if (!b.base_url?.trim()) throw new HttpError(400, 'Enter the service address, for example https://api.groq.com/openai/v1'); baseUrl = checkBaseUrl(b.base_url); }
  try { await llm.verify({ provider, key: k, model, baseUrl }); }
  catch (e: any) { throw new HttpError(400, e?.message === 'rejected' ? 'The service rejected that key. Check that you copied all of it and that it is active.' : e?.message === 'model' ? `The service does not know the model “${model}”. Check the name.` : 'Could not reach the service to check the key, so nothing was saved. Try again in a moment.'); }
  const hint = k.slice(-4); const put = (name: string, v: string | null, h: string | null = null) => v === null ? pool.query('DELETE FROM platform_settings WHERE k = ?', [name]) : pool.query('INSERT INTO platform_settings (k, v_enc, hint, updated_by) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE v_enc = VALUES(v_enc), hint = VALUES(hint), updated_by = VALUES(updated_by)', [name, encrypt(v), h, req.platform!.userId]);
  await put('ai_provider', provider); await put('ai_model', model); await put('ai_base_url', baseUrl); await put('ai_api_key', k, hint);
  dropAiKeyCache(); await audit(req, 'set_ai_key', null, `AI provider set: ${provider}, model ${model}, key ends ${hint}`, reason);
  return aiKeyInfo();
}
export async function removeAiKey(req: Request, reasonIn: unknown) {
  const reason = needReason(reasonIn); const [r]: any = await pool.query("DELETE FROM platform_settings WHERE k IN ('ai_api_key', 'ai_provider', 'ai_model', 'ai_base_url')");
  if (!r.affectedRows) throw new HttpError(409, 'Nothing was saved in the console.');
  dropAiKeyCache(); await audit(req, 'remove_ai_key', null, 'AI settings removed from the console', reason);
  return aiKeyInfo();
}


/* ------------------------------------------------------------------ JazzCash / Easypaisa merchant accounts, and settling their payments by hand */
export const localPayInfo = () => LP.info();
const shape = (re: RegExp, msg: string) => (v: unknown) => { const t = String(v ?? '').trim(); if (!re.test(t)) throw new HttpError(400, msg); return t; };
export async function setLocalPay(req: Request, provider: string, b: Record<string, any>, reasonIn: unknown) {
  const reason = needReason(reasonIn); if (!LP.PROVIDERS.includes(provider as LP.Provider)) throw new HttpError(404, 'Unknown payment provider');
  if (provider === 'jazzcash') {
    const c: LP.JazzConfig = { merchant_id: shape(/^[A-Za-z0-9]{4,30}$/, 'The merchant ID is letters and digits only, for example MC12345.')(b.merchant_id), password: shape(/^\S{4,80}$/, 'Enter the merchant password (no spaces).')(b.password),
      integrity_salt: shape(/^\S{6,100}$/, 'Enter the integrity salt (no spaces).')(b.integrity_salt), sandbox: !!b.sandbox };
    await LP.saveConfig('jazzcash', c, req.platform!.userId); await audit(req, 'set_local_pay', null, `JazzCash saved: merchant ${c.merchant_id}, ${c.sandbox ? 'test' : 'live'} mode`, reason);
  } else {
    const key = String(b.hash_key ?? '').trim(); if (![16, 24, 32].includes(Buffer.byteLength(key))) throw new HttpError(400, 'The hash key must be exactly 16 characters (or 24 / 32).');
    const c: LP.EasyConfig = { store_id: shape(/^\d{3,12}$/, 'The store ID is a number, for example 12345.')(b.store_id), hash_key: key, sandbox: !!b.sandbox };
    const inq = [b.account_num, b.username, b.password].map((x) => String(x ?? '').trim());
    if (inq.some(Boolean)) { if (inq.some((x) => !x)) throw new HttpError(400, 'To let us confirm payments with Easypaisa, enter all three: account number, username and password. Or leave all three empty.'); [c.account_num, c.username, c.password] = inq as [string, string, string]; }
    await LP.saveConfig('easypaisa', c, req.platform!.userId); await audit(req, 'set_local_pay', null, `Easypaisa saved: store ${c.store_id}, ${c.sandbox ? 'test' : 'live'} mode, ${c.account_num ? 'with' : 'without'} payment confirmation login`, reason);
  }
  return LP.info();
}
export async function removeLocalPay(req: Request, provider: string, reasonIn: unknown) {
  const reason = needReason(reasonIn); if (!LP.PROVIDERS.includes(provider as LP.Provider)) throw new HttpError(404, 'Unknown payment provider');
  if (!(await LP.removeConfig(provider as LP.Provider))) throw new HttpError(409, 'Nothing was saved for that provider.');
  await audit(req, 'remove_local_pay', null, `${LP.LABEL[provider as LP.Provider]} removed`, reason); return LP.info();
}
export const listLocalPayments = (q: { status?: string; page?: number }) => LP.listAll(q);
/** An operator who has checked the provider's own records can mark a payment received (extends the plan), or mark it failed. */
export async function settleLocalPayment(req: Request, id: number, action: 'confirm' | 'reject', reasonIn: unknown) {
  const reason = needReason(reasonIn), pay = await LP.getPaymentById(id); if (!pay) throw new HttpError(404, 'Payment not found');
  if (pay.status === 'paid') throw new HttpError(409, 'That payment was already received.');
  if (action === 'confirm') { await LP.applyPaid(pay.txn_ref, { code: 'manual', message: reason, by: 'operator', operatorId: req.platform!.userId }); }
  else { if (pay.status === 'failed') throw new HttpError(409, 'That payment is already marked as failed.'); await pool.query("UPDATE local_payments SET status = 'failed', gateway_code = 'manual', gateway_message = ?, confirmed_by = ? WHERE id = ?", [reason.slice(0, 300), req.platform!.userId, id]); }
  await audit(req, action === 'confirm' ? 'local_payment_confirm' : 'local_payment_reject', pay.agency_id, `${LP.LABEL[pay.provider as LP.Provider]} ${pay.txn_ref}, PKR ${pay.amount_pkr}`, reason);
  return { ok: true };
}

/** Turns two-factor sign-in on or off for a person. "On" requires it: they carry on until their next request, then must set up an authenticator before anything else works. "Off" removes their authenticator and the requirement, and signs them out. */
export async function setUserTwoFactor(req: Request, id: number, on: boolean, reason: string) {
  notSelf(req, id, on ? 'require 2FA for' : 'turn off 2FA for'); const u = await userOrThrow(id);
  if (on) {
    if (u.totp_enabled) throw new HttpError(409, 'This person already uses two-factor sign-in.');
    if (u.totp_required) throw new HttpError(409, 'Two-factor sign-in is already required for this person. They have not set it up yet.');
    await pool.query('UPDATE users SET totp_required = 1 WHERE id = ?', [id]);
    await audit(req, 'require_user_2fa', null, `${u.email}: 2FA now required`, reason, { before: { totp_required: false }, after: { totp_required: true } });
    return { email: u.email, required: true, sessions_ended: 0 };
  }
  if (!u.totp_enabled && !u.totp_required) throw new HttpError(409, 'Two-factor sign-in is not on for this person.');
  await pool.query('UPDATE users SET totp_enabled = 0, totp_secret_enc = NULL, totp_last_step = NULL, totp_required = 0 WHERE id = ?', [id]);
  const ended = await revokeSessions(id);
  await audit(req, 'turn_off_user_2fa', null, `${u.email}: 2FA turned off, ${ended} session(s) ended`, reason, { before: { totp_enabled: !!u.totp_enabled, totp_required: !!u.totp_required }, after: { totp_enabled: false, totp_required: false } });
  return { email: u.email, required: false, sessions_ended: ended };
}
