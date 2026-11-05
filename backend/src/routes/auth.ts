import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { authenticator } from 'otplib';
import { z } from 'zod';
import { pool } from '../db.js';
import { config } from '../config.js';
import { decrypt, encrypt, sha256 } from '../crypto.js';
import { HttpError, signAccess } from '../auth.js';
import { parse } from './util.js';
import { Tenant } from '../db.js';
import { seedChart } from '../services/accounting.js';
import { sendMail } from '../services/email.js';
import { startTrial } from '../services/billing.js';
import { verifyTotp } from '../services/platform.js';

export const authRouter = Router();
const cookieOpts = {
  httpOnly: true, secure: config.isProd, sameSite: 'strict' as const, path: '/api/auth', maxAge: 30 * 864e5,
};

async function issueRefresh(res: any, userId: number) {
  const token = crypto.randomBytes(48).toString('base64url');
  await pool.query(
    'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES (?,?,DATE_ADD(UTC_TIMESTAMP(), INTERVAL 30 DAY))',
    [userId, sha256(token)]);
  res.cookie('rt', token, cookieOpts);
}

async function session(userId: number) {
  const [[user]]: any = await pool.query('SELECT id, email, name, totp_enabled, is_platform_admin FROM users WHERE id = ?', [userId]);
  const [agencies]: any = await pool.query(
    `SELECT a.id, a.name, a.base_currency, a.tax_label, m.role FROM memberships m JOIN agencies a ON a.id = m.agency_id WHERE m.user_id = ?`, [userId]);
  return { accessToken: signAccess(userId), user, agencies };
}

// Self-serve sign-up: creates a new agency with the user as Admin.
authRouter.post('/register', async (req, res) => {
  if (!config.allowSignup) throw new HttpError(403, 'Self-service sign-up is disabled. Ask your administrator for an invitation.');
  const b = parse(z.object({
    agencyName: z.string().min(2), name: z.string().min(2), email: z.string().email(),
    password: z.string().min(10), baseCurrency: z.string().length(3).default('USD'),
  }), req.body);
  const [ex]: any = await pool.query('SELECT id FROM users WHERE email = ?', [b.email]);
  if (ex.length) throw new HttpError(409, 'Email already registered');
  const c = await pool.getConnection();
  try {
    await c.beginTransaction();
    const [a]: any = await c.query('INSERT INTO agencies (name, base_currency) VALUES (?,?)', [b.agencyName, b.baseCurrency]);
    const [u]: any = await c.query('INSERT INTO users (email, name, password_hash) VALUES (?,?,?)',
      [b.email, b.name, await bcrypt.hash(b.password, 12)]);
    await c.query('INSERT INTO memberships (agency_id, user_id, role) VALUES (?,?,"admin")', [a.insertId, u.insertId]);
    await c.commit();
    await seedChart(new Tenant(a.insertId, { userId: u.insertId, ip: req.ip }));
    await startTrial(a.insertId);
    await issueRefresh(res, u.insertId);
    res.status(201).json(await session(u.insertId));
  } catch (e) { await c.rollback(); throw e; } finally { c.release(); }
});

/** Per-account throttle on top of the per-IP limiter: stops credential stuffing spread across many IPs. */
const LOCK_AFTER = 8, LOCK_WINDOW_MIN = 15;
authRouter.post('/login', async (req, res) => {
  const b = parse(z.object({ email: z.string().email(), password: z.string().max(200), totp: z.string().optional() }), req.body);
  const eh = sha256(b.email.toLowerCase());
  const [[recent]]: any = await pool.query('SELECT COUNT(*) n FROM login_attempts WHERE email_hash = ? AND success = 0 AND created_at > DATE_SUB(NOW(), INTERVAL ? MINUTE)', [eh, LOCK_WINDOW_MIN]);
  if (recent.n >= LOCK_AFTER) throw new HttpError(429, `Too many failed sign-ins. Try again in ${LOCK_WINDOW_MIN} minutes.`);
  const fail = async (msg: string, extra?: object) => { await pool.query('INSERT INTO login_attempts (email_hash, ip, success) VALUES (?,?,0)', [eh, req.ip ?? null]); return void res.status(401).json({ error: msg, ...extra }); };
  const [rows]: any = await pool.query('SELECT * FROM users WHERE email = ?', [b.email]);
  const u = rows[0];
  // Always run bcrypt to keep timing uniform
  const ok = await bcrypt.compare(b.password, u?.password_hash ?? '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvali');
  if (!u || !ok) return fail('Invalid credentials');
  if (u.totp_enabled && !config.skip2fa) {
    if (!b.totp) return void res.status(401).json({ error: 'TOTP required', totpRequired: true });   // password was right; not counted as a failure
    if (!(await verifyTotp(u.id, b.totp))) return fail('Invalid 2FA code');   // a code works once, even within its 30 s window
  }
  await pool.query('DELETE FROM login_attempts WHERE email_hash = ?', [eh]);
  await issueRefresh(res, u.id);
  res.json(await session(u.id));
});

