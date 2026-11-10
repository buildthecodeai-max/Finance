import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authenticator } from 'otplib';
import { Api, PASSWORD, addMember, apiBase, boot, newAgency, shutdown, sql } from './helpers.js';
import { setPlatformAdmin } from '../services/platform.js';

let base: string; const rnd = () => Math.random().toString(36).slice(2, 7); const NEW = 'Fresh#Passw0rd-2026';
const call = async (token: string | null, method: string, path: string, body?: unknown, cookie?: string) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); let j: any; try { j = JSON.parse(t); } catch { j = t; } return { status: r.status, body: j, cookie: (r.headers.get('set-cookie') ?? '').split(';')[0] };
};
const login = (email: string, password: string) => call(null, 'POST', '/auth/login', { email, password });
/** a team member with a known email, plus their row id in the team list */
async function member(owner: Api, role: 'agent' | 'finance_manager' | 'viewer' | 'admin' = 'agent') {
  const email = `${role}-${rnd()}@team.test`; const r = await owner.post('/team', { email, name: `${role} person`, role, password: PASSWORD }); expect(r.status).toBe(201);
  const row = (await owner.get('/team')).body.find((m: any) => m.email === email); return { email, rowId: row.id as number, userId: row.user_id as number };
}
beforeAll(async () => { await boot(); base = apiBase().replace(/\/api$/, ''); });
afterAll(shutdown);

describe('an agency owner sets a password for their team', () => {
  it('works for a member of this agency only, ends their sessions, and the old password stops working', async () => {
    const owner = await newAgency('OwnerCo'); const m = await member(owner, 'agent');
    const before = await login(m.email, PASSWORD); expect(before.status).toBe(200);
    expect((await owner.put(`/team/${m.rowId}/password`, { password: 'short' })).status).toBe(400);
    const r = await owner.put(`/team/${m.rowId}/password`, { password: NEW }); expect(r.status).toBe(200); expect(r.body.sessions_ended).toBeGreaterThan(0);
    expect((await login(m.email, PASSWORD)).status).toBe(401); expect((await login(m.email, NEW)).status).toBe(200);
    expect((await call(null, 'POST', '/auth/refresh', {}, before.cookie)).status).toBe(401);                       // the session they had is gone
    expect(JSON.stringify(await sql("SELECT * FROM audit_log WHERE agency_id = ? AND entity = 'user_password'", [owner.agencyId]))).not.toContain(NEW);   // recorded, but never the password
    expect((await sql("SELECT COUNT(*) n FROM audit_log WHERE agency_id = ? AND entity = 'user_password'", [owner.agencyId]))[0].n).toBe(1);
  });
  it('is for admins only, and never for yourself, another admin, or someone who works for another agency', async () => {
    const owner = await newAgency('Guarded'); const agent = await addMember(owner, 'agent'); const fm = await addMember(owner, 'finance_manager'); const m = await member(owner, 'viewer');
    expect((await agent.put(`/team/${m.rowId}/password`, { password: NEW })).status).toBe(403); expect((await fm.put(`/team/${m.rowId}/password`, { password: NEW })).status).toBe(403);
    const team = (await owner.get('/team')).body; const own = team.find((x: any) => x.user_id === owner.userId);
    expect((await owner.put(`/team/${own.id}/password`, { password: NEW })).status).toBe(409);
    const second = await member(owner, 'admin'); const rr = await owner.put(`/team/${second.rowId}/password`, { password: NEW }); expect(rr.status).toBe(409); expect(rr.body.error).toMatch(/change their own password/);
    // a person who also works for another agency keeps control of their own password
    const other = await newAgency('Other'); await other.post('/team', { email: m.email, name: 'x', role: 'agent' });
    const shared = await owner.put(`/team/${m.rowId}/password`, { password: NEW }); expect(shared.status).toBe(409); expect(shared.body.error).toMatch(/another agency/); expect((await login(m.email, PASSWORD)).status).toBe(200);
    // another agency cannot reach this agency's people at all
    expect((await other.put(`/team/${agent.userId === 0 ? 1 : (await owner.get('/team')).body.find((x: any) => x.user_id === agent.userId).id}/password`, { password: NEW })).status).toBe(404);
    // a platform operator's account is not the agency's to change
    const opMember = await member(owner, 'agent'); await setPlatformAdmin(opMember.email, 'support'); expect((await owner.put(`/team/${opMember.rowId}/password`, { password: NEW })).status).toBe(409);
    await setPlatformAdmin(opMember.email, null);
  });
});

describe('a platform operator sets any password', () => {
  it('works for an agency owner, a team member and another operator; needs a reason, a strong password and the right role; and is audited without the password', async () => {
    const opEmail = `op-${rnd()}@platform.test`, reg = await call(null, 'POST', '/auth/register', { agencyName: `Ops ${rnd()}`, name: 'Operator', email: opEmail, password: PASSWORD }); const opToken = reg.body.accessToken, opId = reg.body.user.id;
    await setPlatformAdmin(opEmail, 'admin'); const s = await call(opToken, 'POST', '/auth/2fa/setup', {}); await call(opToken, 'POST', '/auth/2fa/enable', { code: authenticator.generate(s.body.secret) });
    const P = (id: number, body: unknown) => call(opToken, 'POST', `/platform/users/${id}/set-password`, body);
    const owner = await newAgency('Target'); const ownerRow = (await owner.get('/team')).body[0]; const m = await member(owner, 'agent');
    expect((await P(owner.userId, { password: NEW })).status).toBe(400);                                              // reason required
    expect((await P(owner.userId, { password: 'tiny', reason: 'Owner locked out' })).status).toBe(400);              // password strength
    const r = await P(owner.userId, { password: NEW, reason: 'Owner locked out, identity verified' }); expect(r.status).toBe(200);
    expect((await login(ownerRow.email, PASSWORD)).status).toBe(401); expect((await login(ownerRow.email, NEW)).status).toBe(200);
    expect((await P(m.userId, { password: NEW, reason: 'Member has no email access' })).status).toBe(200); expect((await login(m.email, NEW)).status).toBe(200);
    expect((await P(opId, { password: NEW, reason: 'trying myself' })).status).toBe(409);                              // never your own
    const row = (await sql("SELECT detail, reason FROM platform_audit_log WHERE action = 'set_user_password' ORDER BY id DESC LIMIT 1"))[0]; expect(JSON.stringify(row)).not.toContain(NEW); expect(row.reason).toMatch(/Member has no email access/);
    expect((await call(owner.token, 'POST', `/platform/users/${m.userId}/set-password`, { password: NEW, reason: 'I am just an owner' })).status).toBe(404);   // the console does not exist for an agency owner
    // an operator can also fix another operator's password
    const op2Email = `op2-${rnd()}@platform.test`; const r2 = await call(null, 'POST', '/auth/register', { agencyName: `Ops2 ${rnd()}`, name: 'Op2', email: op2Email, password: PASSWORD }); await setPlatformAdmin(op2Email, 'support');
    expect((await P(r2.body.user.id, { password: NEW, reason: 'Operator lost access' })).status).toBe(200); expect((await login(op2Email, NEW)).status).toBe(200);
  });
});
