import { Router } from 'express';
import { z } from 'zod';
import { ALL_EDITORS, requireRole } from '../auth.js';
import { HttpError } from '../errors.js';
import { nextDocNo } from '../services/accounting.js';
import { assertCanEdit, findScoped, scope } from './scope.js';
import { idParam, parse, T } from './util.js';

export const visasRouter = Router();

const STATUSES = ['docs_pending', 'docs_received', 'submitted', 'in_process', 'approved', 'rejected', 'collected', 'cancelled'] as const;
const nul = <S extends z.ZodTypeAny>(s: S) => s.nullish();
const Visa = z.object({
  client_id: z.number().int(), booking_id: nul(z.number().int()), traveller_id: nul(z.number().int()), supplier_id: nul(z.number().int()),
  applicant_name: z.string().trim().min(1).max(200), passport_no: nul(z.string().max(30)), nationality: nul(z.string().max(60)),
  country: z.string().trim().min(1).max(80), visa_type: z.string().trim().min(1).max(40).default('tourist'), entry_type: z.enum(['single', 'multiple']).default('single'),
  status: z.enum(STATUSES).default('docs_pending'), submitted_on: nul(z.string()), expected_on: nul(z.string()), decided_on: nul(z.string()),
  visa_number: nul(z.string().max(60)), valid_from: nul(z.string()), valid_until: nul(z.string()), embassy_ref: nul(z.string().max(80)),
  currency: z.string().length(3), cost: z.number().min(0).default(0), price: z.number().min(0).default(0), notes: nul(z.string()),
});
const OWN = { owner: 'owner_id' };
const today = () => new Date().toISOString().slice(0, 10);

async function refs(t: ReturnType<typeof T>, b: Record<string, any>) {
  await t.refActive('clients', b.client_id, 'client'); await t.ref('bookings', b.booking_id, 'booking'); await t.ref('travellers', b.traveller_id, 'traveller'); await t.refActive('suppliers', b.supplier_id, 'supplier');
}
async function logEvent(t: ReturnType<typeof T>, visaId: number, status: string, note?: string | null) {
  await t.insert('visa_events', { visa_id: visaId, status, note: note ?? null, user_id: t.actor.userId });
}

visasRouter.get('/', async (req, res) => {
  const t = T(req), s = scope(req, 'v', OWN), { status, client_id } = req.query as Record<string, string>;
  res.json(await t.query(
    `SELECT v.*, c.name client_name FROM visa_applications v JOIN clients c ON c.id = v.client_id AND c.agency_id = v.agency_id
     WHERE v.agency_id = ?${s.sql} ${status ? 'AND v.status = ?' : ''} ${client_id ? 'AND v.client_id = ?' : ''} ORDER BY v.id DESC LIMIT 500`,
    [t.agencyId, ...s.params, ...(status ? [status] : []), ...(client_id ? [Number(client_id)] : [])]));
});

visasRouter.get('/:id', async (req, res) => {
  const t = T(req), id = idParam(req), v = await findScoped(t, req, 'visa_applications', id, OWN);
  const [client, supplier, events] = await Promise.all([t.get('clients', v.client_id), v.supplier_id ? t.get('suppliers', v.supplier_id) : null,
    t.query('SELECT e.*, u.name user_name FROM visa_events e LEFT JOIN users u ON u.id = e.user_id WHERE e.agency_id = ? AND e.visa_id = ? ORDER BY e.id DESC', [t.agencyId, id])]);
  res.json({ ...v, client_name: client?.name, supplier_name: supplier?.name ?? null, events });
});

visasRouter.post('/', requireRole(...ALL_EDITORS), async (req, res) => {
  const b = parse(Visa, req.body), t = T(req); await refs(t, b);
  const id = await t.tx(async (tx) => {
    const reference = await nextDocNo(tx, 'visa_applications', 'reference', 'VS');
    const vid = await tx.insert('visa_applications', { ...b, reference, owner_id: req.ctx!.userId, branch_id: req.ctx!.branchId ?? null, created_by: req.ctx!.userId });
    await logEvent(tx, vid, b.status, 'File opened');
    return vid;
  });
  res.status(201).json({ id });
});

visasRouter.put('/:id', requireRole(...ALL_EDITORS), async (req, res) => {
  const t = T(req), id = idParam(req), cur = await findScoped(t, req, 'visa_applications', id, OWN); assertCanEdit(req, cur, 'owner_id');
  const { note, ...b } = parse(Visa.partial().extend({ note: z.string().max(300).optional() }), req.body); await refs(t, b);
  if (b.status && b.status !== cur.status) {
    if (b.status === 'approved' && !(b.visa_number ?? cur.visa_number) && !(b.valid_until ?? cur.valid_until)) throw new HttpError(400, 'Enter the visa number or its validity dates before marking it approved');
    if (['approved', 'rejected'].includes(b.status) && !b.decided_on && !cur.decided_on) b.decided_on = today();
    if (b.status === 'submitted' && !b.submitted_on && !cur.submitted_on) b.submitted_on = today();
  }
  await t.tx(async (tx) => { await tx.update('visa_applications', id, b); if (b.status && b.status !== cur.status) await logEvent(tx, id, b.status, note); });
  res.json({ ok: true });
});

visasRouter.delete('/:id', requireRole(...ALL_EDITORS), async (req, res) => {
  const t = T(req), id = idParam(req), cur = await findScoped(t, req, 'visa_applications', id, OWN); assertCanEdit(req, cur, 'owner_id');
  if (!['docs_pending', 'cancelled'].includes(cur.status)) throw new HttpError(409, 'Only a file that has not been submitted can be deleted — cancel it instead to keep the history');
  await t.tx(async (tx) => { await tx.query('DELETE FROM visa_events WHERE agency_id = ? AND visa_id = ?', [tx.agencyId, id]); await tx.remove('visa_applications', id); });
  res.json({ ok: true });
});
