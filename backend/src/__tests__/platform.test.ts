import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authenticator } from 'otplib';
import { Api, PASSWORD, addMember, apiBase, boot, newAgency, shutdown, sql } from './helpers.js';
import { applyBillingEvent } from '../services/billing.js';
import { OperatorRole, setPlatformAdmin } from '../services/platform.js';

let base: string; const rnd = () => Math.random().toString(36).slice(2, 7);
const call = async (token: string | null, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); let j: any; try { j = JSON.parse(t); } catch { j = t; } return { status: r.status, body: j };
};
/** a real user, flagged as operator the way the CLI does, with 2FA enabled */
async function operator(opts: { twofa?: boolean; role?: OperatorRole } = {}) {
  const email = `op-${rnd()}@platform.test`, r = await call(null, 'POST', '/auth/register', { agencyName: `Ops ${rnd()}`, name: 'Operator', email, password: PASSWORD }), token = r.body.accessToken as string;
  await setPlatformAdmin(email, opts.role ?? 'admin');
  let secret = '';
  if (opts.twofa !== false) { const s = await call(token, 'POST', '/auth/2fa/setup', {}); secret = s.body.secret; await call(token, 'POST', '/auth/2fa/enable', { code: authenticator.generate(secret) }); }
  return { token, email, id: r.body.user.id as number, secret };
};
const sub = async (a: Api) => (await sql('SELECT * FROM subscriptions WHERE agency_id = ?', [a.agencyId]))[0];

let op: { token: string; email: string; id: number; secret: string }, op2: { token: string; email: string; id: number; secret: string }, A: Api, B: Api;
const P = (method: string, path: string, body?: unknown) => call(op.token, method, `/platform${path}`, body);
/** two-person suspension: op requests, op2 approves */
const suspendBoth = async (agencyId: number, reason: string) => { const r = await P('POST', `/agencies/${agencyId}/suspend`, { reason }); expect(r.status).toBe(202); const a = await call(op2.token, 'POST', `/platform/approvals/${r.body.approval_id}/approve`, {}); expect(a.status).toBe(200); return r.body.approval_id as number; };
beforeAll(async () => { await boot(); base = apiBase().replace(/\/api$/, ''); op = await operator(); op2 = await operator(); A = await newAgency('PlatA'); B = await newAgency('PlatB'); });
afterAll(shutdown);

describe('operator access', () => {
  it('is invisible to ordinary users, needs 2FA, rejects support tokens, and cannot be self-granted', async () => {
    expect((await call(null, 'GET', '/platform/overview')).status).toBe(401);
    expect((await call(A.token, 'GET', '/platform/overview')).status).toBe(404);                                  // a normal admin sees "not found", not "forbidden"
    const noTwofa = await operator({ twofa: false }); const r = await call(noTwofa.token, 'GET', '/platform/overview'); expect(r.status).toBe(403); expect(r.body.code).toBe('platform_2fa_required');
    expect((await P('GET', '/overview')).status).toBe(200);
    const self = await call(null, 'POST', '/auth/register', { agencyName: 'Self Grant', name: 'Sam Self', email: `sg-${rnd()}@t.dev`, password: PASSWORD, is_platform_admin: true });
    expect((await call(self.body.accessToken, 'GET', '/platform/overview')).status).toBe(404);                    // extra field ignored; no API path sets the flag
    const sup = (await P('POST', `/agencies/${A.agencyId}/support-session`, { reason: 'Investigating ticket 1234' })).body.token;
    expect((await call(sup, 'GET', '/platform/overview')).status).toBe(403);
    await setPlatformAdmin(noTwofa.email, null); expect((await call(noTwofa.token, 'GET', '/platform/overview')).status).toBe(404);   // revocation is immediate
  });
});

