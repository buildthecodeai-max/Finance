import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authenticator } from 'otplib';
import { PASSWORD, apiBase, boot, shutdown, sql } from './helpers.js';
import { OperatorRole, setPlatformAdmin } from '../services/platform.js';
import { llm } from '../services/ai.js';
import { dropAiKeyCache } from '../services/aiKey.js';
import { vi } from 'vitest';

let base: string; const rnd = () => Math.random().toString(36).slice(2, 7);
const call = async (token: string | null, method: string, path: string, body?: unknown, cookie?: string) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); let j: any; try { j = JSON.parse(t); } catch { j = t; } return { status: r.status, body: j, cookie: (r.headers.get('set-cookie') ?? '').split(';')[0] };
};
/** a person with their own agency and a real login */
async function person(label = 'Pat') {
  const email = `${label.toLowerCase()}-${rnd()}@users.test`, r = await call(null, 'POST', '/auth/register', { agencyName: `${label} Travel ${rnd()}`, name: label, email, password: PASSWORD });
  return { email, token: r.body.accessToken as string, id: r.body.user.id as number, agencyId: r.body.agencies[0].id as number, cookie: r.cookie };
}
async function operator(role: OperatorRole = 'admin') {
  const p = await person('Op'); await setPlatformAdmin(p.email, role);
  const s = await call(p.token, 'POST', '/auth/2fa/setup', {}); await call(p.token, 'POST', '/auth/2fa/enable', { code: authenticator.generate(s.body.secret) }); return { ...p, secret: s.body.secret as string };
}
let op: Awaited<ReturnType<typeof operator>>;
const P = (method: string, path: string, body?: unknown) => call(op.token, method, `/platform${path}`, body);
beforeAll(async () => { await boot(); base = apiBase().replace(/\/api$/, ''); op = await operator('admin'); });
afterAll(shutdown);

describe('user directory', () => {
  it('searches and filters every account, shows memberships, needs the support capability, and audits a look at one person', async () => {
    const a = await person('Alice'); const b = await person('Bob');
    const r = await P('GET', `/users?q=${encodeURIComponent(a.email)}`); expect(r.status).toBe(200);
    expect(r.body.rows).toHaveLength(1); expect(r.body.rows[0]).toMatchObject({ email: a.email, totp_enabled: 0, disabled_at: null }); expect(r.body.rows[0].memberships[0]).toMatchObject({ agency_id: a.agencyId, role: 'admin' });
    expect((await P('GET', `/users?q=${encodeURIComponent(`Bob Travel`)}`)).body.rows.some((x: any) => x.id === b.id)).toBe(true);          // finds people by their agency's name too
    expect((await P('GET', '/users?filter=operators')).body.rows.every((x: any) => x.is_platform_admin)).toBe(true);
    expect((await P('GET', '/users?filter=no2fa')).body.rows.every((x: any) => !x.totp_enabled)).toBe(true);
    expect((await P('GET', '/users')).body.counts.users).toBeGreaterThan(2); expect((await P('GET', '/users?filter=bogus')).status).toBe(400);
    const d = await P('GET', `/users/${a.id}`); expect(d.status).toBe(200); expect(d.body.user.email).toBe(a.email); expect(d.body.memberships).toHaveLength(1);
    expect((await sql("SELECT COUNT(*) n FROM platform_audit_log WHERE action = 'view_user' AND detail = ?", [a.email]))[0].n).toBe(1);
    const ro = await operator('readonly'); expect((await call(ro.token, 'GET', '/platform/users')).status).toBe(403);                         // read-only operators cannot browse people
    expect((await call(a.token, 'GET', '/platform/users')).status).toBe(404);                                                                  // an ordinary admin cannot see the console exists
    expect((await P('GET', '/users/999999')).status).toBe(404);
  });
});

