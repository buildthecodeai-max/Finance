import { Router } from 'express';
import { z } from 'zod';
import { HttpError, WRITERS, requireRole } from '../auth.js';
import { createAccount } from '../services/accounting.js';
import { idParam, parse, T } from './util.js';

export const airlinesRouter = Router();

const Airline = z.object({
  code: z.string().regex(/^\d{3}$/, 'Airline code is 3 digits'), name: z.string().min(1).transform((s) => s.toUpperCase()),
  iata_code: z.string().max(4).nullish(), commission_pct: z.number().min(0).max(100).default(0),
  wh_pct: z.number().min(0).max(100).nullish(), details: z.string().nullish(), show_flag: z.boolean().default(true),
});

airlinesRouter.get('/', async (req, res) => {
  const t = T(req);
  res.json(await t.query(`SELECT * FROM airlines WHERE agency_id = ? ${req.query.all ? '' : 'AND show_flag = 1'} ORDER BY code`, [t.agencyId]));
});

// Each airline gets its own payable account (type 211) so tickets post to a vendor ledger.
airlinesRouter.post('/', requireRole(...WRITERS), async (req, res) => {
  const b = parse(Airline, req.body); const t = T(req);
  const id = await t.tx(async (tx) => {
    const account_id = await createAccount(tx, { type_code: 211, name: b.name });
    return tx.insert('airlines', { ...b, show_flag: b.show_flag ? 1 : 0, account_id });
  });
  res.status(201).json({ id });
});

airlinesRouter.put('/:id', requireRole(...WRITERS), async (req, res) => {
  const t = T(req), id = idParam(req);
  const b = parse(Airline.partial(), req.body);
  const a = await t.get('airlines', id);
  if (!a) throw new HttpError(404, 'Not found');
  const data: Record<string, any> = { ...b }; if (b.show_flag !== undefined) data.show_flag = b.show_flag ? 1 : 0;
  await t.update('airlines', id, data);
  if (b.name && a.account_id) await t.update('accounts', a.account_id, { name: b.name });
  res.json({ ok: true });
});

airlinesRouter.delete('/:id', requireRole(...WRITERS), async (req, res) => {
  const t = T(req), id = idParam(req);
  if (await t.one('SELECT id FROM ticket_lines WHERE agency_id = ? AND airline_id = ? LIMIT 1', [t.agencyId, id]))
    throw new HttpError(409, 'Airline has tickets — untick Show instead');
  await t.remove('airlines', id); res.json({ ok: true });
});