describe('overview and directory', () => {
  it('summarises the fleet, searches and filters agencies, and audits viewing customer details', async () => {
    const before = (await P('GET', '/overview')).body; const C = await newAgency(`PlatSearch${rnd()}`);
    await sql("UPDATE subscriptions SET status = 'active', is_manual = 0, billing_interval = 'monthly' WHERE agency_id = ?", [C.agencyId]);
    const after = (await P('GET', '/overview')).body; expect(after.agencies).toBe(before.agencies + 1); expect(after.mrr - before.mrr).toBeCloseTo(149, 2); expect(after.by_status.active).toBe((before.by_status.active ?? 0) + 1);
    const name = (await sql('SELECT name FROM agencies WHERE id = ?', [C.agencyId]))[0].name;
    const found = (await P('GET', `/agencies?q=${encodeURIComponent(name)}`)).body; expect(found.rows).toHaveLength(1); expect(found.rows[0]).toMatchObject({ id: C.agencyId, status: 'active', plan_code: 'growth', seats: 1 });
    expect((await P('GET', '/agencies?status=active&plan=growth')).body.rows.some((r: any) => r.id === C.agencyId)).toBe(true); expect((await P('GET', '/agencies?plan=starter&q=' + encodeURIComponent(name))).body.rows).toHaveLength(0);
    const d = (await P('GET', `/agencies/${C.agencyId}`)); expect(d.body.members).toHaveLength(1); expect(JSON.stringify(d.body)).not.toMatch(/password|hash|totp_secret/i); expect(d.body.usage).toMatchObject({ seats: 1 });
    expect((await P('GET', '/audit')).body.some((e: any) => e.action === 'view_agency' && e.agency_id === C.agencyId && e.admin_email === op.email)).toBe(true);
    expect((await P('GET', '/agencies/999999')).status).toBe(404);
  });
});

