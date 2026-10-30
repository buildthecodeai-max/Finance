import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authenticator } from 'otplib';
import { PASSWORD, apiBase, boot, newAgency, shutdown, sql } from './helpers.js';
import { assertProductionConfig, config } from '../config.js';
import { purgeOld } from '../services/observability.js';

let base: string;
const rnd = () => Math.random().toString(36).slice(2, 8);
const call = async (path: string, init: RequestInit = {}) => { const r = await fetch(`${base}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(init.headers as any) } }); const t = await r.text(); let j: any; try { j = JSON.parse(t); } catch { j = t; } return { status: r.status, body: j, headers: r.headers }; };
const register = async () => { const email = `r8-${rnd()}@test.dev`; const r = await call('/api/auth/register', { method: 'POST', body: JSON.stringify({ agencyName: `R8 ${rnd()}`, name: 'R8', email, password: PASSWORD }) }); expect(r.status).toBe(201); return { email, token: r.body.accessToken as string, cookie: String(r.headers.get('set-cookie')).split(';')[0], userId: r.body.user.id as number }; };
const login = (email: string, password = PASSWORD, totp?: string) => call('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password, ...(totp ? { totp } : {}) }) });

beforeAll(async () => { await boot(); base = apiBase().replace(/\/api$/, ''); });
afterAll(shutdown);

describe('transport and observability', () => {
  it('sends hardened headers, request ids, and a CORS policy that excludes foreign origins', async () => {
    const r = await call('/api/health'); expect(r.status).toBe(200);
    expect(r.headers.get('x-content-type-options')).toBe('nosniff'); expect(r.headers.get('x-powered-by')).toBeNull(); expect(r.headers.get('strict-transport-security')).toBeTruthy(); expect(r.headers.get('x-frame-options')).toBeTruthy();
    expect(r.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    expect((await call('/api/health', { headers: { 'x-request-id': 'trace-abc12345' } })).headers.get('x-request-id')).toBe('trace-abc12345');
    expect((await call('/api/health', { headers: { 'x-request-id': 'bad id with spaces!' } })).headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);   // untrusted ids are replaced, not echoed
    const missing = await call('/api/auth/nope'); expect(missing.body).toBeTruthy();
    const err = await call('/api/invoices'); expect(err.status).toBe(401); expect(err.body.request_id).toBe(err.headers.get('x-request-id'));
    expect((await call('/api/health', { headers: { origin: 'https://evil.example' } })).headers.get('access-control-allow-origin')).toBe(config.corsOrigin);   // only ever the configured origin — never echoed, never *
    expect((await call('/api/health', { headers: { origin: config.corsOrigin } })).headers.get('access-control-allow-origin')).toBe(config.corsOrigin);
  });
  it('readiness checks the database and migrations; metrics are hidden without a token', async () => {
    const r = await call('/api/ready'); expect(r.status).toBe(200); expect(r.body.checks).toMatchObject({ database: 'ok' }); expect(r.body.checks.migrations.applied).toBeGreaterThanOrEqual(14);
    expect((await call('/api/metrics')).status).toBe(404); expect((await call('/api/metrics', { headers: { authorization: 'Bearer guess' } })).status).toBe(404);
    const prev = config.metricsToken; (config as any).metricsToken = 'metrics-token-for-test-123';
    try { const m = await call('/api/metrics', { headers: { authorization: 'Bearer metrics-token-for-test-123' } }); expect(m.status).toBe(200); expect(m.body).toContain('tf_http_requests_total'); expect(m.body).toContain('tf_webhook_dead'); expect(m.body).not.toMatch(/agency|email|token/i); }
    finally { (config as any).metricsToken = prev; }
  });
  it('rejects oversized bodies and unsigned (alg=none) tokens', async () => {
    expect((await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'a@b.test', password: 'x'.repeat(7_000_000) }) })).status).toBe(413);
    expect((await call('/api/auth/login', { method: 'POST', body: '{not json' })).status).toBe(400);
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url'); const forged = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: 1, exp: 4102444800 })}.`;
    expect((await call('/api/invoices', { headers: { authorization: `Bearer ${forged}`, 'x-agency-id': '1' } })).status).toBe(401);
  });
  it('refuses to boot in production with weak settings, accepts a sound one', () => {
    const good = { ...config, jwtSecret: 'x7Kp2mQz9vLr4TnB8sWd3YfJ6hGc1AeU5oXi', encryptionKey: 'a'.repeat(64), appUrl: 'https://app.example.com', corsOrigin: 'https://app.example.com', r2: { ...config.r2, bucket: 'b', accessKeyId: 'k' }, sendgridKey: 'SG.x', stripeKey: '', stripeWebhookSecret: '' };
    expect(assertProductionConfig(good)).toEqual([]);
    const bad = assertProductionConfig({ ...good, jwtSecret: 'change-me', encryptionKey: 'short', appUrl: 'http://localhost:5173', corsOrigin: '*', r2: { ...good.r2, bucket: '' }, stripeKey: 'sk', stripeWebhookSecret: '' });
    expect(bad.length).toBeGreaterThanOrEqual(6); expect(bad.join(' ')).toMatch(/JWT_SECRET/); expect(bad.join(' ')).toMatch(/ENCRYPTION_KEY/); expect(bad.join(' ')).toMatch(/localhost/); expect(bad.join(' ')).toMatch(/STRIPE_WEBHOOK_SECRET/);
  });
});