// Rotating refresh tokens: each use revokes the old one.
authRouter.post('/refresh', async (req, res) => {
  const t = req.cookies?.rt;
  if (!t) throw new HttpError(401, 'No session');
  const [rows]: any = await pool.query(
    'SELECT * FROM refresh_tokens WHERE token_hash = ? AND revoked = 0 AND expires_at > UTC_TIMESTAMP()', [sha256(t)]);
  if (!rows.length) {
    // A rotated token being replayed after a grace period means it was copied: end every session for that user.
    const [[old]]: any = await pool.query('SELECT user_id FROM refresh_tokens WHERE token_hash = ? AND revoked = 1 AND revoked_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 SECOND)', [sha256(t)]);
    if (old) await pool.query('UPDATE refresh_tokens SET revoked = 1, revoked_at = COALESCE(revoked_at, UTC_TIMESTAMP()) WHERE user_id = ? AND revoked = 0', [old.user_id]);
    throw new HttpError(401, 'Session expired');
  }
  const [claimed]: any = await pool.query('UPDATE refresh_tokens SET revoked = 1, revoked_at = UTC_TIMESTAMP() WHERE id = ? AND revoked = 0', [rows[0].id]);
  if (claimed.affectedRows === 0) throw new HttpError(401, 'Session expired');
  await issueRefresh(res, rows[0].user_id);
  res.json(await session(rows[0].user_id));
});

authRouter.post('/logout', async (req, res) => {
  if (req.cookies?.rt) await pool.query('UPDATE refresh_tokens SET revoked = 1, revoked_at = UTC_TIMESTAMP() WHERE token_hash = ?', [sha256(req.cookies.rt)]);
  res.clearCookie('rt', { path: '/api/auth' }).json({ ok: true });
});

/* ---------------------------------------------------------------- password reset by email */
const RESET_TTL_MIN = 30, RESET_MAX_PER_HOUR = 3;
const resetEvent = async (userId: number, ip: string | undefined, event: string) => {
  const [m]: any = await pool.query('SELECT agency_id FROM memberships WHERE user_id = ?', [userId]);
  for (const r of m) await pool.query('INSERT INTO security_events (agency_id, user_id, ip, event, detail) VALUES (?,?,?,?,?)', [r.agency_id, userId, ip ?? null, event, null]);
};

/** Always answers the same way, whether or not the address has an account, so it cannot be used to find out who is registered. */
authRouter.post('/forgot', async (req, res) => {
  const b = parse(z.object({ email: z.string().email().max(255) }), req.body);
  const generic = { ok: true, message: 'If that address has an account, we have emailed a link to reset the password. It expires in 30 minutes.' };
  const [rows]: any = await pool.query('SELECT id, name, email FROM users WHERE email = ?', [b.email]);
  const u = rows[0];
  if (u) {
    const [[recent]]: any = await pool.query('SELECT COUNT(*) n FROM password_resets WHERE user_id = ? AND created_at > DATE_SUB(NOW(), INTERVAL 1 HOUR)', [u.id]);
    if (recent.n < RESET_MAX_PER_HOUR) {
      const token = crypto.randomBytes(32).toString('base64url');
      await pool.query('UPDATE password_resets SET used_at = UTC_TIMESTAMP() WHERE user_id = ? AND used_at IS NULL', [u.id]);   // only the newest link works
      await pool.query('INSERT INTO password_resets (user_id, token_hash, expires_at, ip) VALUES (?,?,DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? MINUTE),?)', [u.id, sha256(token), RESET_TTL_MIN, req.ip ?? null]);
      await resetEvent(u.id, req.ip, 'password_reset_requested');
      const link = `${config.appUrl}/reset-password/${token}`;
      if (!config.isProd && !config.sendgridKey && process.env.NODE_ENV !== 'test') console.log(`[dev] password reset link for ${u.email}: ${link}`);
      // not awaited: response time must not reveal whether an email was sent
      void sendMail(u.email, 'Reset your Travel CRM password', `<p>Hi ${String(u.name).replace(/</g, '&lt;')},</p><p>We received a request to reset your password. <a href="${link}">Choose a new password</a> — the link works once and expires in ${RESET_TTL_MIN} minutes.</p><p>If you didn't ask for this, you can ignore this email; your password has not changed.</p>`).catch((e) => console.error('reset mail failed', e?.message));
    }
  }
  res.json(generic);
});