describe('switching an account off and on', () => {
  it('refuses sign-in, ends live sessions and tokens at once, and restores access when switched back on', async () => {
    const u = await person('Dana');
    expect((await call(u.token, 'GET', '/clients', undefined)).status).toBe(400);                 // sanity: needs X-Agency-Id, token itself is fine
    const withAgency = (t: string, a: number) => fetch(`${base}/api/clients`, { headers: { authorization: `Bearer ${t}`, 'x-agency-id': String(a) } }).then((x) => x.status);
    expect(await withAgency(u.token, u.agencyId)).toBe(200);
    expect((await P('POST', `/users/${u.id}/disable`, {})).status).toBe(400);                      // a reason is required
    const off = await P('POST', `/users/${u.id}/disable`, { reason: 'Chargeback dispute' }); expect(off.status).toBe(200); expect(off.body.disabled).toBe(true);
    expect(await withAgency(u.token, u.agencyId)).toBe(401);                                       // the token they already hold stops working immediately
    const login = await call(null, 'POST', '/auth/login', { email: u.email, password: PASSWORD }); expect(login.status).toBe(403); expect(login.body.error).toMatch(/disabled/);
    expect((await call(null, 'POST', '/auth/login', { email: u.email, password: 'wrong-password-123' })).status).toBe(401);          // a wrong password does not reveal the account is disabled
    expect((await call(null, 'POST', '/auth/refresh', {}, u.cookie)).status).toBe(401);
    expect((await P('POST', `/users/${u.id}/disable`, { reason: 'again please' })).status).toBe(409);
    expect((await P('GET', `/users?filter=disabled`)).body.rows.some((x: any) => x.id === u.id)).toBe(true);
    const on = await P('POST', `/users/${u.id}/enable`, { reason: 'Dispute resolved' }); expect(on.status).toBe(200);
    expect((await call(null, 'POST', '/auth/login', { email: u.email, password: PASSWORD })).status).toBe(200);
    expect((await sql("SELECT action FROM platform_audit_log WHERE detail LIKE ? ORDER BY id", [`${u.email}%`])).map((r) => r.action)).toEqual(['disable_user', 'enable_user']);
  });
  it('never lets an operator switch themselves off', async () => {
    expect((await P('POST', `/users/${op.id}/disable`, { reason: 'oops, myself' })).status).toBe(409);
    expect((await P('POST', `/users/${op.id}/enable`, { reason: 'myself, enabling' })).status).toBe(409);
  });
  it('a disabled operator cannot open the console', async () => {
    const o2 = await operator('support'); await sql('UPDATE users SET disabled_at = UTC_TIMESTAMP() WHERE id = ?', [o2.id]);
    expect((await call(o2.token, 'GET', '/platform/me')).status).toBe(401);
  });
});