describe('authentication hardening', () => {
  it('locks an account after repeated failures (across IPs), without revealing whether it exists, and recovers after success', async () => {
    const u = await register(), ghost = `ghost-${rnd()}@test.dev`;
    for (let i = 0; i < 7; i++) expect((await login(u.email, 'wrong-password-1')).status).toBe(401);
    expect((await login(u.email)).status).toBe(200);                                                      // correct password still works below the limit and clears the counter
    for (let i = 0; i < 8; i++) await login(u.email, 'wrong-password-1');
    const locked = await login(u.email); expect(locked.status).toBe(429); expect((await login(u.email, 'wrong-password-1')).status).toBe(429);
    for (let i = 0; i < 8; i++) await login(ghost, 'whatever-123456'); expect((await login(ghost, 'whatever-123456')).status).toBe(429);   // same behaviour for unknown emails
    expect((await login((await register()).email)).status).toBe(200);                                     // other accounts unaffected
    await sql('DELETE FROM login_attempts WHERE email_hash IS NOT NULL');
  });
  it('detects a replayed (stolen) refresh token and ends all sessions; a quick double-refresh is tolerated', async () => {
    const u = await register(), refresh = (cookie: string) => call('/api/auth/refresh', { method: 'POST', headers: { cookie } });
    const first = await refresh(u.cookie); expect(first.status).toBe(200); const second = String(first.headers.get('set-cookie')).split(';')[0];
    expect((await refresh(u.cookie)).status).toBe(401);                                                   // replay within seconds: refused, but sessions survive
    expect((await refresh(second)).status).toBe(200);
    const live = String((await login(u.email)).headers.get('set-cookie')).split(';')[0];
    await sql('UPDATE refresh_tokens SET revoked_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 5 MINUTE) WHERE user_id = ? AND revoked = 1', [u.userId]);
    expect((await refresh(u.cookie)).status).toBe(401);                                                   // replay long after rotation = theft
    expect((await refresh(live)).status).toBe(401);                                                       // …so every session for that user is gone
  });
  it('protects 2FA from being re-enrolled with a stolen access token; password change signs out other sessions', async () => {
    const u = await register(), auth = { authorization: `Bearer ${u.token}` };
    const setup = await call('/api/auth/2fa/setup', { method: 'POST', headers: auth, body: '{}' }); expect(setup.status).toBe(200);
    expect((await call('/api/auth/2fa/enable', { method: 'POST', headers: auth, body: JSON.stringify({ code: authenticator.generate(setup.body.secret) }) })).status).toBe(200);
    expect((await call('/api/auth/2fa/setup', { method: 'POST', headers: auth, body: '{}' })).status).toBe(403);
    expect((await call('/api/auth/2fa/setup', { method: 'POST', headers: auth, body: JSON.stringify({ code: '000000' }) })).status).toBe(403);
    expect((await call('/api/auth/2fa/setup', { method: 'POST', headers: auth, body: JSON.stringify({ code: authenticator.generate(setup.body.secret) }) })).status).toBe(200);
    const v = await register(), va = { authorization: `Bearer ${v.token}` };
    expect((await call('/api/auth/password', { method: 'POST', headers: va, body: JSON.stringify({ current: 'nope-nope-nope', next: 'BrandNew#Pass2026' }) })).status).toBe(401);
    expect((await call('/api/auth/password', { method: 'POST', headers: va, body: JSON.stringify({ current: PASSWORD, next: 'short' }) })).status).toBe(400);
    expect((await call('/api/auth/password', { method: 'POST', headers: va, body: JSON.stringify({ current: PASSWORD, next: 'BrandNew#Pass2026' }) })).status).toBe(200);
    expect((await call('/api/auth/refresh', { method: 'POST', headers: { cookie: v.cookie } })).status).toBe(401);   // the old session is gone
    expect((await login(v.email)).status).toBe(401); expect((await login(v.email, 'BrandNew#Pass2026')).status).toBe(200);
  });
  it('can disable self-service sign-up', async () => {
    (config as any).allowSignup = false;
    try { expect((await call('/api/auth/register', { method: 'POST', body: JSON.stringify({ agencyName: 'Nope Co', name: 'N', email: `n-${rnd()}@t.dev`, password: PASSWORD }) })).status).toBe(403); }
    finally { (config as any).allowSignup = true; }
  });
});

describe('data retention', () => {
  it('purges expired operational data but never financial records or the audit log', async () => {
    const a = await newAgency('R8Purge');
    await sql("INSERT INTO login_attempts (email_hash, success, created_at) VALUES (REPEAT('a',64), 0, DATE_SUB(NOW(), INTERVAL 10 DAY))");
    await sql("INSERT INTO api_idempotency (agency_id, idem_key, created_at) VALUES (?, 'old-key-12345', DATE_SUB(NOW(), INTERVAL 30 DAY)), (?, 'new-key-12345', NOW())", [a.agencyId, a.agencyId]);
    await sql("INSERT INTO api_log (agency_id, ip, method, endpoint, status_code, ms, created_at) VALUES (?, 'x', 'GET', '/old', 200, 1, DATE_SUB(NOW(), INTERVAL 200 DAY))", [a.agencyId]);
    const audit = (await sql('SELECT COUNT(*) n FROM audit_log'))[0].n, inv = (await sql('SELECT COUNT(*) n FROM invoices'))[0].n;
    const r = await purgeOld(); expect(r.login_attempts).toBeGreaterThanOrEqual(1); expect(r.api_idempotency).toBeGreaterThanOrEqual(1); expect(r.api_log).toBeGreaterThanOrEqual(1);
    expect((await sql("SELECT COUNT(*) n FROM api_idempotency WHERE idem_key = 'new-key-12345'"))[0].n).toBe(1);
    expect((await sql('SELECT COUNT(*) n FROM audit_log'))[0].n).toBeGreaterThanOrEqual(audit); expect((await sql('SELECT COUNT(*) n FROM invoices'))[0].n).toBe(inv);
  });
});
