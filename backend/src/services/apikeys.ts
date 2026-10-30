import { entitlements } from './billing.js';
import crypto from 'node:crypto';
import { NextFunction, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { sha256 } from '../crypto.js';
import { HttpError } from '../errors.js';
import { Tenant, pool } from '../db.js';

export const SCOPES = ['leads:write', 'clients:read', 'invoices:read'] as const;
const sqlTime = (d: Date) => d.toISOString().slice(0, 19).replace('T', ' ');

/** Key format: tfk_<8-char prefix>_<32 random chars>. Only the SHA-256 is stored; the full key is shown once. */
export async function createKey(t: Tenant, b: { name: string; scopes: string[]; days?: number }) {
  for (const s of b.scopes) if (!(SCOPES as readonly string[]).includes(s)) throw new HttpError(400, `Unknown scope ${s}`);
  const prefix = crypto.randomBytes(6).toString('base64url').slice(0, 8), key = `tfk_${prefix}_${crypto.randomBytes(24).toString('base64url')}`;
  const id = await t.insert('api_keys', { name: b.name, key_prefix: prefix, key_hash: sha256(key), scopes: b.scopes.join(','), expires_at: b.days ? sqlTime(new Date(Date.now() + b.days * 86400_000)) : null, created_by: t.actor.userId });
  return { id, key, prefix };
}

declare module 'express-serve-static-core' { interface Request { apiKey?: { id: number; agencyId: number; scopes: string[] } } }

/** Authenticates a bearer API key, checks the scope, and gives the request a tenant bound to the key's agency. */
export const apiAuth = (scope: (typeof SCOPES)[number]) => async (req: Request, _res: Response, next: NextFunction) => {
  try {
    const m = /^Bearer (tfk_[A-Za-z0-9_-]{8}_[A-Za-z0-9_-]{20,64})$/.exec(req.headers.authorization ?? '');
    if (!m) throw new HttpError(401, 'Missing or malformed API key');
    const [rows]: any = await pool.query('SELECT * FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > UTC_TIMESTAMP())', [sha256(m[1])]);
    if (!rows.length) throw new HttpError(401, 'Invalid, revoked or expired API key');
    const k = rows[0], scopes = String(k.scopes).split(',');
    if (!scopes.includes(scope)) throw new HttpError(403, `This key lacks the ${scope} scope`);
    const ent = await entitlements(k.agency_id);
    if (!ent.features.has('api')) throw Object.assign(new HttpError(402, 'The public API is not included in this plan.'), { code: 'plan_limit', feature: 'api' });
    if (ent.readOnly && req.method !== 'GET') throw Object.assign(new HttpError(402, 'This workspace is read-only (subscription inactive).'), { code: 'subscription_inactive' });
    await pool.query('UPDATE api_keys SET last_used_at = UTC_TIMESTAMP(), use_count = use_count + 1 WHERE id = ?', [k.id]);
    req.apiKey = { id: k.id, agencyId: k.agency_id, scopes };
    req.tenant = new Tenant(k.agency_id, { userId: null, ip: req.ip ?? null });
    next();
  } catch (e) { next(e); }
};
export const keyLimit = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, keyGenerator: (req) => (req.headers.authorization ?? req.ip ?? 'anon').slice(0, 40) });

/** Idempotency-Key support: the first request claims the key; replays get the stored response, concurrent duplicates get 409. */
export async function idempotent(agencyId: number, key: string | undefined, run: () => Promise<{ status: number; body: any }>) {
  if (!key) return run();
  if (!/^[\w.:-]{8,80}$/.test(key)) throw new HttpError(400, 'Idempotency-Key must be 8-80 characters');
  const [ins]: any = await pool.query('INSERT IGNORE INTO api_idempotency (agency_id, idem_key) VALUES (?,?)', [agencyId, key]);
  if (ins.affectedRows === 0) {
    const [[row]]: any = await pool.query('SELECT status_code, response FROM api_idempotency WHERE agency_id = ? AND idem_key = ?', [agencyId, key]);
    if (!row || row.status_code == null) throw new HttpError(409, 'A request with this Idempotency-Key is still in progress');
    return { status: row.status_code, body: typeof row.response === 'string' ? JSON.parse(row.response) : row.response, replay: true };
  }
  try { const r = await run(); await pool.query('UPDATE api_idempotency SET status_code = ?, response = ? WHERE agency_id = ? AND idem_key = ?', [r.status, JSON.stringify(r.body), agencyId, key]); return r; }
  catch (e) { await pool.query('DELETE FROM api_idempotency WHERE agency_id = ? AND idem_key = ?', [agencyId, key]); throw e; }
}