describe('actions on an agency', () => {
  it('every action leaves an audit trail without needing a reason; operator suspension survives payments until released', async () => {
    const X = await newAgency('PlatAct'); const id = X.agencyId;
    const e = await P('POST', `/agencies/${id}/extend-trial`, { days: 10 }); expect(e.status).toBe(200);
    expect((new Date(String((await sub(X)).trial_ends_at).replace(' ', 'T') + 'Z').getTime() - Date.now()) / 86400_000).toBeGreaterThan(23);                 // 14 + 10
    expect((await P('POST', `/agencies/${id}/set-plan`, { plan: 'starter', reason: 'Downgrade requested by phone' })).status).toBe(200); expect((await sub(X)).plan_id).toBeTruthy();
    expect((await P('POST', `/agencies/${id}/grant`, { plan: 'scale', interval: 'yearly', until: '2020-01-01', reason: 'x'.repeat(8) })).status).toBe(400);   // past date
    expect((await P('POST', `/agencies/${id}/grant`, { plan: 'scale', interval: 'yearly', until: '2099-01-01', reason: 'Annual contract signed' })).status).toBe(200); expect(await sub(X)).toMatchObject({ status: 'active', is_manual: 1 });

    await suspendBoth(id, 'Chargeback fraud investigation');
    const w = await X.post('/clients', { name: 'Blocked', currency: 'USD' }); expect(w.status).toBe(402); expect(w.body.code).toBe('subscription_inactive'); expect((await X.get('/clients')).status).toBe(200);
    expect((await X.get('/billing/subscription')).body.banner.message).toMatch(/platform operator.*Chargeback/);
    await sql('UPDATE subscriptions SET stripe_subscription_id = ?, stripe_customer_id = ? WHERE agency_id = ?', [`sub_${rnd()}`, `cus_${rnd()}`, id]);
    await applyBillingEvent({ id: `evt_${rnd()}`, type: 'invoice.paid', data: { object: { id: `in_${rnd()}`, subscription: (await sub(X)).stripe_subscription_id, amount_paid: 100, currency: 'usd' } } });
    expect((await sub(X)).status).toBe('suspended');                                                                                                         // paying does not lift an operator hold
    expect((await P('POST', `/agencies/${id}/reactivate`, { reason: 'Investigation closed, no fraud' })).status).toBe(200); expect((await sub(X)).status).toBe('active'); expect((await X.post('/clients', { name: 'Ok', currency: 'USD' })).status).toBe(201);
    expect((await P('POST', `/agencies/${id}/reactivate`, { reason: 'again again' })).status).toBe(409);
    const actions = (await P('GET', '/audit')).body.filter((a: any) => a.agency_id === id).map((a: any) => a.action); for (const a of ['extend_trial', 'set_plan', 'grant_manual', 'suspend', 'reactivate']) expect(actions).toContain(a);
    expect((await sql("SELECT COUNT(*) n FROM billing_events WHERE agency_id = ? AND kind IN ('platform_suspended','platform_reactivated','trial_extended')", [id]))[0].n).toBe(3);
    expect((await X.get('/admin/security-events')).body.some((e: any) => e.event === 'platform_suspended')).toBe(true);                                       // the customer can see it too
  });
  it('deleting an agency removes every row it owns and its sole-member users, keeps other agencies intact, and keeps the audit trail', async () => {
    const X = await newAgency('PlatDel'), Y = await newAgency('PlatDelKeep'), id = X.agencyId;
    await X.post('/clients', { name: 'Goes With The Agency', currency: 'USD' }); await Y.post('/clients', { name: 'Stays Put', currency: 'USD' });
    expect((await sql('SELECT COUNT(*) n FROM accounts WHERE agency_id = ?', [id]))[0].n).toBeGreaterThan(0);   // registration seeds a chart of accounts
    const r = await P('DELETE', `/agencies/${id}`); expect(r.status).toBe(200);
    for (const [t, col] of [['agencies', 'id'], ['clients', 'agency_id'], ['accounts', 'agency_id'], ['memberships', 'agency_id'], ['subscriptions', 'agency_id']]) expect((await sql(`SELECT COUNT(*) n FROM \`${t}\` WHERE \`${col}\` = ?`, [id]))[0].n, t).toBe(0);
    expect((await sql('SELECT COUNT(*) n FROM users WHERE id = ?', [X.userId]))[0].n).toBe(0);                  // only belonged to the deleted agency
    expect((await Y.get('/clients')).body.some((c: any) => c.name === 'Stays Put')).toBe(true);                   // neighbours untouched
    expect((await sql("SELECT COUNT(*) n FROM platform_audit_log WHERE agency_id = ? AND action = 'delete_agency'", [id]))[0].n).toBe(1);   // evidence survives
    expect((await P('DELETE', `/agencies/${id}`)).status).toBe(404);
  });
  it('agency actions work when the request carries no reason key and deleting works with no request body at all', async () => {
    const X = await newAgency('NoReasonKey');
    expect((await P('POST', `/agencies/${X.agencyId}/extend-trial`, { days: 2 })).status).toBe(200);
    expect((await P('DELETE', `/agencies/${X.agencyId}`)).status).toBe(200);
  });
  it('audit records carry the actor id and role, request metadata and before/after state, with no reason supplied', async () => {
    const X = await newAgency('AuditCtx'), json = (v: any) => (typeof v === 'string' ? JSON.parse(v) : v);
    expect((await P('POST', `/agencies/${X.agencyId}/set-plan`, { plan: 'starter' })).status).toBe(200);
    const row = (await sql("SELECT * FROM platform_audit_log WHERE agency_id = ? AND action = 'set_plan' ORDER BY id DESC LIMIT 1", [X.agencyId]))[0];
    expect(row).toMatchObject({ admin_user_id: op.id, actor_role: 'admin', reason: null }); expect(row.user_agent).toBeTruthy();
    expect(json(row.after_json).plan_id).not.toBe(json(row.before_json).plan_id);
    await X.post('/clients', { name: 'Audited Client', currency: 'USD' });
    const t = (await sql("SELECT * FROM audit_log WHERE agency_id = ? AND entity = 'clients' ORDER BY id DESC LIMIT 1", [X.agencyId]))[0];
    expect(t).toMatchObject({ user_id: X.userId, actor_role: 'admin', action: 'create' }); expect(t.after_json).toBeTruthy();
  });
  it('the operator audit log is append-only', async () => {
    await expect(sql('UPDATE platform_audit_log SET reason = ? WHERE id > 0', ['tamper'])).rejects.toThrow(/append-only/); await expect(sql('DELETE FROM platform_audit_log WHERE id > 0')).rejects.toThrow(/append-only/);
  });
});

