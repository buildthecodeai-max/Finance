import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authenticator } from 'otplib';
import { Api, PASSWORD, addMember, apiBase, boot, newAgency, shutdown, sql } from './helpers.js';
import { setPlatformAdmin } from '../services/platform.js';
import { testOutbox } from '../services/email.js';

let base: string; const rnd = () => Math.random().toString(36).slice(2, 7);
const call = async (token: string | null, method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); let j: any; try { j = JSON.parse(t); } catch { j = t; } return { status: r.status, body: j };
};
async function operator(role: 'admin' | 'support' | 'readonly' = 'admin') {
  const email = `op-${rnd()}@platform.test`, reg = await call(null, 'POST', '/auth/register', { agencyName: `Ops ${rnd()}`, name: 'Operator', email, password: PASSWORD }); const token = reg.body.accessToken;
  await setPlatformAdmin(email, role); const s = await call(token, 'POST', '/auth/2fa/setup', {}); await call(token, 'POST', '/auth/2fa/enable', { code: authenticator.generate(s.body.secret) }); return { token, email };
}
let op: Awaited<ReturnType<typeof operator>>; const P = (method: string, path: string, body?: unknown) => call(op.token, method, `/platform${path}`, body);
beforeAll(async () => { await boot(); base = apiBase().replace(/\/api$/, ''); op = await operator('admin'); });
afterAll(async () => { await sql("DELETE FROM platform_settings WHERE k LIKE 'support_%'"); await shutdown(); });

describe('support contact details', () => {
  it('are set by an admin operator with a reason, shown to every agency, and validated', async () => {
    await sql("DELETE FROM platform_settings WHERE k LIKE 'support_%'");
    const A = await newAgency('SupInfo'); const empty = (await A.get('/support/info')).body; expect(empty.contact).toEqual({ email: '', phone: '', hours: '', url: '' }); expect(empty.status.ok).toBe(true);
    expect((await P('PUT', '/settings/support', { email: 'help@example.com' })).status).toBe(400);                                     // reason required
    expect((await P('PUT', '/settings/support', { email: 'not-an-email', reason: 'setup' })).status).toBe(400);
    expect((await P('PUT', '/settings/support', { email: 'help@example.com', url: 'http://insecure.example.com', reason: 'setup' })).status).toBe(400);
    const ok = await P('PUT', '/settings/support', { email: 'help@example.com', phone: '+1 555 0100', hours: 'Mon–Fri, 9am–6pm UTC', url: 'https://help.example.com', reason: 'Go live with support' }); expect(ok.status).toBe(200);
    expect((await A.get('/support/info')).body.contact).toMatchObject({ email: 'help@example.com', phone: '+1 555 0100', hours: 'Mon–Fri, 9am–6pm UTC', url: 'https://help.example.com' });
    const sup = await operator('support'); expect((await call(sup.token, 'PUT', '/platform/settings/support', { email: 'x@y.com', reason: 'nope' })).status).toBe(403); expect((await call(sup.token, 'GET', '/platform/settings/support')).status).toBe(200);
    expect(JSON.stringify(await sql("SELECT v_enc FROM platform_settings WHERE k = 'support_email'"))).not.toContain('help@example.com');   // stored like every other platform setting
  });
});

describe('requests to support', () => {
  it('an agency sends a request, sees it, and the team replies; people only see what they should', async () => {
    const A = await newAgency('SupAgency'); const agent = await addMember(A, 'agent'); const agent2 = await addMember(A, 'agent'); const viewer = await addMember(A, 'viewer'); const B = await newAgency('SupOther');
    await P('PUT', '/settings/support', { email: 'help@example.com', reason: 'setup' }); testOutbox.length = 0;
    expect((await agent.post('/support/requests', { subject: 'ab', message: 'too short' })).status).toBe(400);
    const r = await agent.post('/support/requests', { category: 'problem', subject: 'Invoice PDF is blank', message: 'When I open invoice INV-0004 the PDF shows nothing at all.' }); expect(r.status).toBe(201);
    expect((await agent.post('/support/requests', { category: 'problem', subject: 'Invoice PDF is blank', message: 'When I open invoice INV-0004 the PDF shows nothing at all.' })).status).toBe(409);   // the same thing twice in a row
    expect((await viewer.post('/support/requests', { subject: 'Hello there', message: 'A read-only person asking.' })).status).toBe(403);
    const mail = testOutbox.find((m) => m.to === 'help@example.com'); expect(mail?.subject).toContain('Invoice PDF is blank'); expect(mail?.html).toContain('SupAgency');
    expect((await agent.get('/support/requests')).body.map((x: any) => x.id)).toContain(r.body.id);                           // the sender sees their own
    expect((await agent2.get('/support/requests')).body).toHaveLength(0);                                                      // a colleague does not
    expect((await A.get('/support/requests')).body.map((x: any) => x.id)).toContain(r.body.id);                              // the owner sees the whole agency
    expect((await B.get('/support/requests')).body).toHaveLength(0);                                                           // another agency sees nothing
    const inbox = await P('GET', '/support-requests?status=open'); expect(inbox.status).toBe(200); const row = inbox.body.rows.find((x: any) => x.id === r.body.id); expect(row).toMatchObject({ agency_name: expect.stringContaining('SupAgency'), status: 'open', category: 'problem' }); expect(inbox.body.counts.open).toBeGreaterThan(0);
    expect((await call(A.token, 'GET', '/platform/support-requests')).status).toBe(404);                                       // an agency cannot see the inbox
    testOutbox.length = 0;
    const ans = await P('PUT', `/support-requests/${r.body.id}`, { status: 'resolved', reply: 'Fixed: please refresh and try again.' }); expect(ans.status).toBe(200);
    const mine = (await agent.get('/support/requests')).body.find((x: any) => x.id === r.body.id); expect(mine).toMatchObject({ status: 'resolved', reply: 'Fixed: please refresh and try again.' });
    expect(testOutbox.some((m) => m.subject === 'Re: Invoice PDF is blank')).toBe(true);
    expect((await sql("SELECT COUNT(*) n FROM platform_audit_log WHERE action = 'support_reply'"))[0].n).toBeGreaterThan(0);
    const ro = await operator('readonly'); expect((await call(ro.token, 'GET', '/platform/support-requests')).status).toBe(403);
    expect((await P('PUT', `/support-requests/${r.body.id}`, { status: 'bogus' })).status).toBe(400); expect((await P('PUT', '/support-requests/999999', { status: 'open' })).status).toBe(404);
  });
});
