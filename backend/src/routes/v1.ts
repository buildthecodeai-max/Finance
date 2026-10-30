import { Router } from 'express';
import { z } from 'zod';
import { apiAuth, idempotent, keyLimit } from '../services/apikeys.js';
import { emit } from '../services/webhooks.js';
import { validDate } from '../services/imports.js';
import { HttpError } from '../errors.js';
import { r2 } from '../services/money.js';
import { parse, T } from './util.js';

/** Public REST API (v1). API-key authenticated, scoped, rate-limited, and deliberately small: no cost, margin or bank data. */
export const v1Router = Router();
v1Router.use(keyLimit);
const page = (req: any) => ({ limit: Math.min(100, Math.max(1, Number(req.query.limit) || 50)), after: Math.max(0, Number(req.query.after_id) || 0) });

const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(validDate, 'Not a real date');
const Lead = z.object({ name: z.string().trim().min(1).max(200), email: z.string().email().max(255).optional(), phone: z.string().max(50).optional(), source: z.string().max(60).default('api'),
  enquiry_type: z.string().max(60).optional(), destination: z.string().max(150).optional(), travel_start: DateStr.optional(), travel_end: DateStr.optional(),
  party_size: z.number().int().min(1).max(500).optional() }).refine((l) => l.email || l.phone, 'Provide an email or a phone number');

v1Router.post('/leads', apiAuth('leads:write'), async (req, res) => {
  const t = T(req), b = parse(Lead, req.body);
  const r = await idempotent(t.agencyId, req.headers['idempotency-key'] as string | undefined, async () => {
    const id = await t.tx(async (tx) => { const id = await tx.insert('leads', { ...b, stage: 'new', created_by: null }); await emit(tx, 'lead.created', { lead_id: id, source: b.source, stage: 'new' }); return id; });
    return { status: 201, body: { id } };
  });
  res.status(r.status).json(r.body);
});

v1Router.get('/clients', apiAuth('clients:read'), async (req, res) => {
  const t = T(req), { limit, after } = page(req);
  const rows = await t.query('SELECT id, name, email, phone, currency FROM clients WHERE agency_id = ? AND id > ? ORDER BY id LIMIT ?', [t.agencyId, after, limit]);
  res.json({ data: rows, next_after_id: rows.length === limit ? rows[rows.length - 1].id : null });
});

const INV = 'id, number, client_id, status, currency, issue_date, due_date, total, amount_paid, amount_credited';
const shape = (i: any) => ({ ...i, outstanding: Math.max(0, r2(i.total - i.amount_paid - i.amount_credited)) });
v1Router.get('/invoices', apiAuth('invoices:read'), async (req, res) => {
  const t = T(req), { limit, after } = page(req), st = req.query.status ? String(req.query.status) : null;
  const rows = await t.query(`SELECT ${INV} FROM invoices WHERE agency_id = ? AND id > ? AND status NOT IN ('draft','reviewed') ${st ? 'AND status = ?' : ''} ORDER BY id LIMIT ?`, st ? [t.agencyId, after, st, limit] : [t.agencyId, after, limit]);
  res.json({ data: rows.map(shape), next_after_id: rows.length === limit ? rows[rows.length - 1].id : null });
});
v1Router.get('/invoices/:id', apiAuth('invoices:read'), async (req, res) => {
  const t = T(req), i = await t.one(`SELECT ${INV} FROM invoices WHERE agency_id = ? AND id = ? AND status NOT IN ('draft','reviewed')`, [t.agencyId, Number(req.params.id)]);
  if (!i) throw new HttpError(404, 'Invoice not found');
  res.json(shape(i));
});
