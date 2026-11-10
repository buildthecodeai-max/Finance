import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { ALL_EDITORS } from '../auth.js';
import { pool } from '../db.js';
import { CATEGORIES, createRequest, supportContact, supportStatus } from '../services/support.js';
import { parse, T } from './util.js';
import { requireRole } from '../auth.js';

/** The agency's Support page: how to reach us, what is the platform's status, and the requests this agency has sent. */
export const supportRouter = Router();
const limit = rateLimit({ windowMs: 3_600_000, limit: 10, standardHeaders: true, legacyHeaders: false, keyGenerator: (req) => `support:${req.ctx?.userId ?? req.ip}`, message: { error: 'You have sent several requests in the last hour. We will get back to you. Please wait before sending more.' } });

supportRouter.get('/info', async (_req, res) => res.json({ contact: await supportContact(), status: await supportStatus() }));
supportRouter.get('/requests', async (req, res) => {
  const t = T(req), admin = ['admin', 'finance_manager'].includes(req.ctx!.role);       // owners and finance see the whole agency's requests; everyone else sees their own
  res.json(await t.query(`SELECT r.id, r.category, r.subject, r.message, r.status, r.reply, r.replied_at, r.created_at, u.name user_name FROM help_requests r JOIN users u ON u.id = r.user_id WHERE r.agency_id = ? ${admin ? '' : 'AND r.user_id = ?'} ORDER BY r.id DESC LIMIT 100`, admin ? [t.agencyId] : [t.agencyId, req.ctx!.userId]));
});
supportRouter.post('/requests', limit, requireRole(...ALL_EDITORS), async (req, res) => {
  const b = parse(z.object({ category: z.enum(CATEGORIES).default('question'), subject: z.string().trim().min(3, 'Give your request a short title.').max(160), message: z.string().trim().min(10, 'Tell us a little more, at least a sentence.').max(4000) }), req.body);
  res.status(201).json({ id: await createRequest(req, b) });
});
void pool;
