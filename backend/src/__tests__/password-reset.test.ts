import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authenticator } from 'otplib';
import { PASSWORD, apiBase, boot, shutdown, sql } from './helpers.js';
import { testOutbox } from '../services/email.js';

let base: string;
const rnd = () => Math.random().toString(36).slice(2, 8);
const call = async (path: string, body?: unknown, headers: Record<string, string> = {}) => { const r = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body ?? {}) }); const t = await r.text(); let j: any; try { j = JSON.parse(t); } catch { j = t; } return { status: r.status, body: j, headers: r.headers }; };
const register = async () => { const email = `pr-${rnd()}@test.dev`; const r = await call('/api/auth/register', { agencyName: `PR ${rnd()}`, name: 'Pat <b>Reset</b>', email, password: PASSWORD }); expect(r.status).toBe(201); return { email, token: r.body.accessToken as string, cookie: String(r.headers.get('set-cookie')).split(';')[0], id: r.body.user.id as number }; };
const login = (email: string, password: string, totp?: string) => call('/api/auth/login', { email, password, ...(totp ? { totp } : {}) });
const forgot = (email: string) => call('/api/auth/forgot', { email });
const tokenFor = (email: string) => { const m = [...testOutbox].reverse().find((x) => x.to === email && /Reset your/.test(x.subject)); return m ? /reset-password\/([\w-]+)/.exec(m.html)![1] : null; };
const NEW = 'Brand#New2026pw';

beforeAll(async () => { await boot(); base = apiBase().replace(/\/api$/, ''); });
afterAll(shutdown);

describe('password reset by email', () => {
  it('answers identically for known and unknown addresses; sends one email only to the real account; stores only a hash', async () => {
    const u = await register(), before = testOutbox.length;
    const a = await forgot(u.email), b = await forgot(`nobody-${rnd()}@test.dev`);
    expect(a.status).toBe(200); expect(b.status).toBe(200); expect(a.body).toEqual(b.body);
    await new Promise((r) => setTimeout(r, 100)); expect(testOutbox.length - before).toBe(1);
    const tok = tokenFor(u.email)!; expect(tok).toBeTruthy();
    const rows = await sql('SELECT token_hash, expires_at FROM password_resets WHERE user_id = ?', [u.id]); expect(rows).toHaveLength(1); expect(rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/); expect(JSON.stringify(rows)).not.toContain(tok);
    expect(testOutbox.at(-1)!.html).not.toContain('<b>Reset</b>');                                                // name is escaped in the email
    expect((await call('/api/auth/forgot', { email: 'not-an-email' })).status).toBe(400);
  });
  it('resets the password once, ends every session, clears a lockout, and is logged', async () => {
    const u = await register(); const live = String((await login(u.email, PASSWORD)).headers.get('set-cookie')).split(';')[0];
    for (let i = 0; i < 9; i++) await login(u.email, 'wrong-password-1'); expect((await login(u.email, PASSWORD)).status).toBe(429);   // locked out
    await forgot(u.email); await new Promise((r) => setTimeout(r, 100)); const tok = tokenFor(u.email)!;
    expect((await call('/api/auth/reset', { token: tok, password: 'short' })).status).toBe(400);
    expect((await call('/api/auth/reset', { token: 'x'.repeat(43), password: NEW })).status).toBe(400);
    expect((await call('/api/auth/reset', { token: tok, password: NEW })).status).toBe(200);
    expect((await call('/api/auth/reset', { token: tok, password: 'Another#Pass2026' })).status).toBe(400);        // single use
    expect((await login(u.email, PASSWORD)).status).toBe(401); expect((await login(u.email, NEW)).status).toBe(200);   // new password works, lockout gone
    expect((await call('/api/auth/refresh', {}, { cookie: u.cookie })).status).toBe(401); expect((await call('/api/auth/refresh', {}, { cookie: live })).status).toBe(401);
    const ev = (await sql('SELECT event FROM security_events WHERE user_id = ?', [u.id])).map((e: any) => e.event); expect(ev).toContain('password_reset_requested'); expect(ev).toContain('password_reset_completed');
    expect(testOutbox.some((m) => m.to === u.email && /was changed/.test(m.subject))).toBe(true);                   // notification of the change
  });
  it('only the newest link works, expired links fail, and concurrent submits succeed once', async () => {
    const u = await register(); await forgot(u.email); await new Promise((r) => setTimeout(r, 60)); const first = tokenFor(u.email)!;
    await forgot(u.email); await new Promise((r) => setTimeout(r, 60)); const second = tokenFor(u.email)!; expect(second).not.toBe(first);
    expect((await call('/api/auth/reset', { token: first, password: NEW })).status).toBe(400);
    await sql("UPDATE password_resets SET expires_at = '2020-01-01 00:00:00' WHERE user_id = ? AND used_at IS NULL", [u.id]);
    expect((await call('/api/auth/reset', { token: second, password: NEW })).status).toBe(400);                    // expired
    const v = await register(); await forgot(v.email); await new Promise((r) => setTimeout(r, 60)); const t = tokenFor(v.email)!;
    const rs = await Promise.all([1, 2, 3].map((i) => call('/api/auth/reset', { token: t, password: `Race#Winner${i}2026` })));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
  });
  it('does not bypass two-factor authentication', async () => {
    const u = await register(), auth = { authorization: `Bearer ${u.token}` };
    const setup = await call('/api/auth/2fa/setup', {}, auth); await call('/api/auth/2fa/enable', { code: authenticator.generate(setup.body.secret) }, auth);
    await forgot(u.email); await new Promise((r) => setTimeout(r, 60)); expect((await call('/api/auth/reset', { token: tokenFor(u.email)!, password: NEW })).status).toBe(200);
    const noCode = await login(u.email, NEW); expect(noCode.status).toBe(401); expect(noCode.body.totpRequired).toBe(true);
    expect((await login(u.email, NEW, authenticator.generate(setup.body.secret))).status).toBe(200);
  });
  it('limits how many reset emails one account can trigger per hour', async () => {
    const u = await register(), before = testOutbox.length;
    for (let i = 0; i < 6; i++) expect((await forgot(u.email)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 150)); expect(testOutbox.length - before).toBe(3); expect((await sql('SELECT COUNT(*) n FROM password_resets WHERE user_id = ?', [u.id]))[0].n).toBe(3);
  });
});