describe('support sessions', () => {
  it('are read-only, scoped to one agency, visible to and revocable by the customer, and cannot touch credentials', async () => {
    const X = await newAgency('PlatSup'), Y = await newAgency('PlatSupOther'); const mgr = await addMember(X, 'finance_manager'); await X.post('/clients', { name: 'Seen By Support', currency: 'USD' });
    const s = (await P('POST', `/agencies/${X.agencyId}/support-session`, { reason: 'Customer reported missing invoice', minutes: 20 })).body; expect(s.token).toBeTruthy();
    const sup = (m: string, path: string, agency = X.agencyId, body?: unknown) => call(s.token, m, path, body, { 'x-agency-id': String(agency) });
    const list = await sup('GET', '/clients'); expect(list.status).toBe(200); expect(list.body.some((c: any) => c.name === 'Seen By Support')).toBe(true);
    expect((await sup('POST', '/clients', X.agencyId, { name: 'Nope', currency: 'USD' })).status).toBe(403); expect((await sup('DELETE', '/clients/1')).status).toBe(403);
    expect((await sup('GET', '/clients', Y.agencyId)).status).toBe(401);                                                                                     // different agency: no session
    expect((await sup('GET', '/team')).status).toBe(403);                                                                                                    // viewer-level only
    expect((await call(s.token, 'POST', '/auth/password', { current: PASSWORD, next: 'Hijack#Attempt2026' })).status).toBe(401); expect((await call(s.token, 'POST', '/auth/2fa/setup', {})).status).toBe(401);
    const seen = (await X.get('/admin/security-events')).body; expect(seen.some((e: any) => e.event === 'support_access_granted' && /Customer reported missing invoice/.test(e.detail))).toBe(true);
    const mine = (await X.get('/admin/support-access')).body; expect(mine[0]).toMatchObject({ reason: 'Customer reported missing invoice', operator: op.email }); expect((await mgr.get('/admin/support-access')).status).toBe(403);
    expect((await Y.post(`/admin/support-access/${s.session_id}/revoke`)).status).toBe(404);
    expect((await X.post(`/admin/support-access/${s.session_id}/revoke`)).status).toBe(200); expect((await sup('GET', '/clients')).status).toBe(401);          // the customer ended it
    const s2 = (await P('POST', `/agencies/${X.agencyId}/support-session`, { reason: 'Second look needed here' })).body; await sql("UPDATE support_sessions SET expires_at = '2020-01-01 00:00:00' WHERE id = ?", [s2.session_id]);
    expect((await call(s2.token, 'GET', '/clients', undefined, { 'x-agency-id': String(X.agencyId) })).status).toBe(401);                                    // expired
    const s3 = (await P('POST', `/agencies/${X.agencyId}/support-session`, { reason: 'Third time, then suspended' })).body; await suspendBoth(X.agencyId, 'Abuse report received');
    expect((await call(s3.token, 'GET', '/clients', undefined, { 'x-agency-id': String(X.agencyId) })).status).toBe(401);                                    // suspension also ends support access
    expect((await P('POST', `/support-sessions/${s3.session_id}/revoke`, { reason: 'cleanup now' })).status).toBe(200);
  });
});

describe('plan management', () => {
  it('creates and edits plans without a reason, validates features, and changes take effect for agencies on the plan', async () => {
    const code = `tp-${rnd()}`, body = { code, name: 'Test Plan', description: 'x', price_monthly: 10, price_yearly: 100, trial_days: 7, max_seats: 2, max_branches: 1, max_bookings_month: 5, features: ['portal'], support_level: 'email', active: true, sort: 50 };
    expect((await P('POST', '/plans', { ...body, features: ['bad, name'] })).status).toBe(400); expect((await P('POST', '/plans', { ...body, code: 'Bad Code!' })).status).toBe(400);
    const id = (await P('POST', '/plans', body)).body.id; expect((await P('POST', '/plans', body)).status).toBe(409);
    const T1 = await newAgency('PlatPlan'); await P('POST', `/agencies/${T1.agencyId}/set-plan`, { plan: code, reason: 'Pilot customer plan' });
    expect((await T1.get('/billing/subscription')).body.limits.seats).toBe(2); expect((await T1.get('/automation/rules')).status).toBe(402);
    const u = await P('PUT', `/plans/${id}`, { ...body, max_seats: 9, features: ['portal', 'automation'] }); expect(u.status).toBe(200); expect(u.body.agencies_affected).toBe(1);
    expect((await T1.get('/billing/subscription')).body.limits.seats).toBe(9); expect((await T1.get('/automation/rules')).status).toBe(200);
    const plan = (await P('GET', '/plans')).body.find((p: any) => p.code === code); expect(plan).toMatchObject({ agencies: 1, max_seats: 9 }); expect((await call(A.token, 'GET', '/platform/plans')).status).toBe(404);
    expect((await P('GET', '/audit')).body.find((a: any) => a.action === 'plan_update' && /max_seats: 2 → 9/.test(a.detail))).toBeTruthy();
    expect((await P('GET', '/security-events')).status).toBe(200); expect((await P('GET', '/system')).body.health.ok).toBe(true);
    await sql('UPDATE plans SET active = 0 WHERE id = ?', [id]);   // keep the shared plan list clean for other test files
  });
});

