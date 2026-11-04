import jwt from 'jsonwebtoken';
import type { NextFunction, Request, Response } from 'express';
import { config } from './config.js';
import { pool, Tenant } from './db.js';
import { HttpError } from './errors.js';

export type Role = 'admin' | 'finance_manager' | 'agent' | 'viewer';

declare global {
  namespace Express {
    interface Request {
      ctx?: { userId: number; agencyId: number; role: Role; branchId: number | null; support?: boolean };
      tenant?: Tenant;
    }
  }
}

export const signAccess = (userId: number) => jwt.sign({ sub: userId }, config.jwtSecret, { algorithm: 'HS256', expiresIn: '15m' });

export { HttpError };
const userAgent = (req: Request) => String(req.headers['user-agent'] ?? '').slice(0, 200) || null;

/** Verifies the JWT, then resolves the user's role *for the requested agency* (X-Agency-Id). */
export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) throw new HttpError(401, 'Missing token');
  let userId: number, sup: number | null = null;
  try {
    const p: any = jwt.verify(h.slice(7), config.jwtSecret, { algorithms: ['HS256'] });
    userId = Number(p.sub); sup = p.sup ? Number(p.sup) : null;
  } catch {
    throw new HttpError(401, 'Invalid or expired token');
  }
  const agencyId = Number(req.headers['x-agency-id']);
  if (!agencyId) throw new HttpError(400, 'X-Agency-Id header required');
  if (sup !== null) {   // operator support session: this one agency, read-only, only while the session is live (the customer can end it)
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) throw new HttpError(403, 'Support sessions are read-only');
    const [ss]: any = await pool.query('SELECT id FROM support_sessions WHERE id = ? AND admin_user_id = ? AND agency_id = ? AND revoked_at IS NULL AND expires_at > UTC_TIMESTAMP()', [sup, userId, agencyId]);
    if (!ss.length) throw new HttpError(401, 'Support session ended');
    req.ctx = { userId, agencyId, role: 'viewer', branchId: null, support: true };
    req.tenant = new Tenant(agencyId, { userId, ip: req.ip, role: 'support', ua: userAgent(req) });
    return next();
  }
  const [rows]: any = await pool.query(
    'SELECT role, branch_id FROM memberships WHERE user_id = ? AND agency_id = ?', [userId, agencyId]);
  if (!rows.length) {
    await pool.query('INSERT INTO security_events (agency_id, user_id, ip, event, detail) VALUES (?,?,?,?,?)', [agencyId, userId, req.ip, 'agency_access_denied', `${req.method} ${req.originalUrl}`.slice(0, 500)]);
    throw new HttpError(403, 'No access to this agency');
  }
  req.ctx = { userId, agencyId, role: rows[0].role, branchId: rows[0].branch_id ?? null };
  req.tenant = new Tenant(agencyId, { userId, ip: req.ip, role: rows[0].role, ua: userAgent(req) });
  next();
}

export const requireRole = (...roles: Role[]) => (req: Request, _res: Response, next: NextFunction) => {
  if (!req.ctx || !roles.includes(req.ctx.role)) {
    if (req.ctx) pool.query('INSERT INTO security_events (agency_id, user_id, ip, event, detail) VALUES (?,?,?,?,?)', [req.ctx.agencyId, req.ctx.userId, req.ip, 'role_denied', `${req.ctx.role} ${req.method} ${req.originalUrl}`.slice(0, 500)]).catch(() => {});
    throw new HttpError(403, 'Insufficient role');
  }
  next();
};

export const WRITERS: Role[] = ['admin', 'finance_manager'];
export const ALL_EDITORS: Role[] = ['admin', 'finance_manager', 'agent'];