describe('other account actions', () => {
  it('resets 2FA (and signs them out), signs a user out everywhere, and cannot target yourself', async () => {
    const u = await person('Eli'); const s = await call(u.token, 'POST', '/auth/2fa/setup', {}); await call(u.token, 'POST', '/auth/2fa/enable', { code: authenticator.generate(s.body.secret) });
    expect((await call(null, 'POST', '/auth/login', { email: u.email, password: PASSWORD })).body.totpRequired).toBe(true);
    expect((await P('POST', `/users/${u.id}/reset-2fa`, { reason: '' })).status).toBe(400);
    const r = await P('POST', `/users/${u.id}/reset-2fa`, { reason: 'Lost phone, identity checked' }); expect(r.status).toBe(200);
    expect((await call(null, 'POST', '/auth/login', { email: u.email, password: PASSWORD })).status).toBe(200);              // no code needed any more
    expect((await P('POST', `/users/${u.id}/reset-2fa`, { reason: 'twice in a row' })).status).toBe(409);
    expect((await P('POST', `/users/${op.id}/reset-2fa`, { reason: 'my own device' })).status).toBe(409);
    const so = await P('POST', `/users/${u.id}/sign-out`, { reason: 'Shared computer' }); expect(so.status).toBe(200); expect(so.body.sessions_ended).toBeGreaterThan(0);
    expect((await sql('SELECT COUNT(*) n FROM refresh_tokens WHERE user_id = ? AND revoked = 0', [u.id]))[0].n).toBe(0);
    const d = await P('GET', `/users/${u.id}`); expect(d.body.live_sessions).toBe(0);
  });
  it('sends a one-time password link that really works, and only the newest link is valid', async () => {
    const u = await person('Fay');
    const a = await P('POST', `/users/${u.id}/password-reset`, { reason: 'Locked out' }); expect(a.status).toBe(200); expect(a.body.link).toMatch(/\/reset-password\//);      // no email service in tests, so the link is handed to the operator
    const b = await P('POST', `/users/${u.id}/password-reset`, { reason: 'Locked out again' });
    const tok = (l: string) => l.split('/reset-password/')[1];
    expect((await call(null, 'POST', '/auth/reset', { token: tok(a.body.link), password: 'BrandNew#Pass2026' })).status).toBe(400);   // superseded
    expect((await call(null, 'POST', '/auth/reset', { token: tok(b.body.link), password: 'BrandNew#Pass2026' })).status).toBe(200);
    expect((await call(null, 'POST', '/auth/login', { email: u.email, password: 'BrandNew#Pass2026' })).status).toBe(200);
    await P('POST', `/users/${u.id}/password-reset`, { reason: 'third link' }); expect((await P('POST', `/users/${u.id}/password-reset`, { reason: 'fourth link' })).status).toBe(429);
  });
  it('counts the people holding each agency role, for support-level operators only', async () => {
    const r = await P('GET', '/agency-roles'); expect(r.status).toBe(200);
    expect(r.body.map((x: any) => x.role)).toEqual(['admin', 'finance_manager', 'agent', 'viewer']); expect(r.body[0].people).toBeGreaterThan(0); expect(r.body[0].agencies).toBeGreaterThan(0);
    const ro = await operator('readonly'); expect((await call(ro.token, 'GET', '/platform/agency-roles')).status).toBe(403);
  });
  it('lists operators with 2FA, last seen and recent activity', async () => {
    const r = await P('GET', '/operators'); const me = r.body.find((x: any) => x.id === op.id);
    expect(me).toMatchObject({ email: op.email, role: 'admin', totp_enabled: 1, disabled_at: null }); expect(me.last_seen).toBeTruthy(); expect(typeof me.actions_30d).toBe('number');
  });
});

describe('audit log search', () => {
  it('filters by category, operator, text and dates, counts each category, and pages', async () => {
    const u = await person('Gus'); await P('GET', `/users/${u.id}`); await P('POST', `/users/${u.id}/sign-out`, { reason: 'audit search test' });
    const all = await P('GET', '/audit'); expect(all.status).toBe(200); expect(all.body.page_size).toBe(25); expect(all.body.operators).toContain(op.email);
    const sm = all.body.summary; expect(sm.all).toBe(sm.views + sm.access + sm.billing + sm.people + sm.critical + sm.other); expect(sm.views).toBeGreaterThan(0); expect(sm.people).toBeGreaterThan(0);
    const people = await P('GET', '/audit?category=people&size=1000'); expect(people.body.rows.length).toBeGreaterThan(0); expect(people.body.rows.every((r: any) => r.category === 'people')).toBe(true);
    expect(people.body.summary.all).toBe(sm.all);                                                           // the category tiles do not shrink when one is chosen
    const hit = await P('GET', `/audit?q=${encodeURIComponent('audit search test')}`); expect(hit.body.rows).toHaveLength(1); expect(hit.body.rows[0]).toMatchObject({ action: 'sign_out_user', admin_email: op.email, category: 'people' });
    expect((await P('GET', `/audit?operator=${encodeURIComponent('nobody@x.test')}`)).body.total).toBe(0);
    const today = (await sql("SELECT DATE_FORMAT(created_at, '%Y-%m-%d') d FROM platform_audit_log WHERE reason = 'audit search test' LIMIT 1"))[0].d;     // the database's own day, whatever its time zone expect((await P('GET', `/audit?from=${today}&to=${today}&q=${encodeURIComponent('audit search test')}`)).body.total).toBe(1);
    expect((await P('GET', '/audit?from=2000-01-01&to=2000-01-02')).body.total).toBe(0); expect((await P('GET', '/audit?from=bad')).status).toBe(400);
    const paged = await P('GET', '/audit?size=2&page=2'); expect(paged.body.rows.length).toBeLessThanOrEqual(2); expect(paged.body.page).toBe(2);
    const ro = await operator('readonly'); expect((await call(ro.token, 'GET', '/platform/audit')).status).toBe(200);              // reading the audit log is open to every operator role
  });
});

describe('security events', () => {
  it('lists events from every agency with a category, a severity and who it was, and summarises them', async () => {
    const a = await person('Hana'); const b = await person('Ivo');
    // Hana tries to use Ivo's agency: refused, and recorded as a cross-agency attempt
    const r = await fetch(`${base}/api/clients`, { headers: { authorization: `Bearer ${a.token}`, 'x-agency-id': String(b.agencyId) } }); expect(r.status).toBe(403);
    const ev = await P('GET', `/security-events?q=${encodeURIComponent(a.email)}`); expect(ev.status).toBe(200);
    const hit = ev.body.rows.find((x: any) => x.event === 'agency_access_denied'); expect(hit).toMatchObject({ category: 'blocked', severity: 'high', user_email: a.email, agency_id: b.agencyId });
    const all = await P('GET', '/security-events'); const sm = all.body.summary; expect(sm.all).toBe(sm.blocked + sm.sensitive + sm.support + sm.recovery + sm.platform + sm.other); expect(sm.blocked).toBeGreaterThan(0);
    const blocked = await P('GET', '/security-events?category=blocked&size=1000'); expect(blocked.body.rows.every((x: any) => x.category === 'blocked')).toBe(true); expect(blocked.body.summary.all).toBe(sm.all);
    expect(all.body.attention.length).toBeGreaterThan(0); expect(all.body.attention[0]).toHaveProperty('email'); expect(all.body.trend.length).toBeGreaterThan(0);
    expect((await P('GET', '/security-events?from=2000-01-01&to=2000-01-02')).body.total).toBe(0); expect((await P('GET', '/security-events?from=nope')).status).toBe(400);
    expect((await call(a.token, 'GET', '/platform/security-events')).status).toBe(404);          // an ordinary admin cannot see the console
  });
});

describe('system status', () => {
  it('reports health, traffic, queues and which services are configured, without exposing any secret', async () => {
    const r = await P('GET', '/system'); expect(r.status).toBe(200); const b = r.body;
    expect(b.health.ok).toBe(true); expect(b.database.latency_ms).toBeGreaterThanOrEqual(0); expect(b.database.size_mb).toBeGreaterThan(0); expect(b.database.agencies).toBeGreaterThan(0); expect(b.database.migrations.applied).toBeGreaterThan(20);
    expect(b.process.uptime_s).toBeGreaterThanOrEqual(0); expect(b.process.node).toMatch(/^v\d+/); expect(b.traffic.total).toBeGreaterThan(0); expect(Object.keys(b.traffic.by_class)).toEqual(expect.arrayContaining(['2xx', '5xx']));
    for (const k of ['webhook_backlog', 'webhook_dead', 'failed_emails_24h', 'critical_exceptions']) expect(typeof b.queues[k]).toBe('number');
    for (const v of Object.values(b.integrations)) expect(typeof v).toBe('boolean');
    const raw = JSON.stringify(b); for (const secret of [process.env.JWT_SECRET, process.env.ENCRYPTION_KEY, process.env.DATABASE_URL, process.env.SENDGRID_API_KEY, process.env.STRIPE_SECRET_KEY].filter((x) => x && x.length > 8)) expect(raw).not.toContain(secret as string);
    expect((await call(op.token, 'GET', '/platform/system')).status).toBe(200);
  });
});

describe('dashboard overview', () => {
  it('adds weekly signups, activity, trials and recent agencies to the overview', async () => {
    await person('Newbie'); const o = (await P('GET', '/overview')).body;
    expect(o.signups).toHaveLength(12); expect(o.signups.every((n: number) => Number.isInteger(n) && n >= 0)).toBe(true); expect(o.signups[11]).toBeGreaterThan(0);         // the newest week is last and includes the agency just made
    expect(typeof o.active_7d).toBe('number'); expect(o.recent_agencies.length).toBeGreaterThan(0); expect(o.recent_agencies.length).toBeLessThanOrEqual(5); expect(o.recent_agencies[0]).toHaveProperty('name');
    expect(Array.isArray(o.trials)).toBe(true); expect(o.trials[0]).toHaveProperty('days_left');
  });
});

describe('AI key from the console', () => {
  const KEY = 'sk-ant-api03-TESTKEY_abcdefghijklmnopqrstuvwxyz0123456789';
  it('is saved only after it is proven to work, stored encrypted, never shown again, and removable', async () => {
    await sql("DELETE FROM platform_settings WHERE k = 'ai_api_key'"); dropAiKeyCache();
    const verify = vi.spyOn(llm, 'verify').mockResolvedValue(undefined);
    const before = (await P('GET', '/settings/ai')).body; expect(before).toMatchObject({ configured: expect.any(Boolean), model: expect.any(String) }); expect(JSON.stringify(before)).not.toContain('sk-ant');
    expect((await P('PUT', '/settings/ai', { api_key: KEY })).status).toBe(400);                                          // a reason is required
    expect((await P('PUT', '/settings/ai', { api_key: 'not-a-key-but-long-enough-xx', reason: 'first setup' })).status).toBe(400); expect(verify).not.toHaveBeenCalled();   // wrong shape is refused before any call
    verify.mockRejectedValueOnce(Object.assign(new Error('rejected'), {})); const bad = await P('PUT', '/settings/ai', { api_key: KEY, reason: 'first setup' }); expect(bad.status).toBe(400); expect(bad.body.error).toMatch(/rejected that key/);
    expect((await sql("SELECT COUNT(*) n FROM platform_settings WHERE k = 'ai_api_key'"))[0].n).toBe(0);                  // a key that fails is not saved
    verify.mockRejectedValueOnce(new Error('unreachable')); expect((await P('PUT', '/settings/ai', { api_key: KEY, reason: 'first setup' })).body.error).toMatch(/Could not reach/);
    const ok = await P('PUT', '/settings/ai', { api_key: KEY, reason: 'Go live with the AI assistant' }); expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ configured: true, source: 'console', hint: KEY.slice(-4) }); expect(JSON.stringify(ok.body)).not.toContain(KEY);
    const row = (await sql("SELECT v_enc FROM platform_settings WHERE k = 'ai_api_key'"))[0]; expect(row.v_enc).not.toContain('TESTKEY');                  // encrypted at rest
    const audit = JSON.stringify(await sql("SELECT detail, reason FROM platform_audit_log WHERE action = 'set_ai_key' ORDER BY id DESC LIMIT 1")); expect(audit).not.toContain(KEY); expect(audit).toContain(KEY.slice(-4));
    expect((await P('GET', '/system')).body.integrations.ai).toBe(true);
    const ro = await operator('support'); expect((await call(ro.token, 'PUT', '/platform/settings/ai', { api_key: KEY, reason: 'not allowed' })).status).toBe(403); expect((await call(ro.token, 'GET', '/platform/settings/ai')).status).toBe(200);
    expect(JSON.stringify((await call(ro.token, 'GET', '/platform/settings/ai')).body)).not.toContain('sk-ant');
    const gone = await P('DELETE', '/settings/ai', { reason: 'Rotating the key' }); expect(gone.status).toBe(200); expect(gone.body.source).not.toBe('console');
    expect((await P('DELETE', '/settings/ai', { reason: 'Nothing to remove' })).status).toBe(409);
    verify.mockRestore(); dropAiKeyCache();
  });
  it('a saved key switches the assistant on for agencies without any environment key', async () => {
    await sql("DELETE FROM platform_settings WHERE k = 'ai_api_key'"); dropAiKeyCache();
    const A = await person('Keyed'); await sql("UPDATE subscriptions SET plan_id = (SELECT id FROM plans WHERE code = 'growth') WHERE agency_id = ?", [A.agencyId]);
    const st = async () => (await fetch(`${base}/api/ai/status`, { headers: { authorization: `Bearer ${A.token}`, 'x-agency-id': String(A.agencyId) } })).json();
    const withoutKey = (await st()).reason; if (process.env.ANTHROPIC_API_KEY) return;                                  // only meaningful when the environment has no key
    expect(withoutKey).toBe('not_configured');
    vi.spyOn(llm, 'verify').mockResolvedValue(undefined); await P('PUT', '/settings/ai', { api_key: 'sk-ant-api03-TESTKEY_abcdefghijklmnopqrstuvwxyz0123456789', reason: 'enable AI' });
    expect((await st()).available).toBe(true);
    await P('DELETE', '/settings/ai', { reason: 'cleanup' }); dropAiKeyCache(); expect((await st()).reason).toBe('not_configured'); vi.restoreAllMocks();
  });
});