describe('operator roles', () => {
  it('limit what each role can do; denied attempts are audited; roles are visible only to admins', async () => {
    const X = await newAgency('RoleTarget'), id = X.agencyId, results: Record<string, Record<string, number>> = {};
    const attempts: [string, string, string, unknown][] = [['read', 'GET', '/overview', undefined], ['detail', 'GET', `/agencies/${id}`, undefined], ['trial', 'POST', `/agencies/${id}/extend-trial`, { days: 2, reason: 'role matrix test' }],
      ['plan', 'POST', `/agencies/${id}/set-plan`, { plan: 'growth', reason: 'role matrix test' }], ['support', 'POST', `/agencies/${id}/support-session`, { reason: 'role matrix test' }], ['suspend', 'POST', `/agencies/${id}/suspend`, { reason: 'role matrix test' }], ['operators', 'GET', '/operators', undefined]];
    for (const role of ['readonly', 'support', 'billing', 'admin'] as OperatorRole[]) {
      const o = await operator({ role }); results[role] = {};
      for (const [k, m, path, body] of attempts) results[role][k] = (await call(o.token, m, `/platform${path}`, body)).status;
      if (role === 'admin') await call(o.token, 'POST', `/platform/agencies/${id}/reactivate`, { reason: 'release after matrix test' });
    }
    expect(results.readonly).toMatchObject({ read: 200, detail: 200, trial: 403, plan: 403, support: 403, suspend: 403, operators: 403 });
    expect(results.support).toMatchObject({ read: 200, detail: 200, trial: 403, plan: 403, support: 201, suspend: 403, operators: 403 });
    expect(results.billing).toMatchObject({ read: 200, detail: 200, trial: 200, plan: 200, support: 403, suspend: 403, operators: 403 });
    expect(results.admin).toMatchObject({ read: 200, detail: 200, trial: 200, plan: 200, support: 201, suspend: 202, operators: 200 });
    const ro = await operator({ role: 'readonly' }); await call(ro.token, 'POST', `/platform/agencies/${id}/suspend`, { reason: 'probing around' });
    const denied = (await P('GET', '/audit')).body.find((a: any) => a.action === 'permission_denied' && a.admin_email === ro.email); expect(denied.detail).toMatch(/suspend.*role readonly/);
    const body = (await call(ro.token, 'POST', `/platform/agencies/${id}/suspend`, { reason: 'probing around' })).body; expect(body.code).toBe('platform_role_forbidden');
    expect((await call(ro.token, 'GET', '/platform/me')).body).toMatchObject({ role: 'readonly', caps: ['read'] });
    expect((await P('GET', '/operators')).body.map((x: any) => x.role)).toContain('readonly');
  });
  it('are assigned only by the CLI helper, validated, and revocable', async () => {
    const o = await operator({ role: 'support' }); await expect(setPlatformAdmin(o.email, 'god' as any)).rejects.toThrow(/Unknown role/);
    await setPlatformAdmin(o.email, 'readonly'); expect((await call(o.token, 'GET', '/platform/me')).body.role).toBe('readonly');   // takes effect on the next request
    expect((await sql('SELECT detail FROM platform_audit_log WHERE action = ? ORDER BY id DESC LIMIT 1', ['operator_role_set_cli']))[0].detail).toBe('role readonly');
    await setPlatformAdmin(o.email, null); expect((await call(o.token, 'GET', '/platform/me')).status).toBe(404);
  });
});