authRouter.post('/reset', async (req, res) => {
  const b = parse(z.object({ token: z.string().min(20).max(100), password: z.string().min(10).max(200) }), req.body);
  const bad = new HttpError(400, 'This reset link is invalid or has expired. Request a new one.');
  const [rows]: any = await pool.query('SELECT * FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > UTC_TIMESTAMP()', [sha256(b.token)]);
  if (!rows.length) throw bad;
  const [claim]: any = await pool.query('UPDATE password_resets SET used_at = UTC_TIMESTAMP() WHERE id = ? AND used_at IS NULL', [rows[0].id]);   // single use, even under concurrent submits
  if (claim.affectedRows === 0) throw bad;
  const uid = rows[0].user_id;
  await pool.query('UPDATE users SET password_hash = ? WHERE id = ?', [await bcrypt.hash(b.password, 12), uid]);
  await pool.query('UPDATE refresh_tokens SET revoked = 1, revoked_at = UTC_TIMESTAMP() WHERE user_id = ? AND revoked = 0', [uid]);   // every existing session ends
  const [[u]]: any = await pool.query('SELECT email FROM users WHERE id = ?', [uid]);
  await pool.query('DELETE FROM login_attempts WHERE email_hash = ?', [sha256(String(u.email).toLowerCase())]);   // a locked-out user can sign in again
  await resetEvent(uid, req.ip, 'password_reset_completed');
  void sendMail(u.email, 'Your Travel CRM password was changed', '<p>Your password was just changed using a reset link. If this was not you, contact your administrator immediately.</p>').catch(() => {});
  res.json({ ok: true });   // 2FA, if enabled, is still required at sign-in: a reset link alone never bypasses it
});

authRouter.post('/password', async (req, res) => {
  const id = userFromBearer(req), b = parse(z.object({ current: z.string().max(200), next: z.string().min(10).max(200) }), req.body);
  const [[u]]: any = await pool.query('SELECT password_hash FROM users WHERE id = ?', [id]);
  if (!(await bcrypt.compare(b.current, u.password_hash))) throw new HttpError(401, 'Current password is incorrect');
  await pool.query('UPDATE users SET password_hash = ? WHERE id = ?', [await bcrypt.hash(b.next, 12), id]);
  await pool.query('UPDATE refresh_tokens SET revoked = 1, revoked_at = UTC_TIMESTAMP() WHERE user_id = ? AND revoked = 0', [id]);   // sign out everywhere else
  await issueRefresh(res, id);
  res.json({ ok: true });
});

// --- Optional TOTP 2FA (requires a valid access token) ---
function userFromBearer(req: any): number {
  try { const p: any = jwt.verify((req.headers.authorization ?? '').slice(7), config.jwtSecret, { algorithms: ['HS256'] }); if (p.sup) throw new Error('support token'); return Number(p.sub); }   // support-session tokens may never change credentials
  catch { throw new HttpError(401, 'Invalid token'); }
}

authRouter.post('/2fa/setup', async (req, res) => {
  const id = userFromBearer(req);
  const [[u]]: any = await pool.query('SELECT email, totp_enabled, totp_secret_enc FROM users WHERE id = ?', [id]);
  // Re-enrolling would otherwise let a stolen access token switch 2FA off: demand a current code first.
  if (u.totp_enabled && !(req.body?.code && authenticator.check(String(req.body.code), decrypt(u.totp_secret_enc)))) throw new HttpError(403, 'Enter your current 2FA code to change 2FA');
  const secret = authenticator.generateSecret();
  await pool.query('UPDATE users SET totp_secret_enc = ?, totp_enabled = 0 WHERE id = ?', [encrypt(secret), id]);
  res.json({ secret, otpauth: authenticator.keyuri(u.email, 'Travel CRM', secret) });
});

authRouter.post('/2fa/enable', async (req, res) => {
  const id = userFromBearer(req);
  const { code } = parse(z.object({ code: z.string() }), req.body);
  const [[u]]: any = await pool.query('SELECT totp_secret_enc FROM users WHERE id = ?', [id]);
  if (!u?.totp_secret_enc || !authenticator.check(code, decrypt(u.totp_secret_enc))) throw new HttpError(400, 'Invalid code');
  await pool.query('UPDATE users SET totp_enabled = 1 WHERE id = ?', [id]);
  res.json({ ok: true });
});