describe('two-factor sign-in', () => {
  it('an authenticator code can also be used only once at sign-in', async () => {
    const email = `tp-${rnd()}@t.dev`, reg = await call(null, 'POST', '/auth/register', { agencyName: `TP ${rnd()}`, name: 'Totp Person', email, password: PASSWORD }), tok = reg.body.accessToken;
    const s = await call(tok, 'POST', '/auth/2fa/setup', {}); await call(tok, 'POST', '/auth/2fa/enable', { code: authenticator.generate(s.body.secret) });
    const code = authenticator.generate(s.body.secret), login = (c: string) => call(null, 'POST', '/auth/login', { email, password: PASSWORD, totp: c });
    expect((await login(code)).status).toBe(200); expect((await login(code)).status).toBe(401);
  });
});

describe('two-person approval for suspensions', () => {
  it('a suspension takes effect only after a different admin approves; every step is audited', async () => {
    const X = await newAgency('TwoPerson'), id = X.agencyId;
    const req = await P('POST', `/agencies/${id}/suspend`, { reason: 'Suspected account abuse, see ticket 77' }); expect(req.status).toBe(202); expect(req.body.status).toBe('pending');
    expect((await sub(X)).status).toBe('trialing'); expect((await X.post('/clients', { name: 'Still works', currency: 'USD' })).status).toBe(201);          // nothing happened to the customer yet
    expect((await P('POST', `/agencies/${id}/suspend`, { reason: 'duplicate request here' })).status).toBe(409);
    const self = await P('POST', `/approvals/${req.body.approval_id}/approve`, {}); expect(self.status).toBe(403); expect(self.body.code).toBe('self_approval');
    expect((await call(op2.token, 'GET', '/platform/approvals?status=pending')).body.some((a: any) => a.id === req.body.approval_id && a.agency_id === id && a.requested_by_email === op.email)).toBe(true);
    const ok = await call(op2.token, 'POST', `/platform/approvals/${req.body.approval_id}/approve`, { note: 'Evidence reviewed' }); expect(ok.status).toBe(200);
    expect(await sub(X)).toMatchObject({ status: 'suspended', platform_hold: 1 }); expect((await X.post('/clients', { name: 'Blocked', currency: 'USD' })).status).toBe(402);
    expect((await call(op2.token, 'POST', `/platform/approvals/${req.body.approval_id}/approve`, {})).status).toBe(409);                                       // already decided
    const trail = (await P('GET', '/audit')).body.filter((a: any) => a.agency_id === id); const actions = trail.map((a: any) => a.action); for (const a of ['suspend_requested', 'suspend_approved', 'suspend']) expect(actions).toContain(a);
    expect(trail.find((a: any) => a.action === 'suspend_approved').detail).toContain(`requested by ${op.email}, approved by ${op2.email}`);
    expect((await P('GET', '/overview')).body).toHaveProperty('pending_approvals');
  });
  it('can be rejected or cancelled by the requester only; expired requests cannot be approved', async () => {
    const X = await newAgency('TwoPersonRej'), id = X.agencyId; const r1 = (await P('POST', `/agencies/${id}/suspend`, { reason: 'First attempt at suspension' })).body.approval_id;
    expect((await P('POST', `/approvals/${r1}/reject`, { reason: 'my own request' })).status).toBe(403);
    expect((await call(op2.token, 'POST', `/platform/approvals/${r1}/reject`, { reason: 'Not enough evidence yet' })).status).toBe(200); expect((await sub(X)).status).toBe('trialing');
    expect((await call(op2.token, 'GET', '/platform/approvals?status=rejected')).body.find((a: any) => a.id === r1).decision_note).toBe('Not enough evidence yet');
    const r2 = (await P('POST', `/agencies/${id}/suspend`, { reason: 'Second attempt, more evidence' })).body.approval_id;                                       // a rejected request does not block a new one
    expect((await call(op2.token, 'POST', `/platform/approvals/${r2}/cancel`, {})).status).toBe(403); expect((await P('POST', `/approvals/${r2}/cancel`, {})).status).toBe(200);
    expect((await call(op2.token, 'POST', `/platform/approvals/${r2}/approve`, {})).status).toBe(409);
    const r3 = (await P('POST', `/agencies/${id}/suspend`, { reason: 'Third attempt left too long' })).body.approval_id; await sql("UPDATE platform_approvals SET expires_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 HOUR) WHERE id = ?", [r3]);
    const late = await call(op2.token, 'POST', `/platform/approvals/${r3}/approve`, {}); expect(late.status).toBe(409); expect(late.body.error).toMatch(/expired/); expect((await sub(X)).status).toBe('trialing');
  });
  it('is role-limited, and two approvers racing execute it once', async () => {
    const X = await newAgency('TwoPersonRace'), id = X.agencyId, o3 = await operator({ role: 'admin' });
    const billing = await operator({ role: 'billing' }); const ro = await operator({ role: 'readonly' });
    const r = (await P('POST', `/agencies/${id}/suspend`, { reason: 'Race condition check request' })).body.approval_id;
    expect((await call(billing.token, 'POST', `/platform/approvals/${r}/approve`, {})).status).toBe(403); expect((await call(ro.token, 'GET', '/platform/approvals')).status).toBe(403);
    const res = await Promise.all([op2, o3].map((o) => call(o.token, 'POST', `/platform/approvals/${r}/approve`, {}))); expect(res.map((x) => x.status).sort()).toEqual([200, 409]);
    expect((await sql("SELECT COUNT(*) n FROM platform_audit_log WHERE agency_id = ? AND action = 'suspend'", [id]))[0].n).toBe(1);
  });
  it('can be switched off for single-operator installations, and stays refused when no second admin could approve', async () => {
    const { config } = await import('../config.js'); const X = await newAgency('SingleOp'); (config as any).platformTwoPerson = false;
    try { const r = await P('POST', `/agencies/${X.agencyId}/suspend`, { reason: 'Single operator install' }); expect(r.status).toBe(200); expect((await sub(X)).status).toBe('suspended'); } finally { (config as any).platformTwoPerson = true; }
  });
  it('plans can change currency and carry custom features and sub-features', async () => {
    const code = `tc-${rnd()}`, body = { code, name: 'Custom Plan', price_monthly: 10, price_yearly: 100, trial_days: 7, max_seats: 2, max_branches: 1, max_bookings_month: 5, features: ['portal', 'Priority onboarding', 'Reports', 'Reports > Excel export'], support_level: 'email', active: true, sort: 51 };
    const id = (await P('POST', '/plans', body)).body.id; expect(id).toBeTruthy();
    expect((await P('GET', '/plans')).body.find((p: any) => p.code === code)).toMatchObject({ currency: 'USD', features: ['portal', 'Priority onboarding', 'Reports', 'Reports > Excel export'] });
    expect((await P('PUT', `/plans/${id}`, { ...body, features: ['portal', 'portal'] })).status).toBe(400);
    expect((await P('PUT', `/plans/${id}`, { ...body, features: ['A > B > C'] })).status).toBe(400);
    const u = await P('PUT', `/plans/${id}`, { ...body, currency: 'eur', features: ['portal', 'Reports'] }); expect(u.status).toBe(200);
    expect((await P('GET', '/plans')).body.find((p: any) => p.code === code)).toMatchObject({ currency: 'EUR', features: ['portal', 'Reports'] });
    expect((await P('GET', '/audit')).body.find((a: any) => a.action === 'plan_update' && /currency: USD → EUR/.test(a.detail))).toBeTruthy();
    await sql('UPDATE plans SET active = 0 WHERE id = ?', [id]);
  });
});

describe('managing operators and agency users from the console', () => {
  it('admin operators add, change and revoke operators; not themselves, not the last admin, not with a lesser role', async () => {
    const target = await operator({ role: 'readonly' });                                                         // an existing user who is a read-only operator
    const peer = await call(null, 'POST', '/auth/register', { agencyName: `Peer ${rnd()}`, name: 'Peer', email: `peer-${rnd()}@t.dev`, password: PASSWORD });
    expect((await P('POST', '/operators', { email: 'nobody@nowhere.dev', role: 'support' })).status).toBe(404);
    expect((await P('POST', '/operators', { email: 'x@t.dev', role: 'god' })).status).toBe(400);
    expect((await P('POST', '/operators', { email: peer.body.user.email, role: 'support', reason: 'new support lead' })).status).toBe(201);
    expect((await P('GET', '/operators')).body.find((o: any) => o.email === peer.body.user.email)).toMatchObject({ role: 'support' });
    expect((await P('PUT', `/operators/${target.id}`, { role: 'billing' })).status).toBe(200);
    expect((await P('GET', '/operators')).body.find((o: any) => o.id === target.id).role).toBe('billing');
    expect((await P('PUT', `/operators/${op.id}`, { role: 'support' })).status).toBe(409);                      // not your own access
    expect((await P('DELETE', `/operators/${op.id}`)).status).toBe(409);
    expect((await call(target.token, 'PUT', `/platform/operators/${peer.body.user.id}`, { role: 'admin' })).status).toBe(403);   // billing role cannot manage operators
    expect((await P('DELETE', `/operators/${target.id}`, { reason: 'left the company' })).status).toBe(200);
    expect((await call(target.token, 'GET', '/platform/overview')).status).toBe(404);                           // revoked at once
    expect((await P('GET', '/audit')).body.find((a: any) => a.action === 'operator_revoked' && a.detail.includes(target.email))).toBeTruthy();
  });

  it('edits, re-roles and removes people inside an agency, keeping at least one admin', async () => {
    const X = await newAgency('PlatUsers'); const fin = await addMember(X, 'finance_manager'); const agent = await addMember(X, 'agent'); const members = () => P('GET', `/agencies/${X.agencyId}`).then((r) => r.body.members as any[]);
    const m = (await members()).find((x) => x.user_id === agent.userId);
    const lone = (await members()).find((x) => x.user_id === X.userId);
    expect((await P('PUT', `/agencies/${X.agencyId}/users/${agent.userId}`, { role: 'viewer', name: 'Renamed Agent', reason: 'moved to read-only' })).status).toBe(200);
    expect((await members()).find((x) => x.user_id === agent.userId)).toMatchObject({ role: 'viewer', name: 'Renamed Agent' });
    expect((await P('PUT', `/agencies/${X.agencyId}/users/${agent.userId}`, { email: m.email === fin.userId ? 'x@t.dev' : (await members()).find((x) => x.user_id === fin.userId).email })).status).toBe(409);   // email taken
    expect((await P('PUT', `/agencies/${X.agencyId}/users/${X.userId}`, { role: 'viewer' })).status).toBe(409);   // the only admin
    expect((await P('DELETE', `/agencies/${X.agencyId}/users/${X.userId}`)).status).toBe(409);
    expect((await P('PUT', `/agencies/${B.agencyId}/users/${agent.userId}`, { role: 'admin' })).status).toBe(404);   // not their agency
    expect((await P('GET', `/agencies/${X.agencyId}/users/${agent.userId}/workload`)).body).toMatchObject({ leads: 0 });
    expect((await P('DELETE', `/agencies/${X.agencyId}/users/${agent.userId}`, { delete_account: true })).body.account).toBe('kept: has history in the books');   // a user who appears in the books keeps their account
    expect((await members()).some((x) => x.user_id === agent.userId)).toBe(false);                              // but access ended
    const fresh = (await sql("INSERT INTO users (email, name, password_hash) VALUES (?, 'Fresh', 'x')", [`fresh-${rnd()}@t.dev`]) as any).insertId; await sql("INSERT INTO memberships (agency_id, user_id, role) VALUES (?, ?, 'viewer')", [X.agencyId, fresh]);
    const gone = await P('DELETE', `/agencies/${X.agencyId}/users/${fresh}`, { delete_account: true, reason: 'left' }); expect(gone.status).toBe(200); expect(gone.body.account).toBe('deleted');
    expect((await sql('SELECT id FROM users WHERE id = ?', [fresh]))).toHaveLength(0);
    const kept = await P('DELETE', `/agencies/${X.agencyId}/users/${fin.userId}`); expect(kept.status).toBe(200); expect(kept.body.account).toBe('kept');
    expect((await sql('SELECT id FROM users WHERE id = ?', [fin.userId]))).toHaveLength(1);
    expect(lone).toBeTruthy();
    expect((await P('GET', '/audit')).body.find((a: any) => a.action === 'agency_user_remove')).toBeTruthy();
    expect((await call(A.token, 'PUT', `/platform/agencies/${X.agencyId}/users/${X.userId}`, { role: 'agent' })).status).toBe(404);   // agency admins cannot use the console
  });
});
